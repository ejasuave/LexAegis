import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startLocalPostgres, type LocalPostgres } from '../../../../../test-support/embedded-pg';
import { migrate } from '../db/migrate';
import {
  createPostgresChainStore,
  UNSIGNED_LEASE_MS,
  type ChainStore,
  type ReserveInput,
} from './operation-store';

/* Real PostgreSQL: coordination is established by the database, not by process-local state. */

let postgres: LocalPostgres | null = null;
let pool: Pool;
let store: ChainStore;
const T0 = new Date('2026-10-09T12:00:00Z');
const OWNER = `0x${'aa'.repeat(20)}`;
let serial = 0;

beforeAll(async () => {
  const supplied = process.env.TEST_DATABASE_URL;
  if (supplied === undefined || supplied === '') postgres = await startLocalPostgres();
  pool = new Pool({ connectionString: supplied || postgres?.url, max: 30 });
  pool.on('connect', (client) => client.on('error', () => undefined));
  pool.on('error', () => undefined);
  await migrate(pool);
  store = createPostgresChainStore(pool);
});
afterAll(async () => {
  await pool.end();
  await postgres?.stop();
});
beforeEach(async () => {
  await pool.query('TRUNCATE chain_operations, funding_grants');
});

const uuid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
const reserveInput = (over: Partial<ReserveInput> = {}): ReserveInput => ({
  id: uuid(),
  owner: OWNER,
  kind: 'execute',
  idempotencyKey: `key-${serial}-xxxxxxxxxxxx`,
  intentHash: `0x${'01'.repeat(32)}`,
  chainId: '10143',
  registryAddress: `0x${'ab'.repeat(20)}`,
  commitment: `0x${'11'.repeat(32)}`,
  actionDigest: `0x${'22'.repeat(32)}`,
  registryNonce: '0',
  now: T0,
  ...over,
});

describe('operation coordination', () => {
  it('lets exactly one of many concurrent reservations per account win, across connections', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.reserve(reserveInput({ id: uuid(), idempotencyKey: `race-${i}-xxxxxxxxxxxxxx` })),
      ),
    );
    expect(results.filter((r) => r.kind === 'reserved')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'account_busy')).toHaveLength(11);
    // A different account is independent.
    const other = await store.reserve(
      reserveInput({ owner: `0x${'bb'.repeat(20)}`, idempotencyKey: 'other-xxxxxxxxxxxxxxxx' }),
    );
    expect(other.kind).toBe('reserved');
  });

  it('scopes idempotency keys to the account and kind; reuse with a different intent fails', async () => {
    const first = await store.reserve(reserveInput({ idempotencyKey: 'same-key-xxxxxxxxxxxx' }));
    expect(first.kind).toBe('reserved');
    const again = await store.reserve(
      reserveInput({ id: uuid(), idempotencyKey: 'same-key-xxxxxxxxxxxx' }),
    );
    expect(again.kind).toBe('existing');
    const changed = await store.reserve(
      reserveInput({
        id: uuid(),
        idempotencyKey: 'same-key-xxxxxxxxxxxx',
        intentHash: `0x${'02'.repeat(32)}`,
      }),
    );
    expect(changed.kind).toBe('idempotency_conflict');
  });

  it('releases only an unsigned lease; a signed or uncertain operation keeps its nonce', async () => {
    const reserved = await store.reserve(reserveInput({ idempotencyKey: 'lease-a-xxxxxxxxxxxxx' }));
    if (reserved.kind !== 'reserved') throw new Error('reserve');
    // Lapsed unsigned lease: a new reservation takes over.
    const later = new Date(T0.getTime() + UNSIGNED_LEASE_MS + 1000);
    const next = await store.reserve(
      reserveInput({ id: uuid(), idempotencyKey: 'lease-b-xxxxxxxxxxxxx', now: later }),
    );
    expect(next.kind).toBe('reserved');
    expect((await store.get(reserved.operation.id, OWNER))?.phase).toBe('cancelled');

    if (next.kind !== 'reserved') throw new Error('reserve');
    const hash = `0x${'33'.repeat(32)}`;
    const calldataHash = `0x${'44'.repeat(32)}`;
    await store.recordQuote(
      next.operation.id,
      OWNER,
      { transactionNonce: '7', calldataHash, quoteHash: `0x${'55'.repeat(32)}` },
      later,
    );
    const begun = await store.beginSubmit(
      next.operation.id,
      OWNER,
      { transactionHash: hash, transactionNonce: '7', calldataHash },
      later,
    );
    expect(begun.kind).toBe('recorded');
    await store.setPhase(next.operation.id, OWNER, 'unknown', {}, later);
    // Far in the future, an uncertain operation is still unresolved and blocks the account.
    const farFuture = new Date(T0.getTime() + 24 * 3600_000);
    const blocked = await store.reserve(
      reserveInput({ id: uuid(), idempotencyKey: 'lease-c-xxxxxxxxxxxxx', now: farFuture }),
    );
    expect(blocked.kind).toBe('account_busy');
    expect(await store.highestHeldTransactionNonce(OWNER)).toBe(7n);
  });

  it('records the hash once; an exact retry is idempotent and different bytes conflict', async () => {
    const reserved = await store.reserve(reserveInput({ idempotencyKey: 'hash-a-xxxxxxxxxxxxxx' }));
    if (reserved.kind !== 'reserved') throw new Error('reserve');
    const id = reserved.operation.id;
    const calldataHash = `0x${'44'.repeat(32)}`;
    await store.recordQuote(
      id,
      OWNER,
      { transactionNonce: '3', calldataHash, quoteHash: `0x${'55'.repeat(32)}` },
      T0,
    );
    const input = { transactionHash: `0x${'66'.repeat(32)}`, transactionNonce: '3', calldataHash };
    const outcomes = await Promise.all(
      [1, 2, 3].map(() => store.beginSubmit(id, OWNER, input, T0)),
    );
    expect(outcomes.map((o) => o.kind).sort()).toEqual(['recorded', 'retry', 'retry']);
    expect(
      (
        await store.beginSubmit(
          id,
          OWNER,
          { ...input, transactionHash: `0x${'77'.repeat(32)}` },
          T0,
        )
      ).kind,
    ).toBe('conflict');
  });

  it('shows an owner only their own operations', async () => {
    const reserved = await store.reserve(reserveInput({ idempotencyKey: 'owner-a-xxxxxxxxxxxxx' }));
    if (reserved.kind !== 'reserved') throw new Error('reserve');
    expect(await store.get(reserved.operation.id, `0x${'bb'.repeat(20)}`)).toBeNull();
    expect(await store.listUnresolved(`0x${'bb'.repeat(20)}`)).toEqual([]);
    expect(await store.listUnresolved(OWNER)).toHaveLength(1);
  });
});

