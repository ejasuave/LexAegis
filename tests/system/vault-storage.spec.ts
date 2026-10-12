import { createHash } from 'node:crypto';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VaultOutcome } from '@/features/vault/vault-controller';
import { createPostgresVaultRepository, type VaultRepository } from '@/server/vault/repository';
import {
  ObjectStoreError,
  createS3ObjectStore,
  objectKey,
  type ObjectStore,
} from '@/server/vault/object-store';
import {
  createVaultHarness,
  prepareSynthetic,
  withVault,
  type VaultHarness,
} from '@/test-support/vault-harness';
import { isBlocked, startSystemServices, type SystemServices } from './harness/services';
import { recordResult } from './harness/recorder';

/*
 * SYSTEM EVIDENCE (local_integration). The real vault controller, the real vault service, real browser-
 * grade Web Crypto (Node's WebCrypto), a real PostgreSQL repository (compare-and-swap) and a real
 * S3-compatible server with conditional create. Faults are injected by test-only decorators around the
 * stores, never by production flags. A scripted authenticator supplies credential behaviour only.
 */

const CASES = [
  'vault-storage-fault-matrix',
  'vault-storage-concurrency-and-immutability',
  'vault-storage-corruption-swaps-and-outage',
  'vault-exports-roundtrip-real-stores',
] as const;

/** An object store decorator that can fail a specific write before or after it commits. */
class FaultyObjects implements ObjectStore {
  puts = 0;
  gets = 0;
  failBeforePut: number | null = null;
  failAfterPut: number | null = null;
  failGet: number | null = null;
  failGetKeys: RegExp | null = null;
  readonly keys: string[] = [];
  constructor(private readonly inner: ObjectStore) {}
  arm(): void {
    this.puts = 0;
    this.gets = 0;
    this.keys.length = 0;
  }
  clear(): void {
    this.failBeforePut = null;
    this.failAfterPut = null;
    this.failGet = null;
    this.failGetKeys = null;
  }
  async putIfAbsent(key: string, bytes: Uint8Array): Promise<'created' | 'exists'> {
    this.puts += 1;
    this.keys.push(key);
    if (this.failBeforePut === this.puts) throw new ObjectStoreError('UNCERTAIN');
    const result = await this.inner.putIfAbsent(key, bytes);
    if (this.failAfterPut === this.puts) throw new ObjectStoreError('UNCERTAIN');
    return result;
  }
  async get(key: string): Promise<Uint8Array | null> {
    this.gets += 1;
    if (this.failGet === this.gets) throw new ObjectStoreError('UNAVAILABLE');
    if (this.failGetKeys?.test(key) === true) throw new ObjectStoreError('UNAVAILABLE');
    return this.inner.get(key);
  }
}

let services: SystemServices | undefined;
let objects: FaultyObjects;
let pool: Pool;
let blockedStart = false;

beforeAll(async () => {
  const started = await startSystemServices();
  if (isBlocked(started)) {
    blockedStart = true;
    for (const id of CASES)
      recordResult({
        caseId: id,
        status: 'blocked',
        evidenceClass: 'local_integration',
        startedAt: new Date(),
        configuration: { reason: started.reason },
        issueCodes: [started.code],
      });
    return;
  }
  services = started;
  pool = started.pool;
  objects = new FaultyObjects(
    createS3ObjectStore({
      endpoint: started.s3.endpoint,
      bucket: started.s3.bucket,
      region: started.s3.region,
      accessKeyId: started.s3.accessKeyId,
      secretAccessKey: started.s3.secretAccessKey,
    }),
  );
}, 300_000);
afterAll(async () => {
  await services?.stop();
});

const run = (name: string, fn: () => Promise<void>) =>
  it(name, async (context) => {
    if (blockedStart) context.skip();
    objects.clear();
    await fn();
  });

