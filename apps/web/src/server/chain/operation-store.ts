import type { Pool, PoolClient } from 'pg';
import type { SubmissionPhase } from './config';

/*
 * PostgreSQL records for user transactions and testnet funding. Public action identity only.
 * Coordination lives in unique indexes and advisory locks, so it holds across tabs, devices and
 * processes; a process-local mutex or viem nonce manager alone would not.
 */

export const UNSIGNED_LEASE_MS = 5 * 60_000;

export interface OperationRow {
  readonly id: string;
  readonly owner: string;
  readonly kind: 'execute' | 'invalidate_nonce';
  readonly intentHash: string;
  readonly chainId: string;
  readonly registryAddress: string;
  readonly commitment: string | null;
  readonly actionDigest: string | null;
  readonly registryNonce: string;
  readonly transactionNonce: string | null;
  readonly transactionHash: string | null;
  readonly calldataHash: string | null;
  readonly quoteHash: string | null;
  readonly phase: SubmissionPhase;
  readonly leaseExpiresAt: Date | null;
  readonly blockNumber: string | null;
  readonly blockHash: string | null;
  readonly chargedFeeWei: string | null;
  readonly executedViaOther: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ReserveInput {
  readonly id: string;
  readonly owner: string;
  readonly kind: 'execute' | 'invalidate_nonce';
  readonly idempotencyKey: string;
  readonly intentHash: string;
  readonly chainId: string;
  readonly registryAddress: string;
  readonly commitment: string | null;
  readonly actionDigest: string | null;
  readonly registryNonce: string;
  readonly now: Date;
}

export type ReserveResult =
  | { readonly kind: 'reserved'; readonly operation: OperationRow }
  | { readonly kind: 'existing'; readonly operation: OperationRow }
  | { readonly kind: 'idempotency_conflict' }
  | { readonly kind: 'account_busy' };

export interface GrantRow {
  readonly id: string;
  readonly recipient: string;
  readonly chainId: string;
  readonly amountWei: string;
  readonly reservedFeeWei: string;
  readonly phase: 'reserved' | 'signed' | 'broadcast' | 'confirmed' | 'reverted' | 'unknown';
  readonly funderNonce: string | null;
  readonly transactionHash: string | null;
  readonly outboxRaw: string | null;
  readonly chargedFeeWei: string | null;
  readonly createdAt: Date;
}

export interface ReserveGrantInput {
  readonly id: string;
  readonly recipient: string;
  readonly chainId: string;
  readonly amountWei: bigint;
  readonly reservedFeeWei: bigint;
  readonly dailyBudgetWei: bigint;
  readonly cooldownMs: number;
  readonly now: Date;
}

export type ReserveGrantResult =
  | { readonly kind: 'reserved'; readonly grant: GrantRow }
  | { readonly kind: 'cooldown'; readonly retryAfter: Date }
  | { readonly kind: 'budget_exhausted' }
  | { readonly kind: 'funder_busy' };

export interface ChainStore {
  reserve(input: ReserveInput): Promise<ReserveResult>;
  recordQuote(
    id: string,
    owner: string,
    quote: { transactionNonce: string; calldataHash: string; quoteHash: string },
    now: Date,
  ): Promise<OperationRow | null>;
  /** Durably records the locally computed hash before any broadcast. Exact retries are idempotent. */
  beginSubmit(
    id: string,
    owner: string,
    input: { transactionHash: string; transactionNonce: string; calldataHash: string },
    now: Date,
  ): Promise<
    | { kind: 'recorded'; operation: OperationRow }
    | { kind: 'retry'; operation: OperationRow }
    | { kind: 'conflict' }
    | { kind: 'not_found' }
  >;
  setPhase(
    id: string,
    owner: string,
    phase: SubmissionPhase,
    detail: {
      blockNumber?: string;
      blockHash?: string;
      chargedFeeWei?: string;
      executedViaOther?: boolean;
    },
    now: Date,
  ): Promise<OperationRow | null>;
  cancelUnsigned(id: string, owner: string, now: Date): Promise<boolean>;
  get(id: string, owner: string): Promise<OperationRow | null>;
  listUnresolved(owner: string): Promise<OperationRow[]>;
  /** Highest EOA nonce held by an unresolved operation of this owner, or null. */
  highestHeldTransactionNonce(owner: string): Promise<bigint | null>;