describe('[funding-cooldown-reservations-and-crash-recovery] funding coordination', () => {
  const grant = (over: Partial<Parameters<ChainStore['reserveGrant']>[0]> = {}) => ({
    id: uuid(),
    recipient: `0x${'cc'.repeat(20)}`,
    chainId: '10143',
    amountWei: 2n * 10n ** 17n,
    reservedFeeWei: 10n ** 15n,
    dailyBudgetWei: 10n * 10n ** 18n,
    cooldownMs: 24 * 3600_000,
    now: T0,
    ...over,
  });

  it('allows one unresolved funding transaction at a time (the funder nonce lease)', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.reserveGrant(grant({ id: uuid(), recipient: `0x${String(i).repeat(40)}` })),
      ),
    );
    expect(results.filter((r) => r.kind === 'reserved')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'funder_busy')).toHaveLength(7);
  });

  it('enforces a rolling per-address cooldown and keeps reservations after uncertain outcomes', async () => {
    const first = await store.reserveGrant(grant());
    if (first.kind !== 'reserved') throw new Error('reserve');
    await store.setGrantPhase(first.grant.id, 'confirmed', '500000000000000', T0);
    const soon = await store.reserveGrant(
      grant({ id: uuid(), now: new Date(T0.getTime() + 3600_000) }),
    );
    expect(soon).toMatchObject({ kind: 'cooldown' });
    const later = await store.reserveGrant(
      grant({ id: uuid(), now: new Date(T0.getTime() + 25 * 3600_000) }),
    );
    expect(later.kind).toBe('reserved');
    if (later.kind !== 'reserved') return;
    await store.setGrantPhase(later.grant.id, 'unknown', null, T0);
    // Unknown stays unresolved: no other grant may spend the funder's nonce.
    const blocked = await store.reserveGrant(
      grant({
        id: uuid(),
        recipient: `0x${'dd'.repeat(20)}`,
        now: new Date(T0.getTime() + 26 * 3600_000),
      }),
    );
    expect(blocked.kind).toBe('funder_busy');
  });

  it('bounds total value plus fees per UTC day atomically', async () => {
    // Budget fits exactly two 0.2 MON grants with their fee reservations.
    const budget = 2n * (2n * 10n ** 17n + 10n ** 15n);
    const a = await store.reserveGrant(
      grant({ dailyBudgetWei: budget, recipient: `0x${'01'.repeat(20)}` }),
    );
    if (a.kind !== 'reserved') throw new Error('a');
    await store.setGrantPhase(a.grant.id, 'confirmed', '10000000000000', T0);
    const b = await store.reserveGrant(
      grant({ id: uuid(), dailyBudgetWei: budget, recipient: `0x${'02'.repeat(20)}` }),
    );
    if (b.kind !== 'reserved') throw new Error('b');
    await store.setGrantPhase(b.grant.id, 'confirmed', '10000000000000', T0);
    const c = await store.reserveGrant(
      grant({ id: uuid(), dailyBudgetWei: budget, recipient: `0x${'03'.repeat(20)}` }),
    );
    expect(c.kind).toBe('budget_exhausted');
    // A new UTC day starts a fresh budget.
    const tomorrow = await store.reserveGrant(
      grant({
        id: uuid(),
        dailyBudgetWei: budget,
        recipient: `0x${'03'.repeat(20)}`,
        now: new Date('2026-10-10T00:00:01Z'),
      }),
    );
    expect(tomorrow.kind).toBe('reserved');
  });

  it('stores the signed outbox transaction before broadcast and never a key', async () => {
    const reserved = await store.reserveGrant(grant());
    if (reserved.kind !== 'reserved') throw new Error('reserve');
    expect(
      await store.attachSignedGrant(
        reserved.grant.id,
        { funderNonce: '4', transactionHash: `0x${'ab'.repeat(32)}`, raw: '0x02deadbeef' },
        T0,
      ),
    ).toBe(true);
    // Only a reserved grant can be signed, once.
    expect(
      await store.attachSignedGrant(
        reserved.grant.id,
        { funderNonce: '5', transactionHash: `0x${'cd'.repeat(32)}`, raw: '0x02' },
        T0,
      ),
    ).toBe(false);
    const stuck = await store.unresolvedGrant('10143');
    expect(stuck).toMatchObject({ phase: 'signed', funderNonce: '4', outboxRaw: '0x02deadbeef' });
  });
});
