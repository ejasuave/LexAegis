/**
 * lexaegis-test-only
 * TEST SUPPORT. In-memory vault repository and object store for fast controller tests. They
 * follow the same contracts as the PostgreSQL repository and the S3 adapter (which are tested
 * against a real database and a real S3-compatible server) and are never wired into a route:
 * missing storage is NOT_CONFIGURED in production, never a process-local fallback.
 */
import { VAULT_LIMITS } from '@lexaegis/vault/v1';
import { ObjectStoreError, type ObjectStore } from '@/server/vault/object-store';
import type {
  BeginCreateOutcome,
  HeadRow,
  ObjectRow,
  VaultRepository,
  VaultRow,
} from '@/server/vault/repository';

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  /** When set, every call fails as an outage. */
  down = false;
  /** When set, the next put stores nothing and reports an uncertain outcome. */
  loseNextWrite = false;
  /** When set, the next put commits and then reports an uncertain outcome (an unacknowledged write). */
  dropNextAck = false;
  puts = 0;
  /** When set, after the put with this number is stored, an earlier stored object is silently damaged (bit rot between write and read). */
  damageEarlierAtPut: { putNumber: number; key: string } | null = null;

  putIfAbsent(key: string, bytes: Uint8Array): Promise<'created' | 'exists'> {
    if (this.down) return Promise.reject(new ObjectStoreError('UNAVAILABLE'));
    this.puts += 1;
    if (this.loseNextWrite) {
      this.loseNextWrite = false;
      return Promise.reject(new ObjectStoreError('UNCERTAIN'));
    }
    if (this.objects.has(key)) return Promise.resolve('exists');
    this.objects.set(key, bytes.slice());
    if (this.damageEarlierAtPut?.putNumber === this.puts) {
      const victim = this.objects.get(this.damageEarlierAtPut.key);
      if (victim !== undefined) victim[victim.length - 20] = (victim[victim.length - 20] ?? 0) ^ 1;
    }
    if (this.dropNextAck) {
      this.dropNextAck = false;
      return Promise.reject(new ObjectStoreError('UNCERTAIN'));
    }
    return Promise.resolve('created');
  }

  get(key: string): Promise<Uint8Array | null> {
    if (this.down) return Promise.reject(new ObjectStoreError('UNAVAILABLE'));
    return Promise.resolve(this.objects.get(key)?.slice() ?? null);
  }
}

interface MemObject extends ObjectRow {
  readonly vaultId: string;
}

export class MemoryVaultRepository implements VaultRepository {
  readonly vaults = new Map<
    string,
    VaultRow & { state: 'creating' | 'ready'; objectCount: number; byteCount: number }
  >();
  readonly objects = new Map<string, MemObject>();
  readonly heads = new Map<string, { revision: bigint; catalogObjectId: string }>();

  findReady(ownerAddress: string, rpId: string, accountProfileId: string) {
    const found = [...this.vaults.values()].find(
      (v) =>
        v.ownerAddress === ownerAddress &&
        v.rpId === rpId &&
        v.accountProfileId === accountProfileId &&
        v.state === 'ready',
    );
    return Promise.resolve(found ?? null);
  }

  getOwned(vaultId: string, ownerAddress: string) {
    const found = this.vaults.get(vaultId);
    return Promise.resolve(
      found !== undefined && found.ownerAddress === ownerAddress && found.state === 'ready'
        ? found
        : null,
    );
  }

  beginCreate(
    vault: VaultRow & { now: Date },
    catalog: { objectId: string; sha256: string; byteLength: number },
  ): Promise<BeginCreateOutcome> {
    const owned = [...this.vaults.values()].find(
      (v) =>
        v.ownerAddress === vault.ownerAddress &&
        v.rpId === vault.rpId &&
        v.accountProfileId === vault.accountProfileId,
    );
    if (owned === undefined && this.vaults.has(vault.vaultId))
      return Promise.resolve({ kind: 'conflict' });
    if (owned !== undefined && (owned.state === 'ready' || owned.vaultId !== vault.vaultId)) {
      return Promise.resolve({ kind: 'exists', vaultId: owned.vaultId });
    }
    const resumed = owned !== undefined;
    if (!resumed) {
      this.vaults.set(vault.vaultId, { ...vault, state: 'creating', objectCount: 0, byteCount: 0 });
    }
    void this.reserveObject(vault.vaultId, catalog);
    return Promise.resolve({ kind: resumed ? 'resumed' : 'created' });
  }

