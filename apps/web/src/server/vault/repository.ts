import type { Pool, PoolClient } from 'pg';
import { VAULT_LIMITS } from '@lexaegis/vault/v1';

/*
 * PostgreSQL persistence for the vault: descriptors, head pointers and object metadata.
 * No transaction is ever held open across a network upload.
 */

export interface VaultRow {
  readonly vaultId: string;
  readonly ownerAddress: string;
  readonly rpId: string;
  readonly accountProfileId: string;
}

export interface ObjectRow {
  readonly objectId: string;
  readonly sha256: string;
  readonly byteLength: string;
  readonly state: 'reserved' | 'ready';
}

export interface HeadRow {
  readonly revision: string;
  readonly catalog: {
    readonly objectId: string;
    readonly sha256: string;
    readonly byteLength: string;
  };
}

export interface ObjectInput {
  readonly objectId: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export type ReserveOutcome = 'reserved' | 'same' | 'conflict' | 'quota';
export type SwapOutcome = 'ok' | 'already_applied' | 'conflict' | 'not_ready';
export type BeginCreateOutcome =
  | { readonly kind: 'created' | 'resumed' }
  | { readonly kind: 'exists'; readonly vaultId: string }
  | { readonly kind: 'conflict' };

export interface VaultRepository {
  /** A fully initialised vault for this account tuple, or null. A half-created vault is not returned. */
  findReady(ownerAddress: string, rpId: string, accountProfileId: string): Promise<VaultRow | null>;
  /** The vault by ID only if this account owns it and it is fully initialised. Otherwise null, uniformly. */
  getOwned(vaultId: string, ownerAddress: string): Promise<VaultRow | null>;
  beginCreate(vault: VaultRow & { now: Date }, catalog: ObjectInput): Promise<BeginCreateOutcome>;
  completeCreate(vaultId: string, catalogObjectId: string, now: Date): Promise<void>;
  reserveObject(vaultId: string, object: ObjectInput, now: Date): Promise<ReserveOutcome>;
  markReady(vaultId: string, objectId: string, now: Date): Promise<void>;
  getObject(vaultId: string, objectId: string): Promise<ObjectRow | null>;
  getHead(vaultId: string): Promise<HeadRow | null>;
  swapHead(
    vaultId: string,
    expectedRevision: string,
    catalogObjectId: string,
    now: Date,
  ): Promise<SwapOutcome>;
}

interface VaultDbRow {
  vault_id: string;
  owner_address: string;
  rp_id: string;
  account_profile_id: string;
  state: string;
}
const toVault = (row: VaultDbRow): VaultRow => ({
  vaultId: row.vault_id,
  ownerAddress: row.owner_address,
  rpId: row.rp_id,
  accountProfileId: row.account_profile_id,
});

interface ObjectDbRow {
  object_id: string;
  sha256: string;
  byte_length: string;
  state: 'reserved' | 'ready';
}
const toObject = (row: ObjectDbRow): ObjectRow => ({
  objectId: row.object_id,
  sha256: row.sha256,
  byteLength: row.byte_length,
  state: row.state,
});

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Inserts the object row and charges the vault's quota, atomically. 'quota' rolls the insert back. */
async function reserveIn(
  client: PoolClient,
  vaultId: string,
  object: ObjectInput,
  now: Date,
): Promise<ReserveOutcome> {
  const inserted = await client.query(
    `INSERT INTO vault_objects (vault_id, object_id, byte_length, sha256, state, created_at)
     VALUES ($1,$2,$3,$4,'reserved',$5) ON CONFLICT DO NOTHING`,
    [vaultId, object.objectId, object.byteLength, object.sha256, now],
  );
  if (inserted.rowCount === 0) {
    const existing = await client.query<ObjectDbRow>(
      'SELECT object_id, sha256, byte_length, state FROM vault_objects WHERE vault_id = $1 AND object_id = $2',
      [vaultId, object.objectId],
    );
    const row = existing.rows[0];
    return row !== undefined &&
      row.sha256 === object.sha256 &&
      Number(row.byte_length) === object.byteLength
      ? 'same'
      : 'conflict';
  }
  const charged = await client.query(
    `UPDATE vaults SET object_count = object_count + 1, byte_count = byte_count + $2
       WHERE vault_id = $1 AND object_count < $3 AND byte_count + $2 <= $4`,
    [vaultId, object.byteLength, VAULT_LIMITS.maxObjects, VAULT_LIMITS.maxStoredBytes],
  );
  if (charged.rowCount === 0) {
    await client.query('DELETE FROM vault_objects WHERE vault_id = $1 AND object_id = $2', [
      vaultId,
      object.objectId,
    ]);
    return 'quota';
  }
  return 'reserved';
}

export function createPostgresVaultRepository(pool: Pool): VaultRepository {
  return {
    async findReady(ownerAddress, rpId, accountProfileId) {
      const { rows } = await pool.query<VaultDbRow>(
        `SELECT vault_id, owner_address, rp_id, account_profile_id, state FROM vaults
           WHERE owner_address = $1 AND rp_id = $2 AND account_profile_id = $3 AND state = 'ready'`,
        [ownerAddress, rpId, accountProfileId],
      );
      return rows[0] === undefined ? null : toVault(rows[0]);
    },

    async getOwned(vaultId, ownerAddress) {
      const { rows } = await pool.query<VaultDbRow>(
        `SELECT vault_id, owner_address, rp_id, account_profile_id, state FROM vaults
           WHERE vault_id = $1 AND owner_address = $2 AND state = 'ready'`,
        [vaultId, ownerAddress],
      );
      return rows[0] === undefined ? null : toVault(rows[0]);
    },

    beginCreate(vault, catalog) {
      return inTransaction(pool, async (client): Promise<BeginCreateOutcome> => {
        const inserted = await client.query(
          `INSERT INTO vaults (vault_id, owner_address, rp_id, account_profile_id, state, created_at)
           VALUES ($1,$2,$3,$4,'creating',$5) ON CONFLICT DO NOTHING`,
          [vault.vaultId, vault.ownerAddress, vault.rpId, vault.accountProfileId, vault.now],
        );
        if (inserted.rowCount === 1) {
          const outcome = await reserveIn(client, vault.vaultId, catalog, vault.now);
          return outcome === 'reserved' ? { kind: 'created' } : { kind: 'conflict' };
        }
        // Lost a race, or retrying an interrupted creation of this very vault.
        const existing = await client.query<VaultDbRow>(
          `SELECT vault_id, owner_address, rp_id, account_profile_id, state FROM vaults
             WHERE owner_address = $1 AND rp_id = $2 AND account_profile_id = $3`,
          [vault.ownerAddress, vault.rpId, vault.accountProfileId],
        );
        const row = existing.rows[0];
        if (row === undefined) return { kind: 'conflict' }; // that vault ID belongs to someone else
        if (row.state === 'ready' || row.vault_id !== vault.vaultId)
          return { kind: 'exists', vaultId: row.vault_id };
        const outcome = await reserveIn(client, vault.vaultId, catalog, vault.now);
        return outcome === 'same' || outcome === 'reserved'
          ? { kind: 'resumed' }
          : { kind: 'conflict' };
      });
    },

    async completeCreate(vaultId, catalogObjectId, now) {
      await inTransaction(pool, async (client) => {
        await client.query(
          `UPDATE vault_objects SET state = 'ready', ready_at = $3 WHERE vault_id = $1 AND object_id = $2 AND state = 'reserved'`,
          [vaultId, catalogObjectId, now],
        );
        await client.query(
          `INSERT INTO vault_heads (vault_id, revision, catalog_object_id, updated_at) VALUES ($1, 0, $2, $3) ON CONFLICT DO NOTHING`,
          [vaultId, catalogObjectId, now],
        );
        await client.query(
          `UPDATE vaults SET state = 'ready' WHERE vault_id = $1 AND state = 'creating'`,
          [vaultId],
        );
      });
    },

    reserveObject(vaultId, object, now) {
      return inTransaction(pool, (client) => reserveIn(client, vaultId, object, now));
    },

    async markReady(vaultId, objectId, now) {
      await pool.query(
        `UPDATE vault_objects SET state = 'ready', ready_at = $3 WHERE vault_id = $1 AND object_id = $2 AND state = 'reserved'`,
        [vaultId, objectId, now],
      );
    },

    async getObject(vaultId, objectId) {
      const { rows } = await pool.query<ObjectDbRow>(
        'SELECT object_id, sha256, byte_length, state FROM vault_objects WHERE vault_id = $1 AND object_id = $2',
        [vaultId, objectId],
      );
      return rows[0] === undefined ? null : toObject(rows[0]);
    },

    async getHead(vaultId) {
      const { rows } = await pool.query<{
        revision: string;
        object_id: string;
        sha256: string;
        byte_length: string;
      }>(
        `SELECT h.revision::text AS revision, o.object_id, o.sha256, o.byte_length
           FROM vault_heads h JOIN vault_objects o ON o.vault_id = h.vault_id AND o.object_id = h.catalog_object_id
          WHERE h.vault_id = $1`,
        [vaultId],
      );
      const row = rows[0];
      return row === undefined
        ? null
        : {
            revision: row.revision,
            catalog: { objectId: row.object_id, sha256: row.sha256, byteLength: row.byte_length },
          };
    },

    async swapHead(vaultId, expectedRevision, catalogObjectId, now) {
      // The WHERE clause is the compare-and-swap: it matches only the expected revision.
      const swapped = await pool.query(
        `UPDATE vault_heads h SET revision = h.revision + 1, catalog_object_id = $3, updated_at = $4
          WHERE h.vault_id = $1 AND h.revision = $2::numeric
            AND EXISTS (SELECT 1 FROM vault_objects o WHERE o.vault_id = h.vault_id AND o.object_id = $3 AND o.state = 'ready')`,
        [vaultId, expectedRevision, catalogObjectId, now],
      );
      if (swapped.rowCount === 1) return 'ok';
      const { rows } = await pool.query<{
        revision: string;
        catalog_object_id: string;
        ready: boolean;
      }>(
        `SELECT h.revision::text AS revision, h.catalog_object_id,
                EXISTS (SELECT 1 FROM vault_objects o WHERE o.vault_id = h.vault_id AND o.object_id = $2 AND o.state = 'ready') AS ready
           FROM vault_heads h WHERE h.vault_id = $1`,
        [vaultId, catalogObjectId],
      );
      const head = rows[0];
      if (head === undefined) return 'conflict';
      // An identical update that already took effect is reported as success, not a conflict.
      if (
        BigInt(head.revision) === BigInt(expectedRevision) + 1n &&
        head.catalog_object_id === catalogObjectId
      ) {
        return 'already_applied';
      }
      return BigInt(head.revision) === BigInt(expectedRevision) && !head.ready
        ? 'not_ready'
        : 'conflict';
    },
  };
}