  reserveGrant(input: ReserveGrantInput): Promise<ReserveGrantResult>;
  attachSignedGrant(
    id: string,
    input: { funderNonce: string; transactionHash: string; raw: string },
    now: Date,
  ): Promise<boolean>;
  setGrantPhase(
    id: string,
    phase: GrantRow['phase'],
    chargedFeeWei: string | null,
    now: Date,
  ): Promise<void>;
  unresolvedGrant(chainId: string): Promise<GrantRow | null>;
}

interface OpDb {
  id: string;
  owner: string;
  kind: OperationRow['kind'];
  intent_hash: string;
  chain_id: string;
  registry_address: string;
  commitment: string | null;
  action_digest: string | null;
  registry_nonce: string;
  transaction_nonce: string | null;
  transaction_hash: string | null;
  calldata_hash: string | null;
  quote_hash: string | null;
  phase: SubmissionPhase;
  lease_expires_at: Date | null;
  block_number: string | null;
  block_hash: string | null;
  charged_fee_wei: string | null;
  executed_via_other: boolean;
  created_at: Date;
  updated_at: Date;
}

const toOp = (r: OpDb): OperationRow => ({
  id: r.id,
  owner: r.owner,
  kind: r.kind,
  intentHash: r.intent_hash,
  chainId: r.chain_id,
  registryAddress: r.registry_address,
  commitment: r.commitment,
  actionDigest: r.action_digest,
  registryNonce: r.registry_nonce,
  transactionNonce: r.transaction_nonce,
  transactionHash: r.transaction_hash,
  calldataHash: r.calldata_hash,
  quoteHash: r.quote_hash,
  phase: r.phase,
  leaseExpiresAt: r.lease_expires_at,
  blockNumber: r.block_number,
  blockHash: r.block_hash,
  chargedFeeWei: r.charged_fee_wei,
  executedViaOther: r.executed_via_other,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface GrantDb {
  id: string;
  recipient: string;
  chain_id: string;
  amount_wei: string;
  reserved_fee_wei: string;
  phase: GrantRow['phase'];
  funder_nonce: string | null;
  transaction_hash: string | null;
  outbox_raw: string | null;
  charged_fee_wei: string | null;
  created_at: Date;
}
const toGrant = (r: GrantDb): GrantRow => ({
  id: r.id,
  recipient: r.recipient,
  chainId: r.chain_id,
  amountWei: r.amount_wei,
  reservedFeeWei: r.reserved_fee_wei,
  phase: r.phase,
  funderNonce: r.funder_nonce,
  transactionHash: r.transaction_hash,
  outboxRaw: r.outbox_raw,
  chargedFeeWei: r.charged_fee_wei,
  createdAt: r.created_at,
});

const UNRESOLVED_OPERATION =
  "('reserved','quoted','submitting','submitted','pending','included','unknown')";
const UNSIGNED = "('reserved','quoted')";
const UNIQUE_VIOLATION = '23505';

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
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

const isUnique = (error: unknown) => (error as { code?: string } | null)?.code === UNIQUE_VIOLATION;

export function createPostgresChainStore(pool: Pool): ChainStore {
  return {
    async reserve(input) {
      try {
        return await inTransaction(pool, async (db) => {
          await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
            `chain-op:${input.chainId}:${input.owner}`,
          ]);
          const existing = await db.query<OpDb>(
            'SELECT * FROM chain_operations WHERE owner=$1 AND kind=$2 AND idempotency_key=$3',
            [input.owner, input.kind, input.idempotencyKey],
          );
          const found = existing.rows[0];
          if (found !== undefined) {
            return found.intent_hash === input.intentHash
              ? ({ kind: 'existing', operation: toOp(found) } as const)
              : ({ kind: 'idempotency_conflict' } as const);
          }
          // An unsigned lease that has lapsed is released. A signed or uncertain one never is.
          await db.query(
            `UPDATE chain_operations SET phase='cancelled', updated_at=$3
             WHERE owner=$1 AND chain_id=$2 AND phase IN ${UNSIGNED} AND lease_expires_at < $3`,
            [input.owner, input.chainId, input.now],
          );
          const inserted = await db.query<OpDb>(
            `INSERT INTO chain_operations (id, owner, kind, idempotency_key, intent_hash, chain_id,
               registry_address, commitment, action_digest, registry_nonce, phase, lease_expires_at, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reserved',$11,$12,$12) RETURNING *`,
            [
              input.id,
              input.owner,
              input.kind,
              input.idempotencyKey,
              input.intentHash,
              input.chainId,
              input.registryAddress,
              input.commitment,
              input.actionDigest,
              input.registryNonce,
              new Date(input.now.getTime() + UNSIGNED_LEASE_MS),
              input.now,
            ],
          );
          return { kind: 'reserved', operation: toOp(inserted.rows[0] as OpDb) } as const;
        });
      } catch (error) {
        if (isUnique(error)) return { kind: 'account_busy' };
        throw error;
      }
    },

    async recordQuote(id, owner, quote, now) {
      const res = await pool.query<OpDb>(
        `UPDATE chain_operations SET phase='quoted', transaction_nonce=$3, calldata_hash=$4, quote_hash=$5,
           lease_expires_at=$6, updated_at=$7
         WHERE id=$1 AND owner=$2 AND phase IN ${UNSIGNED} AND lease_expires_at >= $7 RETURNING *`,
        [
          id,
          owner,
          quote.transactionNonce,
          quote.calldataHash,
          quote.quoteHash,
          new Date(now.getTime() + UNSIGNED_LEASE_MS),
          now,
        ],
      );
      return res.rows[0] === undefined ? null : toOp(res.rows[0]);
    },

    async beginSubmit(id, owner, input, now) {
      return inTransaction(pool, async (db) => {
        const row = (
          await db.query<OpDb>(
            'SELECT * FROM chain_operations WHERE id=$1 AND owner=$2 FOR UPDATE',
            [id, owner],
          )
        ).rows[0];
        if (row === undefined) return { kind: 'not_found' } as const;
        if (row.transaction_hash !== null) {
          // Exact retry reconciles the existing hash; different bytes are never substituted.
          return row.transaction_hash === input.transactionHash
            ? ({ kind: 'retry', operation: toOp(row) } as const)
            : ({ kind: 'conflict' } as const);
        }
        if (
          row.phase !== 'quoted' ||
          row.transaction_nonce !== input.transactionNonce ||
          row.calldata_hash !== input.calldataHash
        ) {
          return { kind: 'conflict' } as const;
        }
        const updated = await db.query<OpDb>(
          `UPDATE chain_operations SET phase='submitting', transaction_hash=$3, lease_expires_at=NULL, updated_at=$4
           WHERE id=$1 AND owner=$2 RETURNING *`,
          [id, owner, input.transactionHash, now],
        );
        return { kind: 'recorded', operation: toOp(updated.rows[0] as OpDb) } as const;
      });
    },

    async setPhase(id, owner, phase, detail, now) {
      const res = await pool.query<OpDb>(
        `UPDATE chain_operations SET phase=$3,
           block_number=COALESCE($4, block_number), block_hash=COALESCE($5, block_hash),
           charged_fee_wei=COALESCE($6, charged_fee_wei), executed_via_other=$7, updated_at=$8
         WHERE id=$1 AND owner=$2 AND phase NOT IN ('confirmed','reverted','cancelled') RETURNING *`,
        [
          id,
          owner,
          phase,
          detail.blockNumber ?? null,
          detail.blockHash ?? null,
          detail.chargedFeeWei ?? null,
          detail.executedViaOther ?? false,
          now,
        ],
      );
      return res.rows[0] === undefined ? null : toOp(res.rows[0]);
    },

    async cancelUnsigned(id, owner, now) {
      const res = await pool.query(
        `UPDATE chain_operations SET phase='cancelled', updated_at=$3 WHERE id=$1 AND owner=$2 AND phase IN ${UNSIGNED}`,
        [id, owner, now],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async get(id, owner) {
      const res = await pool.query<OpDb>(
        'SELECT * FROM chain_operations WHERE id=$1 AND owner=$2',
        [id, owner],
      );
      return res.rows[0] === undefined ? null : toOp(res.rows[0]);
    },

    async listUnresolved(owner) {
      const res = await pool.query<OpDb>(
        `SELECT * FROM chain_operations WHERE owner=$1 AND phase IN ${UNRESOLVED_OPERATION} ORDER BY created_at DESC LIMIT 20`,
        [owner],
      );
      return res.rows.map(toOp);
    },

    async highestHeldTransactionNonce(owner) {
      const res = await pool.query<{ n: string | null }>(
        `SELECT max(transaction_nonce) AS n FROM chain_operations
         WHERE owner=$1 AND phase IN ('submitting','submitted','pending','included','unknown')`,
        [owner],
      );
      const n = res.rows[0]?.n;
      return n === null || n === undefined ? null : BigInt(n);
    },

    async reserveGrant(input) {
      try {
        return await inTransaction(pool, async (db) => {
          await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
            `funding:${input.chainId}`,
          ]);
          const since = new Date(input.now.getTime() - input.cooldownMs);
          const recent = await db.query<{ created_at: Date }>(
            `SELECT created_at FROM funding_grants
             WHERE recipient=$1 AND chain_id=$2 AND created_at > $3 AND phase <> 'reverted'
             ORDER BY created_at DESC LIMIT 1`,
            [input.recipient, input.chainId, since],
          );
          if (recent.rows[0] !== undefined) {
            return {
              kind: 'cooldown',
              retryAfter: new Date(recent.rows[0].created_at.getTime() + input.cooldownMs),
            } as const;
          }
          const day = input.now.toISOString().slice(0, 10);
          const spent = await db.query<{ total: string }>(
            `SELECT COALESCE(sum((CASE WHEN phase='reverted' THEN 0 ELSE amount_wei END)
                    + COALESCE(charged_fee_wei, reserved_fee_wei)), 0)::text AS total
             FROM funding_grants WHERE chain_id=$1 AND utc_day=$2`,
            [input.chainId, day],
          );
          const total = BigInt(spent.rows[0]?.total ?? '0');
          if (total + input.amountWei + input.reservedFeeWei > input.dailyBudgetWei) {
            return { kind: 'budget_exhausted' } as const;
          }
          const inserted = await db.query<GrantDb>(
            `INSERT INTO funding_grants (id, recipient, chain_id, utc_day, amount_wei, reserved_fee_wei, phase, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,'reserved',$7,$7) RETURNING *`,
            [
              input.id,
              input.recipient,
              input.chainId,
              day,
              input.amountWei.toString(),
              input.reservedFeeWei.toString(),
              input.now,
            ],
          );
          return { kind: 'reserved', grant: toGrant(inserted.rows[0] as GrantDb) } as const;
        });
      } catch (error) {
        if (isUnique(error)) return { kind: 'funder_busy' };
        throw error;
      }
    },

    async attachSignedGrant(id, input, now) {
      const res = await pool.query(
        `UPDATE funding_grants SET phase='signed', funder_nonce=$2, transaction_hash=$3, outbox_raw=$4, updated_at=$5
         WHERE id=$1 AND phase='reserved'`,
        [id, input.funderNonce, input.transactionHash, input.raw, now],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async setGrantPhase(id, phase, chargedFeeWei, now) {
      await pool.query(
        `UPDATE funding_grants SET phase=$2, charged_fee_wei=COALESCE($3, charged_fee_wei), updated_at=$4 WHERE id=$1`,
        [id, phase, chargedFeeWei, now],
      );
    },

    async unresolvedGrant(chainId) {
      const res = await pool.query<GrantDb>(
        `SELECT * FROM funding_grants WHERE chain_id=$1 AND phase IN ('reserved','signed','broadcast','unknown') LIMIT 1`,
        [chainId],
      );
      return res.rows[0] === undefined ? null : toGrant(res.rows[0]);
    },
  };
}
