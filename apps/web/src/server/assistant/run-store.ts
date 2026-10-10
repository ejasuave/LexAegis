import type { Pool, PoolClient } from 'pg';
import {
  LEASE_MS,
  QUOTA_RETENTION_DAYS,
  TERMINAL_RETENTION_MS,
  capabilityRecordSchema,
  terminalFor,
  utcDay,
  type RunCounters,
  type RunRow,
  type RunStore,
} from '@lexaegis/agent/run-store';
import type { AssistantRunState, RunOutcome } from '@lexaegis/agent/contracts';

/*
 * PostgreSQL run store. Admission, quotas and terminal transitions are decided by the database,
 * so they hold across replicas and restarts. Active plaintext and AbortControllers live only in
 * the worker process; nothing here can resume or replay a run. Not marked server-only so the
 * database tests and the smoke script can load it; ESLint keeps it out of browser folders.
 */

interface RunDb {
  id: string;
  owner: string;
  client_request_id: string;
  state: AssistantRunState;
  outcome: RunOutcome | null;
  cancel_requested: boolean;
  lease_token: string;
  lease_expires_at: Date;
  deadline_at: Date;
  provider_attempts: number;
  tool_executions: number;
  reserved_input_tokens: number;
  reserved_output_tokens: number;
  reported_input_tokens: number | null;
  reported_output_tokens: number | null;
  usage_provenance: RunCounters['usageProvenance'];
  created_at: Date;
  updated_at: Date;
}

const toRow = (db: RunDb): RunRow => ({
  runId: db.id,
  owner: db.owner,
  clientRequestId: db.client_request_id,
  state: db.state,
  outcome: db.outcome,
  cancelRequested: db.cancel_requested,
  leaseToken: db.lease_token,
  leaseExpiresAt: db.lease_expires_at,
  deadlineAt: db.deadline_at,
  providerAttempts: db.provider_attempts,
  toolExecutions: db.tool_executions,
  reservedInputTokens: db.reserved_input_tokens,
  reservedOutputTokens: db.reserved_output_tokens,
  reportedInputTokens: db.reported_input_tokens,
  reportedOutputTokens: db.reported_output_tokens,
  usageProvenance: db.usage_provenance,
  createdAt: db.created_at,
  updatedAt: db.updated_at,
});

const ACTIVE = `('queued','running','stopping')`;
const COUNTER_SET = `provider_attempts=$3, tool_executions=$4, reserved_input_tokens=$5,
  reserved_output_tokens=$6, reported_input_tokens=$7, reported_output_tokens=$8, usage_provenance=$9`;
const counterValues = (c: RunCounters) => [
  c.providerAttempts,
  c.toolExecutions,
  c.reservedInputTokens,
  c.reservedOutputTokens,
  c.reportedInputTokens,
  c.reportedOutputTokens,
  c.usageProvenance,
];

