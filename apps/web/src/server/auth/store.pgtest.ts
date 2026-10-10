import { Pool } from 'pg';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startLocalPostgres, type LocalPostgres } from '../../../../../test-support/embedded-pg';
import { migrate } from '../db/migrate';
import { createAuthService, sha256Hex } from './service';
import { CHALLENGE_TTL_MS, SESSION_TTL_MS, createPostgresAuthStore, type AuthStore } from './store';

/*
 * The real PostgreSQL repository on a real server. This is where "at most one session per
 * challenge" is actually established: an in-memory store cannot show it.
 */

const signer = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const ADDRESS = signer.address.toLowerCase();
const START = new Date('2026-10-08T12:00:00Z');
const CONFIG = { origin: 'https://app.lexaegis.test', chainId: '10143', secureCookies: true };

let postgres: LocalPostgres | null = null;
let pool: Pool;
let store: AuthStore;
let serial = 0;

beforeAll(async () => {
  const supplied = process.env.TEST_DATABASE_URL;
  if (supplied === undefined || supplied === '') postgres = await startLocalPostgres();
  pool = new Pool({ connectionString: supplied || postgres?.url, max: 30 });
  // The server is stopped right after the pool; a late disconnect notice is not a test failure.
  pool.on('connect', (client) => client.on('error', () => undefined));
  pool.on('error', () => undefined);
  await migrate(pool);
  store = createPostgresAuthStore(pool);
});

afterAll(async () => {
  await pool.end();
  await postgres?.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE auth_challenges, auth_sessions, auth_rate_limits');
});

const count = async (table: string) =>
  Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);

async function newChallenge(overrides: { expiresAt?: Date; preauthHash?: string } = {}) {
  serial += 1;
  const id = serial.toString(16).padStart(32, '0');
  await store.createChallenge({
    id,
    address: ADDRESS,
    chainId: '10143',
    message: `message ${id}`,
    preauthHash: overrides.preauthHash ?? 'p'.repeat(64),
    createdAt: START,
    expiresAt: overrides.expiresAt ?? new Date(START.getTime() + CHALLENGE_TTL_MS),
  });
  return id;
}

const consume = (
  challengeId: string,
  tokenHash: string,
  extra: Partial<Parameters<AuthStore['consumeChallengeAndCreateSession']>[0]> = {},
) =>
  store.consumeChallengeAndCreateSession({
    challengeId,
    preauthHash: 'p'.repeat(64),
    now: new Date(START.getTime() + 1000),
    tokenHash,
    sessionExpiresAt: new Date(START.getTime() + SESSION_TTL_MS),
    ...extra,
  });

describe('migration', () => {
  it('is reproducible: a second run applies nothing, and concurrent runners do not collide', async () => {
    expect(await migrate(pool)).toEqual([]);
    const results = await Promise.all([migrate(pool), migrate(pool), migrate(pool)]);
    expect(results.flat()).toEqual([]);
    const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
    // Chapter 4's migration, then Chapter 5's: each applied exactly once.
    expect(rows.map((row) => row.name).sort()).toEqual([
      '0001_auth.sql',
      '0002_vault.sql',
      '0003_chain.sql',
      '0004_assistant.sql',
    ]);
  });

  it('stores no column for a plaintext token, key or PRF output', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name IN ('auth_challenges','auth_sessions')",
    );
    const columns = rows.map((row) => row.column_name).sort();
    expect(columns).toEqual([
      'address',
      'address',
      'chain_id',
      'chain_id',
      'consumed_at',
      'created_at',
      'created_at',
      'expires_at',
      'expires_at',
      'id',
      'message',
      'preauth_hash',
      'revoked_at',
      'token_hash',
    ]);
  });
});