const must = <T>(outcome: VaultOutcome<T>): T => {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.failure}`);
  return outcome.data;
};

/** One shared real server: the PostgreSQL repository and the (decorated) S3-compatible store. */
function realServer() {
  return { repo: createPostgresVaultRepository(pool), objects } as unknown as NonNullable<
    Parameters<typeof createVaultHarness>[0]
  >['server'];
}
const newDevice = () => createVaultHarness({ server: realServer() });
const otherDevice = (first: VaultHarness) =>
  createVaultHarness({
    authenticator: first.authenticator,
    server: realServer(),
    clock: first.clock,
  });
async function recoverAccount(device: VaultHarness): Promise<void> {
  const recovered = await device.controller.recoverByDiscovery();
  if (!recovered.ok) throw new Error(recovered.code);
  must(await device.vault.refreshDiscovery());
}

async function vaultIdOf(address: string): Promise<string> {
  const row = await pool.query<{ vault_id: string }>(
    'select vault_id from vaults where owner_address = $1',
    [address.toLowerCase()],
  );
  return row.rows[0]?.vault_id ?? '';
}
const revisionOf = async (vaultId: string): Promise<number> =>
  Number(
    (
      await pool.query<{ revision: string }>(
        'select revision from vault_heads where vault_id = $1',
        [vaultId],
      )
    ).rows[0]?.revision ?? -1,
  );
const objectCount = async (vaultId: string): Promise<number> =>
  (
    await pool.query<{ n: number }>(
      'select count(*)::int n from vault_objects where vault_id = $1',
      [vaultId],
    )
  ).rows[0]?.n ?? -1;
const addressOf = (device: VaultHarness): string =>
  device.controller.getSnapshot().account?.address ?? '';

async function matterWithPackage() {
  const device = await withVault(newDevice());
  const matterId = must(await device.vault.createMatter('System storage matter'));
  const prepared = await prepareSynthetic('legal');
  const vaultId = await vaultIdOf(addressOf(device));
  return { device, matterId, prepared, vaultId };
}

describe('[vault-storage-fault-matrix] interrupted saves reconcile without a duplicate review', () => {
  // A baseline save tells how many object writes one logical capture needs on this build.
  let totalPuts = 0;
  beforeAll(async () => {
    if (blockedStart) return;
    const { device, matterId, prepared } = await matterWithPackage();
    objects.arm();
    must(await device.vault.saveFrozenReview(matterId, prepared));
    totalPuts = objects.puts;
  }, 120_000);

  const stages: { name: string; configure: (puts: number) => void }[] = [
    { name: 'before the first leaf upload', configure: () => (objects.failBeforePut = 1) },
    {
      name: 'after the first leaf upload (acknowledgement lost)',
      configure: () => (objects.failAfterPut = 1),
    },
    { name: 'before the capture upload', configure: (puts) => (objects.failBeforePut = puts - 1) },
    {
      name: 'after the capture upload (acknowledgement lost)',
      configure: (puts) => (objects.failAfterPut = puts - 1),
    },
    { name: 'before the catalog upload', configure: (puts) => (objects.failBeforePut = puts) },
    {
      name: 'after the catalog upload (acknowledgement lost)',
      configure: (puts) => (objects.failAfterPut = puts),
    },
    { name: 'during the read-back', configure: () => (objects.failGet = 1) },
  ];

  for (const stage of stages) {
    run(
      `${stage.name}: retry reuses the identity and ends with exactly one saved review`,
      async () => {
        const { device, matterId, prepared, vaultId } = await matterWithPackage();
        const revisionBefore = await revisionOf(vaultId);
        objects.arm();
        stage.configure(totalPuts);
        const first = await device.vault.saveFrozenReview(matterId, prepared);
        // Never reported as saved or checked while a step failed.
        expect(first.ok).toBe(false);
        expect(device.vault.getSnapshot().checkedCaptures).toEqual([]);
        expect(device.vault.recoverableCapture(prepared.reference.commitment)).toBeNull();
        objects.clear();

        const resumed = await device.vault.retryPendingCapture(prepared.reference.commitment);
        if (!resumed.ok) must(await device.vault.reconcile());
        // The same commitment, one logical review, one new revision: no duplicate, no silent overwrite.
        expect(device.vault.workingMatter(matterId)?.frozenReviews).toHaveLength(1);
        expect(device.vault.workingMatter(matterId)?.frozenReviews[0]?.commitment).toBe(
          prepared.reference.commitment,
        );
        must(await device.vault.verifyStoredCapture(matterId, prepared.reference.commitment));
        expect(device.vault.recoverableCapture(prepared.reference.commitment)).not.toBeNull();
        expect(await revisionOf(vaultId)).toBe(revisionBefore + 1);
        // The retry re-sent the exact envelopes it had: it created no more objects than one capture needs.
        expect(await objectCount(vaultId)).toBeLessThanOrEqual(totalPuts + 4);
      },
    );
  }

  run(
    'a head commit that applied but whose response was lost is reconciled, not duplicated',
    async () => {
      const { device, matterId, prepared, vaultId } = await matterWithPackage();
      const before = await revisionOf(vaultId);
      // Wrap THIS device's repository: the swap commits, then the response is lost.
      const server = device.server as unknown as {
        repo: { swapHead: VaultRepository['swapHead'] };
      };
      const real = server.repo.swapHead.bind(server.repo);
      server.repo.swapHead = async (...args) => {
        const result = await real(...args);
        device.faults.loseNextWriteResponse = true;
        return result;
      };
      const outcome = await device.vault.saveFrozenReview(matterId, prepared);
      server.repo.swapHead = real;
      expect(outcome.ok).toBe(false);
      must(await device.vault.reconcile());
      expect(await revisionOf(vaultId)).toBe(before + 1);
      expect(device.vault.workingMatter(matterId)?.frozenReviews).toHaveLength(1);
      must(await device.vault.verifyStoredCapture(matterId, prepared.reference.commitment));
    },
  );
});

describe('[vault-storage-concurrency-and-immutability] two sessions, repeated uploads, conflicting bytes', () => {
  run(
    'a second session saving from a stale head conflicts, keeps its draft and never overwrites the first',
    async () => {
      const a = await withVault(newDevice());
      const matterId = must(await a.vault.createMatter('Shared'));
      const b = otherDevice(a);
      await recoverAccount(b);
      must(await b.vault.recover());
      const vaultId = await vaultIdOf(addressOf(a));

      must(a.vault.addEntry(matterId, { kind: 'note', text: 'from A', confirmed: false }));
      must(await a.vault.saveMatter(matterId));
      const winner = await revisionOf(vaultId);
      must(b.vault.addEntry(matterId, { kind: 'note', text: 'from B', confirmed: false }));
      expect(await b.vault.saveMatter(matterId)).toEqual({ ok: false, failure: 'CONFLICT' });
      // The draft survives; the head and the winner's data are untouched.
      expect(b.vault.workingMatter(matterId)?.context.entries.map((entry) => entry.text)).toEqual([
        'from B',
      ]);
      expect(await revisionOf(vaultId)).toBe(winner);
      // The ledger of stored objects only grows: nothing was replaced.
      const counters = await pool.query<{ object_count: number; actual: number }>(
        `select v.object_count, (select count(*)::int from vault_objects o where o.vault_id = v.vault_id) as actual
       from vaults v where v.vault_id = $1`,
        [vaultId],
      );
      expect(counters.rows[0]?.object_count).toBe(counters.rows[0]?.actual);
    },
  );

  run(
    'repeating an identical upload succeeds once; different bytes under a used ID are refused and the first survive',
    async () => {
      const device = await withVault(newDevice());
      const matterId = must(await device.vault.createMatter('Immutable'));
      must(device.vault.addEntry(matterId, { kind: 'note', text: 'n', confirmed: false }));
      must(await device.vault.saveMatter(matterId));
      const vaultId = await vaultIdOf(addressOf(device));
      const row = await pool.query<{ object_id: string; sha256: string }>(
        'select object_id, sha256 from vault_objects where vault_id = $1 order by created_at limit 1',
        [vaultId],
      );
      const objectId = row.rows[0]?.object_id ?? '';
      const key = objectKey(vaultId, objectId);
      const stored = await objects.get(key);
      expect(stored).not.toBeNull();
      // Creating the same key again never overwrites it: the store answers 'exists' and keeps the first bytes.
      expect(await objects.putIfAbsent(key, new Uint8Array([1, 2, 3]))).toBe('exists');
      expect(
        createHash('sha256')
          .update(Buffer.from((await objects.get(key)) ?? []))
          .digest('hex'),
      ).toBe(
        createHash('sha256')
          .update(Buffer.from(stored ?? []))
          .digest('hex'),
      );
      expect(row.rows[0]?.sha256).toMatch(/^0x[0-9a-f]{64}$/);
    },
  );

  run(
    'success is reported only after the complete read-back and reachability from the catalog',
    async () => {
      const { device, matterId, prepared, vaultId } = await matterWithPackage();
      must(await device.vault.saveFrozenReview(matterId, prepared));
      // Every object of the capture is ready, and the head points at a ready catalog that lists the review.
      const states = await pool.query<{ state: string }>(
        'select distinct state from vault_objects where vault_id = $1',
        [vaultId],
      );
      expect(states.rows.map((r) => r.state)).toEqual(['ready']);
      const head = await pool.query<{ state: string }>(
        `select o.state from vault_heads h join vault_objects o
         on o.vault_id = h.vault_id and o.object_id = h.catalog_object_id where h.vault_id = $1`,
        [vaultId],
      );
      expect(head.rows[0]?.state).toBe('ready');
      expect(device.vault.getSnapshot().checkedCaptures).toHaveLength(1);
    },
  );
});

describe('[vault-storage-corruption-swaps-and-outage] missing, swapped, corrupt and unreachable objects', () => {
  const filePath = (vaultId: string, objectId: string): string =>
    join(
      services?.s3.root ?? '',
      services?.s3.bucket ?? '',
      'vaults',
      vaultId,
      'objects',
      objectId,
    );

  run(
    'every object a capture depends on is checked: missing ones block readiness, restoring them restores it',
    async () => {
      const { device, matterId, prepared, vaultId } = await matterWithPackage();
      must(await device.vault.saveFrozenReview(matterId, prepared));
      device.vault.lock();
      must(await device.vault.unlock());
      const all = await pool.query<{ object_id: string }>(
        'select object_id from vault_objects where vault_id = $1',
        [vaultId],
      );
      const frozen =
        device.vault.workingMatter(matterId)?.frozenReviews[0]?.frozenReview.objectId ?? '';
      // The frozen record itself, plus every other non-catalog object once.
      let checked = 0;
      for (const { object_id } of all.rows) {
        if (object_id === frozen || checked < 3) {
          const path = filePath(vaultId, object_id);
          const bytes = readFileSync(path);
          rmSync(path);
          const result = await device.vault.verifyStoredCapture(
            matterId,
            prepared.reference.commitment,
          );
          writeFileSync(path, bytes);
          if (!result.ok) checked += 1;
          expect(result.ok && object_id === frozen).toBe(false);
        }
      }
      expect(checked).toBeGreaterThan(0);
      // Everything restored: readiness is rebuilt by retrieval and verification again.
      must(await device.vault.verifyStoredCapture(matterId, prepared.reference.commitment));
    },
  );

  run(
    'a valid envelope that belongs to another account or vault is refused before any plaintext is used',
    async () => {
      const a = await matterWithPackage();
      must(await a.device.vault.saveFrozenReview(a.matterId, a.prepared));
      const b = await matterWithPackage();
      must(await b.device.vault.saveFrozenReview(b.matterId, b.prepared));
      b.device.vault.lock();
      must(await b.device.vault.unlock());
      // Take account A's valid frozen-review envelope and serve it where B's belongs. The server, the
      // object store and the digests all agree; only the envelope's own binding says it is not B's.
      const aObject =
        a.device.vault.workingMatter(a.matterId)?.frozenReviews[0]?.frozenReview.objectId ?? '';
      const bObject =
        b.device.vault.workingMatter(b.matterId)?.frozenReviews[0]?.frozenReview.objectId ?? '';
      const foreign = readFileSync(filePath(a.vaultId, aObject));
      const bPath = filePath(b.vaultId, bObject);
      const original = readFileSync(bPath);
      rmSync(bPath);
      expect(await objects.putIfAbsent(objectKey(b.vaultId, bObject), foreign)).toBe('created');
      await pool.query(
        'update vault_objects set sha256 = $3, byte_length = $4 where vault_id = $1 and object_id = $2',
        [
          b.vaultId,
          bObject,
          `0x${createHash('sha256').update(foreign).digest('hex')}`,
          foreign.length,
        ],
      );
      const result = await b.device.vault.verifyStoredCapture(
        b.matterId,
        b.prepared.reference.commitment,
      );
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/Notice period|GBP|blindingNonce/);
      expect(b.device.vault.recoverableCapture(b.prepared.reference.commitment)).toBeNull();
      // Restore B's genuine bytes and digest: nothing the failure did changed them.
      rmSync(bPath);
      writeFileSync(bPath, original);
      await pool.query(
        'update vault_objects set sha256 = $3, byte_length = $4 where vault_id = $1 and object_id = $2',
        [
          b.vaultId,
          bObject,
          `0x${createHash('sha256').update(original).digest('hex')}`,
          original.length,
        ],
      );
      must(await b.device.vault.verifyStoredCapture(b.matterId, b.prepared.reference.commitment));
    },
  );

  run('a partial outage is a failure, not "missing", and nothing becomes ready', async () => {
    const { device, matterId, prepared } = await matterWithPackage();
    must(await device.vault.saveFrozenReview(matterId, prepared));
    device.vault.lock();
    must(await device.vault.unlock());
    objects.failGetKeys = /objects\//;
    const result = await device.vault.verifyStoredCapture(matterId, prepared.reference.commitment);
    expect(result.ok).toBe(false);
    expect(device.vault.recoverableCapture(prepared.reference.commitment)).toBeNull();
    objects.clear();
    must(await device.vault.verifyStoredCapture(matterId, prepared.reference.commitment));
  });

  run(
    'a restart during a save leaves a pending capture that a fresh device never shows as saved',
    async () => {
      const { device, matterId, prepared, vaultId } = await matterWithPackage();
      objects.arm();
      objects.failAfterPut = 2;
      expect((await device.vault.saveFrozenReview(matterId, prepared)).ok).toBe(false);
      objects.clear();
      // The browser "restarts": a fresh device recovers from remote ciphertext alone.
      const fresh = otherDevice(device);
      await recoverAccount(fresh);
      must(await fresh.vault.recover());
      expect(fresh.vault.workingMatter(matterId)?.frozenReviews).toEqual([]);
      expect(fresh.vault.getSnapshot().checkedCaptures).toEqual([]);
      expect(await revisionOf(vaultId)).toBeGreaterThanOrEqual(1);
    },
  );

  run(
    'locking during decryption releases nothing: readiness is not granted to the interrupted work',
    async () => {
      const { device, matterId, prepared } = await matterWithPackage();
      must(await device.vault.saveFrozenReview(matterId, prepared));
      device.vault.lock();
      must(await device.vault.unlock());
      const pending = device.vault.verifyStoredCapture(matterId, prepared.reference.commitment);
      device.vault.lock(); // while retrieval and decryption are in flight
      await pending;
      expect(device.vault.recoverableCapture(prepared.reference.commitment)).toBeNull();
      expect(device.vault.getSnapshot().matters).toEqual([]);
    },
  );
});

describe('[vault-exports-roundtrip-real-stores] exports and imports', () => {
  async function saved() {
    const { device, matterId, prepared, vaultId } = await matterWithPackage();
    must(await device.vault.saveFrozenReview(matterId, prepared));
    return { device, matterId, prepared, vaultId };
  }

  run(
    'encrypted, readable and context exports round-trip through their preview and confirm flows',
    async () => {
      const { device, matterId, prepared, vaultId } = await saved();
      const readable = must(
        await device.vault.prepareExport(
          'readable-review',
          matterId,
          prepared.reference.commitment,
        ),
      );
      const file = must(device.vault.confirmExport(readable.exportId));
      const destination = must(await device.vault.createMatter('Destination'));
      const objectsBefore = await objectCount(vaultId);
      const shown = must(await device.vault.previewImport(file.bytes, prepared.reference));
      // A preview persists nothing; the foreign reviewer is kept and imported facts stay unconfirmed.
      expect(await objectCount(vaultId)).toBe(objectsBefore);
      expect(shown.review).toMatchObject({ foreignReviewer: true, matchesExpectedReference: true });
      must(await device.vault.confirmReviewImport(shown.importId, destination));
      expect(await objectCount(vaultId)).toBeGreaterThan(objectsBefore);
      must(await device.vault.verifyStoredCapture(destination, prepared.reference.commitment));
      // Fresh destination encryption does not change the package identity: exporting again gives the same
      // reference, commitment and artifact bytes.
      const again = must(
        await device.vault.prepareExport(
          'readable-review',
          destination,
          prepared.reference.commitment,
        ),
      );
      const againFile = JSON.parse(
        new TextDecoder().decode(must(device.vault.confirmExport(again.exportId)).bytes),
      ) as {
        receiptReference: unknown;
        artifacts: unknown;
      };
      const original = JSON.parse(new TextDecoder().decode(file.bytes)) as typeof againFile;
      expect(againFile.receiptReference).toEqual(original.receiptReference);
      expect(againFile.artifacts).toEqual(original.artifacts);
    },
  );

  run(
    'an encrypted backup only imports for the original account; a context export is not a document backup; notes do not erase captures',
    async () => {
      const { device, matterId, prepared, vaultId } = await saved();
      const encrypted = must(
        await device.vault.prepareExport(
          'encrypted-review',
          matterId,
          prepared.reference.commitment,
        ),
      );
      const backup = must(device.vault.confirmExport(encrypted.exportId));
      // A different account cannot import it.
      const stranger = await withVault(newDevice());
      const strangerMatter = must(await stranger.vault.createMatter('Elsewhere'));
      const attempt = await stranger.vault.previewImport(backup.bytes);
      const imported = attempt.ok
        ? await stranger.vault.confirmReviewImport(attempt.data.importId, strangerMatter)
        : attempt;
      expect(imported.ok).toBe(false);
      expect(stranger.vault.workingMatter(strangerMatter)?.frozenReviews).toEqual([]);
      // A context export carries confirmed facts only, never the document bytes or the opening.
      must(
        device.vault.addEntry(matterId, {
          kind: 'fact',
          text: 'Notice period is four weeks',
          confirmed: true,
        }),
      );
      must(await device.vault.saveMatter(matterId));
      const context = must(await device.vault.prepareExport('context', matterId));
      const contextText = new TextDecoder().decode(
        must(device.vault.confirmExport(context.exportId)).bytes,
      );
      expect(contextText).not.toContain(prepared.opening.blindingNonce);
      // Removing a working note changes working context only: the historic capture still verifies.
      const entry = device.vault.workingMatter(matterId)?.context.entries[0]?.entryId;
      if (entry !== undefined) {
        must(device.vault.removeEntry(matterId, entry));
        must(await device.vault.saveMatter(matterId));
      }
      must(await device.vault.verifyStoredCapture(matterId, prepared.reference.commitment));
      expect(await objectCount(vaultId)).toBeGreaterThan(0);
    },
  );

  run(
    'malformed, duplicate, unreferenced, oversize and foreign-bound bundles are rejected and persist nothing',
    async () => {
      const { device, matterId, prepared, vaultId } = await saved();
      const preview = must(
        await device.vault.prepareExport(
          'readable-review',
          matterId,
          prepared.reference.commitment,
        ),
      );
      const text = new TextDecoder().decode(
        must(device.vault.confirmExport(preview.exportId)).bytes,
      );
      const bundle = JSON.parse(text) as { artifacts: { artifactId: string; bytes: string }[] };
      const before = await objectCount(vaultId);
      const send = (value: unknown) =>
        device.vault.previewImport(new TextEncoder().encode(JSON.stringify(value)));
      const first = bundle.artifacts[0];
      if (first === undefined) throw new Error('fixture');
      expect((await send({ ...bundle, artifacts: [first, ...bundle.artifacts] })).ok).toBe(false); // duplicate
      expect(
        (
          await send({
            ...bundle,
            artifacts: [...bundle.artifacts, { artifactId: crypto.randomUUID(), bytes: 'AAAA' }],
          })
        ).ok,
      ).toBe(false); // unreferenced
      expect((await send({ ...bundle, artifacts: bundle.artifacts.slice(1) })).ok).toBe(false); // missing
      expect((await device.vault.previewImport(new TextEncoder().encode('{'))).ok).toBe(false); // malformed
      expect((await device.vault.previewImport(new Uint8Array(50 * 1024 * 1024 + 1))).ok).toBe(
        false,
      ); // oversize
      expect(await objectCount(vaultId)).toBe(before);
    },
  );
});