async function inTransaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await work(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

async function sweepWith(db: Queryable, now: Date) {
  const interrupted = await db.query(
    `UPDATE assistant_runs SET state='interrupted', outcome='interrupted', updated_at=$1
     WHERE state IN ${ACTIVE} AND lease_expires_at < $1`,
    [now],
  );
  const removed = await db.query(
    `DELETE FROM assistant_runs WHERE state NOT IN ${ACTIVE} AND updated_at < $1`,
    [new Date(now.getTime() - TERMINAL_RETENTION_MS)],
  );
  await db.query('DELETE FROM assistant_quota WHERE utc_day < $1::date', [
    utcDay(new Date(now.getTime() - QUOTA_RETENTION_DAYS * 86_400_000)),
  ]);
  return { interrupted: interrupted.rowCount ?? 0, removed: removed.rowCount ?? 0 };
}

export function createPostgresRunStore(pool: Pool): RunStore {
  const count = async (db: Queryable, sql: string, values: unknown[]): Promise<number> =>
    Number((await db.query<{ n: string }>(sql, values)).rows[0]?.n ?? '0');

  return {
    admit(input) {
      return inTransaction(pool, async (db) => {
        // One admission at a time across every replica: limits and quotas are read and written together.
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          'lexaegis.assistant.admission',
        ]);
        await sweepWith(db, input.now);
        const existing = (
          await db.query<RunDb>(
            'SELECT * FROM assistant_runs WHERE owner=$1 AND client_request_id=$2',
            [input.owner, input.clientRequestId],
          )
        ).rows[0];
        if (existing !== undefined) return { kind: 'duplicate', row: toRow(existing) } as const;

        const { limits } = input;
        const day = utcDay(input.now);
        const ownerScope = `owner:${input.owner}`;
        if (
          (await count(
            db,
            `SELECT count(*) AS n FROM assistant_runs WHERE owner=$1 AND state IN ${ACTIVE}`,
            [input.owner],
          )) >= limits.activePerOwner
        )
          return { kind: 'denied', reason: 'OWNER_ACTIVE' } as const;
        if (
          (await count(
            db,
            `SELECT count(*) AS n FROM assistant_runs WHERE state IN ${ACTIVE}`,
            [],
          )) >= limits.activeGlobal
        )
          return { kind: 'denied', reason: 'GLOBAL_ACTIVE' } as const;
        const admittedFor = (scope: string) =>
          count(
            db,
            'SELECT coalesce(sum(admitted),0) AS n FROM assistant_quota WHERE scope=$1 AND utc_day=$2::date',
            [scope, day],
          );
        if ((await admittedFor(ownerScope)) >= limits.dailyPerOwner)
          return { kind: 'denied', reason: 'OWNER_DAILY' } as const;
        if ((await admittedFor('global')) >= limits.dailyGlobal)
          return { kind: 'denied', reason: 'GLOBAL_DAILY' } as const;

        for (const scope of [ownerScope, 'global']) {
          await db.query(
            `INSERT INTO assistant_quota (scope, utc_day, admitted) VALUES ($1, $2::date, 1)
             ON CONFLICT (scope, utc_day) DO UPDATE SET admitted = assistant_quota.admitted + 1`,
            [scope, day],
          );
        }
        const inserted = await db.query<RunDb>(
          `INSERT INTO assistant_runs (id, owner, client_request_id, state, lease_token, lease_expires_at,
             deadline_at, created_at, updated_at)
           VALUES ($1,$2,$3,'queued',$4,$5,$6,$7,$7) RETURNING *`,
          [
            input.runId,
            input.owner,
            input.clientRequestId,
            input.leaseToken,
            new Date(input.now.getTime() + LEASE_MS),
            input.deadlineAt,
            input.now,
          ],
        );
        return { kind: 'admitted', row: toRow(inserted.rows[0] as RunDb) } as const;
      });
    },

    async get(runId, owner) {
      const row = (
        await pool.query<RunDb>('SELECT * FROM assistant_runs WHERE id=$1 AND owner=$2', [
          runId,
          owner,
        ])
      ).rows[0];
      return row === undefined ? null : toRow(row);
    },

    async begin(runId, leaseToken, now) {
      const res = await pool.query(
        `UPDATE assistant_runs SET state='running', updated_at=$3, lease_expires_at=$4
         WHERE id=$1 AND lease_token=$2 AND state='queued'`,
        [runId, leaseToken, now, new Date(now.getTime() + LEASE_MS)],
      );
      return (res.rowCount ?? 0) === 1;
    },

    async heartbeat(runId, leaseToken, now, counters) {
      const res = await pool.query<{ cancel_requested: boolean }>(
        `UPDATE assistant_runs SET ${COUNTER_SET}, updated_at=$10, lease_expires_at=$11
         WHERE id=$1 AND lease_token=$2 AND state IN ${ACTIVE} RETURNING cancel_requested`,
        [runId, leaseToken, ...counterValues(counters), now, new Date(now.getTime() + LEASE_MS)],
      );
      const row = res.rows[0];
      if (row !== undefined) return { owned: true, cancelRequested: row.cancel_requested };
      const current = await pool.query<{ cancel_requested: boolean }>(
        'SELECT cancel_requested FROM assistant_runs WHERE id=$1',
        [runId],
      );
      return { owned: false, cancelRequested: current.rows[0]?.cancel_requested ?? false };
    },

    async requestCancel(runId, owner, now) {
      const updated = await pool.query<RunDb>(
        `UPDATE assistant_runs SET cancel_requested=true, state='stopping', updated_at=$3
         WHERE id=$1 AND owner=$2 AND state IN ${ACTIVE} RETURNING *`,
        [runId, owner, now],
      );
      if (updated.rows[0] !== undefined) return toRow(updated.rows[0]);
      const current = await pool.query<RunDb>(
        'SELECT * FROM assistant_runs WHERE id=$1 AND owner=$2',
        [runId, owner],
      );
      return current.rows[0] === undefined ? null : toRow(current.rows[0]);
    },

    finish(runId, leaseToken, desired, counters, now) {
      return inTransaction(pool, async (db) => {
        const row = (
          await db.query<RunDb>(
            `SELECT * FROM assistant_runs WHERE id=$1 AND lease_token=$2 AND state IN ${ACTIVE} FOR UPDATE`,
            [runId, leaseToken],
          )
        ).rows[0];
        if (row === undefined) return null;
        // Decided under the row lock: a cancel and a completion can never both take effect.
        const terminal = terminalFor({ cancelRequested: row.cancel_requested }, desired);
        const updated = await db.query<RunDb>(
          `UPDATE assistant_runs SET ${COUNTER_SET}, state=$10, outcome=$11, updated_at=$12
           WHERE id=$1 AND lease_token=$2 RETURNING *`,
          [runId, leaseToken, ...counterValues(counters), terminal.state, terminal.outcome, now],
        );
        return toRow(updated.rows[0] as RunDb);
      });
    },

    sweep: (now) => sweepWith(pool, now),

    async capability(fingerprint) {
      const row = (
        await pool.query<{ record: unknown }>(
          'SELECT record FROM assistant_capability_checks WHERE fingerprint=$1',
          [fingerprint],
        )
      ).rows[0];
      const parsed = capabilityRecordSchema.safeParse(row?.record);
      return parsed.success ? parsed.data : null;
    },

    async saveCapability(record) {
      await pool.query(
        `INSERT INTO assistant_capability_checks (fingerprint, record, verified, checked_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (fingerprint) DO UPDATE SET record=$2, verified=$3, checked_at=$4`,
        [record.fingerprint, JSON.stringify(record), record.verified, record.checkedAt],
      );
    },
  };
}