  completeCreate(vaultId: string, catalogObjectId: string): Promise<void> {
    const vault = this.vaults.get(vaultId);
    const object = this.objects.get(`${vaultId}/${catalogObjectId}`);
    if (vault !== undefined && object !== undefined) {
      this.objects.set(`${vaultId}/${catalogObjectId}`, { ...object, state: 'ready' });
      if (!this.heads.has(vaultId)) this.heads.set(vaultId, { revision: 0n, catalogObjectId });
      vault.state = 'ready';
    }
    return Promise.resolve();
  }

  reserveObject(vaultId: string, object: { objectId: string; sha256: string; byteLength: number }) {
    const key = `${vaultId}/${object.objectId}`;
    const existing = this.objects.get(key);
    if (existing !== undefined) {
      return Promise.resolve(
        existing.sha256 === object.sha256 && Number(existing.byteLength) === object.byteLength
          ? ('same' as const)
          : ('conflict' as const),
      );
    }
    const vault = this.vaults.get(vaultId);
    if (vault === undefined) return Promise.resolve('conflict' as const);
    if (
      vault.objectCount >= VAULT_LIMITS.maxObjects ||
      vault.byteCount + object.byteLength > VAULT_LIMITS.maxStoredBytes
    ) {
      return Promise.resolve('quota' as const);
    }
    vault.objectCount += 1;
    vault.byteCount += object.byteLength;
    this.objects.set(key, {
      vaultId,
      objectId: object.objectId,
      sha256: object.sha256,
      byteLength: String(object.byteLength),
      state: 'reserved',
    });
    return Promise.resolve('reserved' as const);
  }

  markReady(vaultId: string, objectId: string): Promise<void> {
    const object = this.objects.get(`${vaultId}/${objectId}`);
    if (object !== undefined && object.state === 'reserved')
      this.objects.set(`${vaultId}/${objectId}`, { ...object, state: 'ready' });
    return Promise.resolve();
  }

  getObject(vaultId: string, objectId: string) {
    return Promise.resolve(this.objects.get(`${vaultId}/${objectId}`) ?? null);
  }

  getHead(vaultId: string): Promise<HeadRow | null> {
    const head = this.heads.get(vaultId);
    const catalog =
      head === undefined ? undefined : this.objects.get(`${vaultId}/${head.catalogObjectId}`);
    return Promise.resolve(
      head === undefined || catalog === undefined
        ? null
        : {
            revision: head.revision.toString(),
            catalog: {
              objectId: catalog.objectId,
              sha256: catalog.sha256,
              byteLength: catalog.byteLength,
            },
          },
    );
  }

  swapHead(vaultId: string, expectedRevision: string, catalogObjectId: string) {
    const head = this.heads.get(vaultId);
    if (head === undefined) return Promise.resolve('conflict' as const);
    const ready = this.objects.get(`${vaultId}/${catalogObjectId}`)?.state === 'ready';
    if (head.revision === BigInt(expectedRevision) && ready) {
      this.heads.set(vaultId, { revision: head.revision + 1n, catalogObjectId });
      return Promise.resolve('ok' as const);
    }
    if (
      head.revision === BigInt(expectedRevision) + 1n &&
      head.catalogObjectId === catalogObjectId
    ) {
      return Promise.resolve('already_applied' as const);
    }
    return Promise.resolve(
      head.revision === BigInt(expectedRevision) && !ready
        ? ('not_ready' as const)
        : ('conflict' as const),
    );
  }
}
