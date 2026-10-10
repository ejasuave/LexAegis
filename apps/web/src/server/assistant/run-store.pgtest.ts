import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ADMISSION } from '@lexaegis/agent/run-store';
import { describeRunStore } from '@lexaegis/agent/testing/run-store-contract';
import { startLocalPostgres, type LocalPostgres } from '../../../../../test-support/embedded-pg';
import { migrate } from '../db/migrate';
import { createPostgresRunStore } from './run-store';

/* Real PostgreSQL: admission, quotas, cancellation and terminal states are decided by the database. */

let postgres: LocalPostgres | null = null;
let pool: Pool;
let second: Pool;

beforeAll(async () => {
  const supplied = process.env.TEST_DATABASE_URL;
  if (supplied === undefined || supplied === '') postgres = await startLocalPostgres();
  const connectionString = supplied || postgres?.url;
  pool = new Pool({ connectionString, max: 30 });
  second = new Pool({ connectionString, max: 10 });
  for (const p of [pool, second]) {
    p.on('connect', (client) => client.on('error', () => undefined));
    p.on('error', () => undefined);
  }
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
  await second.end();
  await postgres?.stop();
});

const truncate = () =>
  pool.query('TRUNCATE assistant_runs, assistant_quota, assistant_capability_checks');
beforeEach(truncate);

describeRunStore('PostgreSQL', async () => {
  await truncate();
  return createPostgresRunStore(pool);
});

describe('assistant run storage across replicas', () => {
  const T0 = new Date('2026-10-10T12:00:00.000Z');
  const OWNER = `0x${'aa'.repeat(20)}`;
  let serial = 1000;
  const uuid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
  const admission = (owner = OWNER) => ({
    runId: uuid(),
    owner,
    clientRequestId: uuid(),
    leaseToken: uuid(),
    now: T0,
    deadlineAt: new Date(T0.getTime() + 120_000),
    limits: DEFAULT_ADMISSION,
  });

  it('a cancellation requested on one replica is seen by the worker on another', async () => {
    const worker = createPostgresRunStore(pool);
    const other = createPostgresRunStore(second);
    const run = admission();
    await worker.admit(run);
    await worker.begin(run.runId, run.leaseToken, T0);
    expect(await other.requestCancel(run.runId, OWNER, new Date(T0.getTime() + 300))).toMatchObject(
      {
        state: 'stopping',
      },
    );
    const beat = await worker.heartbeat(run.runId, run.leaseToken, new Date(T0.getTime() + 400), {
      providerAttempts: 1,
      toolExecutions: 0,
      reservedInputTokens: 5000,
      reservedOutputTokens: 512,
      reportedInputTokens: null,
      reportedOutputTokens: null,
      usageProvenance: 'unknown',
    });
    expect(beat).toEqual({ owned: true, cancelRequested: true });
  });

  it('reserves the global active and daily limits transactionally across replicas', async () => {
    const stores = [createPostgresRunStore(pool), createPostgresRunStore(second)];
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (stores[i % 2] as (typeof stores)[number]).admit(
          admission(`0x${String(i).padStart(40, '0')}`),
        ),
      ),
    );
    expect(results.filter((r) => r.kind === 'admitted')).toHaveLength(3);
    expect(results.filter((r) => r.kind === 'denied' && r.reason === 'GLOBAL_ACTIVE')).toHaveLength(
      7,
    );
    const quota = await pool.query<{ admitted: number }>(
      "SELECT admitted FROM assistant_quota WHERE scope='global'",
    );
    expect(quota.rows[0]?.admitted).toBe(3);
  });

  it('exactly one terminal state results from a simultaneous completion and cancellation', async () => {
    for (let round = 0; round < 8; round += 1) {
      await truncate();
      const worker = createPostgresRunStore(pool);
      const other = createPostgresRunStore(second);
      const run = admission();
      await worker.admit(run);
      await worker.begin(run.runId, run.leaseToken, T0);
      const later = new Date(T0.getTime() + 500);
      const counters = {
        providerAttempts: 2,
        toolExecutions: 1,
        reservedInputTokens: 9000,
        reservedOutputTokens: 2560,
        reportedInputTokens: 600,
        reportedOutputTokens: 80,
        usageProvenance: 'provider_reported' as const,
      };
      const [finished, cancelled] = await Promise.all([
        worker.finish(
          run.runId,
          run.leaseToken,
          { state: 'completed', outcome: 'completed' },
          counters,
          later,
        ),
        other.requestCancel(run.runId, OWNER, later),
      ]);
      const final = await worker.get(run.runId, OWNER);
      expect(['completed', 'cancelled']).toContain(final?.state);
      expect(finished?.state).toBe(final?.state);
      // The cancel request reports whichever single terminal state the database holds, or stopping
      // only if it won the race and the worker then acknowledged it.
      expect(['stopping', final?.state]).toContain(cancelled?.state);
      expect(
        await worker.finish(
          run.runId,
          run.leaseToken,
          { state: 'failed', outcome: 'failed' },
          counters,
          later,
        ),
      ).toBeNull();
    }
  });

  it('stores only opaque identifiers, the owner, state and counters', async () => {
    const store = createPostgresRunStore(pool);
    const run = admission();
    await store.admit(run);
    const columns = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name IN ('assistant_runs','assistant_quota') ORDER BY 1",
    );
    const names = columns.rows.map((row) => row.column_name);
    for (const forbidden of [
      'matter',
      'document',
      'title',
      'digest',
      'hash',
      'prompt',
      'answer',
      'payload',
      'context',
      'utterance',
      'snapshot',
    ]) {
      expect(names.some((name) => name.includes(forbidden))).toBe(false);
    }
    const dump = JSON.stringify((await pool.query('SELECT * FROM assistant_runs')).rows);
    expect(dump).toContain(run.runId);
    expect(dump).not.toMatch(/0x[0-9a-f]{64}/);
  });
});