describe('challenge consumption', () => {
  it('creates exactly one session when fifty verifications race for one challenge', async () => {
    const id = await newChallenge();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) => consume(id, index.toString(16).padStart(64, '0'))),
    );
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(await count('auth_sessions')).toBe(1);
    expect((await store.getChallenge(id))?.consumedAt).not.toBeNull();
  });

  it('rejects an expired, consumed, unknown or wrongly bound challenge without creating a session', async () => {
    const expired = await newChallenge({ expiresAt: new Date(START.getTime() + 500) });
    expect(await consume(expired, 'a'.repeat(64))).toBeNull();

    const bound = await newChallenge();
    expect(await consume(bound, 'b'.repeat(64), { preauthHash: 'q'.repeat(64) })).toBeNull();
    expect(await consume('f'.repeat(32), 'c'.repeat(64))).toBeNull();

    const once = await newChallenge();
    expect(await consume(once, 'd'.repeat(64))).not.toBeNull();
    expect(await consume(once, 'e'.repeat(64))).toBeNull();
    expect(await count('auth_sessions')).toBe(1);
  });

  it('revokes the replaced session in the same transaction', async () => {
    const first = await newChallenge();
    await consume(first, 'a'.repeat(64));
    const second = await newChallenge();
    await consume(second, 'b'.repeat(64), { replacesTokenHash: 'a'.repeat(64) });
    const now = new Date(START.getTime() + 2000);
    expect(await store.getSession('a'.repeat(64), now)).toBeNull();
    expect(await store.getSession('b'.repeat(64), now)).toMatchObject({
      address: ADDRESS,
      chainId: '10143',
    });
  });
});

describe('sessions', () => {
  it('expire, revoke and are found only by token hash', async () => {
    const id = await newChallenge();
    await consume(id, 'a'.repeat(64));
    const live = new Date(START.getTime() + SESSION_TTL_MS - 1);
    expect(await store.getSession('a'.repeat(64), live)).not.toBeNull();
    expect(
      await store.getSession('a'.repeat(64), new Date(START.getTime() + SESSION_TTL_MS)),
    ).toBeNull();
    expect(await store.getSession('z'.repeat(64), live)).toBeNull();
    await store.revokeSession('a'.repeat(64), live);
    expect(await store.getSession('a'.repeat(64), live)).toBeNull();
  });
});

describe('shared rate limiting and cleanup', () => {
  it('admits exactly the limit when attempts race', async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, () => store.allow('bucket', START, 10)),
    );
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await store.allow('bucket', new Date(START.getTime() + 60_000), 10)).toBe(true);
  });

  it('removes expired rows in bounded batches and keeps live ones', async () => {
    for (let i = 0; i < 5; i += 1) await newChallenge({ expiresAt: new Date(START.getTime() + 1) });
    const live = await newChallenge();
    expect(await store.cleanup(new Date(START.getTime() + 1000), 3)).toBe(3);
    expect(await store.cleanup(new Date(START.getTime() + 1000), 3)).toBe(2);
    expect(await store.getChallenge(live)).not.toBeNull();
  });
});

describe('full sign-in against PostgreSQL', () => {
  it('issues one session for concurrent verifications of a real signed challenge and stores no bearer token', async () => {
    let seed = 0;
    const service = createAuthService({
      store,
      config: CONFIG,
      now: () => START,
      randomBytes: (length) => {
        seed += 1;
        return Uint8Array.from({ length }, (_, index) => (seed * 29 + index * 11) & 0xff);
      },
    });
    const issued = await service.challenge({ address: ADDRESS, chainId: '10143' }, 'req');
    const { challengeId, message } = issued.body as { challengeId: string; message: string };
    const preauth = issued.cookies[0]?.split('; ')[0] ?? '';
    const signature = await signer.signMessage({ message });

    // Twenty would trip the per-challenge attempt limit, so five race here.
    const replies = await Promise.all(
      Array.from({ length: 5 }, () => service.verify({ challengeId, signature }, preauth, 'req')),
    );
    const accepted = replies.filter((reply) => reply.status === 200);
    expect(accepted).toHaveLength(1);
    expect(await count('auth_sessions')).toBe(1);

    const token = accepted[0]?.cookies[0]?.split('; ')[0]?.split('=')[1] ?? '';
    const stored = await pool.query<{ token_hash: string }>('SELECT * FROM auth_sessions');
    expect(stored.rows[0]?.token_hash).toBe(sha256Hex(token));
    expect(JSON.stringify(stored.rows)).not.toContain(token);
    expect((await service.me(`__Host-lexaegis_session=${token}`, 'req')).body).toMatchObject({
      address: ADDRESS,
    });
  });
});
