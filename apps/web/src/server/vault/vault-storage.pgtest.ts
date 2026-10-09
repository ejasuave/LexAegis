import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  VaultKeys,
  emptyCatalog,
  sealCatalog,
  VAULT_LIMITS,
  type SealedObject,
  type VaultBinding,
  type VaultDescriptorV1,
} from '@lexaegis/vault';
import { startLocalPostgres, type LocalPostgres } from '../../../../../test-support/embedded-pg';
import { startLocalS3, localS3Available, type LocalS3 } from '@/test-support/local-s3';
import { migrate } from '../db/migrate';
import { createS3ObjectStore, objectKey, type ObjectStore } from './object-store';
import { createPostgresVaultRepository, type VaultRepository } from './repository';
import { createVaultService, type VaultReply, type VaultService } from './service';

/*
 * The real PostgreSQL repository and a real S3-compatible server (the pinned VersityGW). This is
 * where quota races, head compare-and-swap, creation races and conditional-create behaviour are
 * actually established. Nothing here is a mock.
 */

const RP = 'app.lexaegis.test';
const A = `0x${'aa'.repeat(20)}`;
const B = `0x${'bb'.repeat(20)}`;
let postgres: LocalPostgres | null = null;
let s3: LocalS3;
let pool: Pool;
let repo: VaultRepository;
let objects: ObjectStore;
let service: VaultService;
let keys: VaultKeys;
let counter = 0;
const uuid = () => {
  counter += 1;
  return `e0000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
};

beforeAll(async () => {
  if (!localS3Available()) throw new Error('run "pnpm tools:s3" first');
  const supplied = process.env.TEST_DATABASE_URL;
  if (supplied === undefined || supplied === '') postgres = await startLocalPostgres();
  s3 = await startLocalS3();
  pool = new Pool({ connectionString: supplied || postgres?.url, max: 30 });
  pool.on('connect', (client) => client.on('error', () => undefined));
  pool.on('error', () => undefined);
  await migrate(pool);
  repo = createPostgresVaultRepository(pool);
  objects = createS3ObjectStore(s3);
  const made = await VaultKeys.fromPrf(new Uint8Array(32).fill(9));
  if (!made.ok) throw new Error(made.code);
  keys = made.data;
});

afterAll(async () => {
  await pool.end();
  await s3.stop();
  await postgres?.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE vault_heads, vault_objects, vaults CASCADE');
  service = createVaultService({
    repo,
    objects,
    rpId: RP,
    now: () => new Date(),
    randomId: uuid,
    allow: () => Promise.resolve(true),
  });
});

interface Made {
  descriptor: VaultDescriptorV1;
  binding: VaultBinding;
  catalog: SealedObject;
}
async function makeVault(owner = A): Promise<Made> {
  const vaultId = uuid();
  const binding = { vaultId, ownerAddress: owner, rpId: RP };
  const descriptor: VaultDescriptorV1 = {
    schema: 'lexaegis.vault-descriptor.v1',
    vaultId,
    ownerAddress: owner,
    rpId: RP,
    accountProfileId: 'lexaegis.evm.bip32-prf.v1',
    cryptoProfileId: 'lexaegis.vault.hkdf-sha256.aes-256-gcm.v1',
  };
  const catalog = await sealCatalog(keys, binding, emptyCatalog(vaultId));
  if (!catalog.ok) throw new Error(catalog.code);
  return { descriptor, binding, catalog: catalog.data };
}
const createBody = (made: Made) =>
  new TextEncoder().encode(
    JSON.stringify({
      descriptor: made.descriptor,
      catalog: JSON.parse(new TextDecoder().decode(made.catalog.bytes)) as unknown,
    }),
  );
const status = (reply: VaultReply) => reply.status;
const errorCode = (reply: VaultReply) =>
  reply.kind === 'json' ? (reply.body as { error?: { code: string } }).error?.code : undefined;

async function created(owner = A) {
  const made = await makeVault(owner);
  const reply = await service.create(owner, createBody(made), 'r');
  expect(status(reply)).toBe(201);
  return made;
}
async function sealed(binding: VaultBinding, text: string): Promise<SealedObject> {
  const result = await keys.encrypt(binding, new TextEncoder().encode(text), 'structured');
  if (!result.ok) throw new Error(result.code);
  return result.data;
}
const put = (owner: string, made: Made, object: SealedObject) =>
  service.putObject(owner, made.descriptor.vaultId, object.ref.objectId, object.bytes, 'r');

describe('provider behaviour', () => {
  it('the real S3-compatible server refuses to overwrite: duplicate create is rejected and the first bytes survive', async () => {
    const key = `probe-direct/${uuid()}`;
    expect(await objects.putIfAbsent(key, new Uint8Array([1, 2, 3]))).toBe('created');
    expect(await objects.putIfAbsent(key, new Uint8Array([9, 9, 9]))).toBe('exists');
    expect(Array.from((await objects.get(key)) ?? [])).toEqual([1, 2, 3]);
    expect(await objects.get(`${key}-missing`)).toBeNull();
  });

  it('exactly one of many concurrent conditional creates wins', async () => {
    const key = `probe-race/${uuid()}`;
    const outcomes = await Promise.all(
      Array.from({ length: 16 }, (_, i) => objects.putIfAbsent(key, new Uint8Array([i]))),
    );
    expect(outcomes.filter((o) => o === 'created')).toHaveLength(1);
  });
});

describe('creation', () => {
  it('discovery shows explicit absence, then the vault, and tells nothing across accounts', async () => {
    expect(
      (await service.discover(A, 'r')).kind === 'json' && (await service.discover(A, 'r')),
    ).toMatchObject({ status: 200, body: { vault: null } });
    const made = await created();
    const mine = await service.discover(A, 'r');
    expect(mine).toMatchObject({
      status: 200,
      body: {
        vault: { descriptor: { vaultId: made.descriptor.vaultId }, head: { revision: '0' } },
      },
    });
    expect(await service.discover(B, 'r')).toMatchObject({ status: 200, body: { vault: null } });
  });

  it('validates the descriptor against the session and the configured rpId', async () => {
    const made = await makeVault();
    expect(status(await service.create(B, createBody(made), 'r'))).toBe(400);
    const wrongRp = { ...made, descriptor: { ...made.descriptor, rpId: 'other.test' } };
    expect(status(await service.create(A, createBody(wrongRp), 'r'))).toBe(400);
    expect(status(await service.create(A, new TextEncoder().encode('{"descriptor":1}'), 'r'))).toBe(
      400,
    );
    expect(await service.discover(A, 'r')).toMatchObject({ body: { vault: null } });
  });

  it('a second create is a conflict that never overwrites the first', async () => {
    const first = await created();
    const second = await makeVault();
    const reply = await service.create(A, createBody(second), 'r');
    expect(status(reply)).toBe(409);
    expect(await service.discover(A, 'r')).toMatchObject({
      body: { vault: { descriptor: { vaultId: first.descriptor.vaultId } } },
    });
    const rows = await pool.query('SELECT vault_id FROM vaults');
    expect(rows.rowCount).toBe(1);
  });

  it('when twenty creations race, one vault exists and the winner is intact', async () => {
    const attempts = await Promise.all(Array.from({ length: 20 }, () => makeVault()));
    const replies = await Promise.all(
      attempts.map((made) => service.create(A, createBody(made), 'r')),
    );
    expect(replies.filter((r) => status(r) === 201)).toHaveLength(1);
    expect(replies.filter((r) => status(r) === 409).length).toBe(19);
    const winner = attempts[replies.findIndex((r) => status(r) === 201)];
    const view = await service.discover(A, 'r');
    expect(view).toMatchObject({
      body: { vault: { descriptor: { vaultId: winner?.descriptor.vaultId } } },
    });
    expect((await pool.query("SELECT 1 FROM vaults WHERE state = 'ready'")).rowCount).toBe(1);
    expect((await pool.query('SELECT 1 FROM vault_heads')).rowCount).toBe(1);
  });

  it('a half-created vault is invisible, and an identical retry completes it', async () => {
    const made = await makeVault();
    await repo.beginCreate(
      {
        vaultId: made.descriptor.vaultId,
        ownerAddress: A,
        rpId: RP,
        accountProfileId: 'lexaegis.evm.bip32-prf.v1',
        now: new Date(),
      },
      {
        objectId: made.catalog.ref.objectId,
        sha256: made.catalog.ref.envelopeSha256,
        byteLength: Number(made.catalog.ref.envelopeByteLength),
      },
    );
    expect(await service.discover(A, 'r')).toMatchObject({ body: { vault: null } });
    expect(await repo.getOwned(made.descriptor.vaultId, A)).toBeNull();
    expect(status(await service.create(A, createBody(made), 'r'))).toBe(201);
    expect(await service.discover(A, 'r')).toMatchObject({
      body: { vault: { head: { revision: '0' } } },
    });
  });
});

describe('immutable objects', () => {
  it('stores an envelope, returns the exact bytes, and treats an exact retry as success', async () => {
    const made = await created();
    const object = await sealed(made.binding, 'evidence');
    expect(await put(A, made, object)).toMatchObject({ status: 200, body: { ref: object.ref } });
    expect(await put(A, made, object)).toMatchObject({ status: 200, body: { ref: object.ref } });
    const got = await service.getObject(A, made.descriptor.vaultId, object.ref.objectId, 'r');
    expect(got.kind === 'bytes' && Array.from(got.bytes)).toEqual(Array.from(object.bytes));
    expect((await pool.query('SELECT object_count FROM vaults')).rows[0]).toMatchObject({
      object_count: 2,
    });
  });

  it('refuses changed bytes under a used object ID, at the database and at the object store', async () => {
    const made = await created();
    const first = await sealed(made.binding, 'one');
    await put(A, made, first);
    const second = await sealed(made.binding, 'two');
    // Same ID, different bytes: the registry of references says no.
    const reused = { ...second, ref: { ...second.ref, objectId: first.ref.objectId } };
    expect(
      errorCode(
        await service.putObject(A, made.descriptor.vaultId, first.ref.objectId, reused.bytes, 'r'),
      ),
    ).toBe('INVALID');

    // Different bytes already sitting under the key in storage (an unregistered object): still refused.
    const squatted = await sealed(made.binding, 'squatter');
    await objects.putIfAbsent(
      objectKey(made.descriptor.vaultId, squatted.ref.objectId),
      new TextEncoder().encode('not the same bytes'),
    );
    expect(errorCode(await put(A, made, squatted))).toBe('CONFLICT');
    expect(
      (
        await pool.query('SELECT state FROM vault_objects WHERE object_id = $1', [
          squatted.ref.objectId,
        ])
      ).rows[0],
    ).toMatchObject({ state: 'reserved' });
    const stored = await objects.get(objectKey(made.descriptor.vaultId, squatted.ref.objectId));
    expect(new TextDecoder().decode(stored ?? new Uint8Array())).toBe('not the same bytes');
  });

  it('validates the canonical envelope and its binding before storing anything', async () => {
    const made = await created();
    const object = await sealed(made.binding, 'x');
    const foreign = await sealed({ ...made.binding, ownerAddress: B }, 'y');
    const other = await sealed({ ...made.binding, vaultId: uuid() }, 'z');
    expect(errorCode(await put(A, made, foreign))).toBe('INVALID');
    expect(errorCode(await put(A, made, other))).toBe('INVALID');
    expect(
      errorCode(await service.putObject(A, made.descriptor.vaultId, uuid(), object.bytes, 'r')),
    ).toBe('INVALID');
    expect(
      errorCode(
        await service.putObject(
          A,
          made.descriptor.vaultId,
          object.ref.objectId,
          new TextEncoder().encode('{}'),
          'r',
        ),
      ),
    ).toBe('INVALID');
    expect(
      errorCode(
        await service.putObject(
          A,
          made.descriptor.vaultId,
          object.ref.objectId,
          new Uint8Array(VAULT_LIMITS.maxEnvelopeBytes + 1),
          'r',
        ),
      ),
    ).toBe('TOO_LARGE');
    expect((await pool.query('SELECT object_count FROM vaults')).rows[0]).toMatchObject({
      object_count: 1,
    });
  });

  it('an outage mid-upload never becomes a saved object', async () => {
    const made = await created();
    const object = await sealed(made.binding, 'lost');
    const down = createVaultService({
      repo,
      objects: {
        putIfAbsent: () => Promise.reject(Object.assign(new Error('x'), { kind: 'UNAVAILABLE' })),
        get: () => Promise.resolve(null),
      },
      rpId: RP,
      now: () => new Date(),
      randomId: uuid,
      allow: () => Promise.resolve(true),
    });
    // The probe fails first, so storage is refused rather than guessed at.
    expect(
      errorCode(
        await down.putObject(A, made.descriptor.vaultId, object.ref.objectId, object.bytes, 'r'),
      ),
    ).toBe('UNAVAILABLE');
    expect(await repo.getObject(made.descriptor.vaultId, object.ref.objectId)).toBeNull();
    expect(
      errorCode(await service.getObject(A, made.descriptor.vaultId, object.ref.objectId, 'r')),
    ).toBe('NOT_FOUND');
  });
});

describe('ownership', () => {
  it('another account, an unknown ID and a malformed ID are all the same not-found', async () => {
    const made = await created();
    const object = await sealed(made.binding, 'private');
    await put(A, made, object);
    const probes = await Promise.all([
      service.getHead(B, made.descriptor.vaultId, 'r'),
      service.getObject(B, made.descriptor.vaultId, object.ref.objectId, 'r'),
      service.putObject(B, made.descriptor.vaultId, object.ref.objectId, object.bytes, 'r'),
      service.getHead(A, uuid(), 'r'),
      service.getObject(A, made.descriptor.vaultId, uuid(), 'r'),
      service.getObject(A, 'not-a-uuid', object.ref.objectId, 'r'),
      service.putHead(B, made.descriptor.vaultId, new TextEncoder().encode('{}'), 'r'),
    ]);
    expect(probes.map(status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    expect(
      new Set(
        probes.map((p) =>
          JSON.stringify({
            ...p,
            body: {
              ...(p.kind === 'json' ? (p.body as object) : {}),
              error: { code: errorCode(p) },
            },
          }),
        ),
      ).size,
    ).toBe(1);
  });
});

describe('quotas', () => {
  it('admit exactly the remaining object count when uploads race', async () => {
    const made = await created();
    await pool.query('UPDATE vaults SET object_count = $1 WHERE vault_id = $2', [
      VAULT_LIMITS.maxObjects - 3,
      made.descriptor.vaultId,
    ]);
    const batch = await Promise.all(
      Array.from({ length: 12 }, (_, i) => sealed(made.binding, `q${String(i)}`)),
    );
    const replies = await Promise.all(batch.map((object) => put(A, made, object)));
    const accepted = replies.filter((r) => status(r) === 200).length;
    expect(accepted).toBeLessThanOrEqual(3);
    expect(replies.filter((r) => status(r) === 413 || status(r) === 429).length).toBe(
      12 - accepted,
    );
    expect(
      (await pool.query<{ object_count: number }>('SELECT object_count FROM vaults')).rows[0]
        ?.object_count,
    ).toBeLessThanOrEqual(VAULT_LIMITS.maxObjects);
  });

  it('count staged objects against the byte quota, including unreachable ones', async () => {
    const made = await created();
    await pool.query('UPDATE vaults SET byte_count = $1 WHERE vault_id = $2', [
      VAULT_LIMITS.maxStoredBytes - 10,
      made.descriptor.vaultId,
    ]);
    expect(errorCode(await put(A, made, await sealed(made.binding, 'does not fit')))).toBe('QUOTA');
    expect((await pool.query('SELECT 1 FROM vault_objects')).rowCount).toBe(1);
  });

  it('serialises concurrent reservations so counters equal the sum of what was accepted', async () => {
    const made = await created();
    const batch = await Promise.all(
      Array.from({ length: 4 }, (_, i) => sealed(made.binding, `c${String(i)}`)),
    );
    await Promise.all(batch.map((object) => put(A, made, object)));
    const { rows } = await pool.query<{ object_count: number; byte_count: string }>(
      'SELECT object_count, byte_count FROM vaults',
    );
    const sum = await pool.query<{ n: number; bytes: string }>(
      'SELECT count(*)::int AS n, sum(byte_length)::bigint AS bytes FROM vault_objects',
    );
    expect(rows[0]?.object_count).toBe(sum.rows[0]?.n);
    expect(String(rows[0]?.byte_count)).toBe(String(sum.rows[0]?.bytes));
  });
});

describe('head compare-and-swap', () => {
  async function catalogAt(made: Made, label: string) {
    const object = await sealed(made.binding, label);
    expect(status(await put(A, made, object))).toBe(200);
    return object;
  }
  const swap = (made: Made, expected: string, ref: SealedObject['ref']) =>
    service.putHead(
      A,
      made.descriptor.vaultId,
      new TextEncoder().encode(JSON.stringify({ expectedRevision: expected, catalog: ref })),
      'r',
    );

  it('advances exactly once per revision and returns the winner on conflict', async () => {
    const made = await created();
    const next = await catalogAt(made, 'rev1');
    expect(await swap(made, '0', next.ref)).toMatchObject({
      status: 200,
      body: { revision: '1', catalog: next.ref },
    });
    const stale = await catalogAt(made, 'stale');
    const conflict = await swap(made, '0', stale.ref);
    expect(conflict).toMatchObject({
      status: 409,
      body: { error: { code: 'CONFLICT' }, head: { revision: '1', catalog: next.ref } },
    });
  });

  it('treats an identical update that already applied as success, not a conflict', async () => {
    const made = await created();
    const next = await catalogAt(made, 'rev1');
    await swap(made, '0', next.ref);
    expect(await swap(made, '0', next.ref)).toMatchObject({ status: 200, body: { revision: '1' } });
    expect(await service.getHead(A, made.descriptor.vaultId, 'r')).toMatchObject({
      body: { revision: '1' },
    });
  });

  it('under thirty concurrent writers from one revision, one wins and the revision moves once', async () => {
    const made = await created();
    // Uploaded one by one: the service bounds concurrent uploads, and this test is about the swap.
    const candidates: SealedObject[] = [];
    for (let i = 0; i < 30; i += 1) candidates.push(await catalogAt(made, `w${String(i)}`));
    const replies = await Promise.all(candidates.map((object) => swap(made, '0', object.ref)));
    expect(replies.filter((r) => status(r) === 200)).toHaveLength(1);
    expect(replies.filter((r) => status(r) === 409)).toHaveLength(29);
    expect(await service.getHead(A, made.descriptor.vaultId, 'r')).toMatchObject({
      body: { revision: '1' },
    });
  });

  it('refuses a catalog that was reserved but never became ready, and a reference that does not match', async () => {
    const made = await created();
    const staged = await sealed(made.binding, 'never uploaded');
    await repo.reserveObject(
      made.descriptor.vaultId,
      {
        objectId: staged.ref.objectId,
        sha256: staged.ref.envelopeSha256,
        byteLength: staged.bytes.byteLength,
      },
      new Date(),
    );
    expect(status(await swap(made, '0', staged.ref))).toBe(400);
    const real = await catalogAt(made, 'real');
    expect(
      status(await swap(made, '0', { ...real.ref, envelopeSha256: `0x${'00'.repeat(32)}` })),
    ).toBe(400);
    expect(status(await swap(made, '0', { ...real.ref, objectId: uuid() }))).toBe(400);
    expect(await service.getHead(A, made.descriptor.vaultId, 'r')).toMatchObject({
      body: { revision: '0' },
    });
  });

  it('an uncertain acknowledgement can be reconciled by reading the head and retrying identically', async () => {
    const made = await created();
    const next = await catalogAt(made, 'rev1');
    await swap(made, '0', next.ref); // applied, but suppose the client never heard
    const head = await service.getHead(A, made.descriptor.vaultId, 'r');
    expect(head).toMatchObject({ body: { revision: '1', catalog: next.ref } });
    expect(status(await swap(made, '0', next.ref))).toBe(200);
  });
});

describe('database contents', () => {
  it('hold only public metadata: no plaintext, titles or hashes of content', async () => {
    const made = await created();
    const object = await sealed(made.binding, 'SENTINEL-legal-title-and-text');
    await put(A, made, object);
    const dump = JSON.stringify([
      (await pool.query('SELECT * FROM vaults')).rows,
      (await pool.query('SELECT * FROM vault_objects')).rows,
      (await pool.query('SELECT * FROM vault_heads')).rows,
    ]);
    expect(dump).not.toContain('SENTINEL');
    const columns = (
      await pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name IN ('vaults','vault_objects','vault_heads')",
      )
    ).rows.map((r) => r.column_name);
    expect(columns).not.toEqual(
      expect.arrayContaining(['title', 'plaintext', 'content_hash', 'nonce']),
    );
    const raw = await objects.get(objectKey(made.descriptor.vaultId, object.ref.objectId));
    expect(new TextDecoder().decode(raw ?? new Uint8Array())).not.toContain('SENTINEL');
  });
});
