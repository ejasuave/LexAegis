import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ChainPolicy, LiveChainClient } from '@lexaegis/sdk/registry';
import type { EnvioClient } from './envio-client';
import type { WireAction as Wire } from './schemas';
import type { HistoryDeps as Deps } from './status';

vi.mock('server-only', () => ({}));

const { decodeCursor, encodeCursor } = await import('./cursor');
const { createEnvioClient, ENVIO_LIMITS, isAllowedEnvioUrl } = await import('./envio-client');
const { computeLag } = await import('./lag');
const { OPERATIONS } = await import('./queries');
const { evaluateConsistency, readHistoryPage, readHealth, readReceiptHistory } =
  await import('./status');
const { setHistoryRuntimeForTests } = await import('./runtime');

const h = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const a = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const REGISTRY = a(0x453b);
const GENESIS = h(0x6e);
const ALICE = a(0xa11ce);
const CONFIGURED = { chainId: '10143', registryAddress: REGISTRY, startBlock: '100' };
const POLICY: ChainPolicy = {
  chainId: '10143',
  registryAddress: REGISTRY,
  deploymentBlock: '100',
  runtimeCodeKeccak256: h(0xc0de),
  executionDelayBlocks: 3,
  executionDelayRevision: 'test',
};
const FIXED = new Date('2026-10-11T00:00:00.000Z');
const KEY = `10143:${GENESIS}:${REGISTRY}:${ALICE}`;

const stateRow = (over: Record<string, unknown> = {}) => ({
  id: `10143:${GENESIS}:${REGISTRY}`,
  chainId: '10143',
  genesisHash: GENESIS,
  registryAddress: REGISTRY,
  configFingerprint: h(0xf1),
  generation: 'gen-00000001',
  projectionVersion: 'lexaegis.history-projection.v1',
  startBlock: '100',
  rawEventCount: 3,
  actionCount: 3,
  pendingSupersessions: 0,
  lastEventId: 'e3',
  lastEventBlockNumber: '120',
  lastEventBlockHash: h(0x1200),
  lastEventLogIndex: 0,
  ...over,
});
const metaRow = (over: Record<string, unknown> = {}) => ({
  chainId: '10143',
  startBlock: '100',
  progressBlock: '130',
  sourceBlock: '130',
  isReady: true,
  eventsProcessed: '3',
  ...over,
});
const action = (nonce: number, over: Partial<Wire> = {}): Wire => ({
  id: `${KEY}:${nonce}`,
  reviewer: ALICE,
  kind: 'ISSUE',
  consumedNonce: String(nonce),
  nextNonce: String(nonce + 1),
  commitment: h(0xc0 + nonce),
  relatedCommitment: null,
  transactionHash: h(0x700 + nonce),
  executor: ALICE,
  blockNumber: String(110 + nonce),
  blockHash: h(0x1000 + 110 + nonce),
  timestamp: String(1000 + nonce),
  firstEventId: `ev${nonce}`,
  lastEventId: `ev${nonce}`,
  firstLogIndex: 0,
  lastLogIndex: 0,
  eventCount: 1,
  ...over,
});

function fakeLive(
  finalized = 130n,
  hashOf: (n: bigint) => string = (n) => h(Number(n) + 0x1000),
): LiveChainClient {
  return {
    getChainId: () => Promise.resolve(10143),
    getBlock: (selector) => {
      const number = 'blockTag' in selector ? finalized : selector.blockNumber;
      return Promise.resolve({ number, hash: hashOf(number) as `0x${string}`, timestamp: 1_000n });
    },
    getCode: () => Promise.resolve('0x' as `0x${string}`),
    call: () => Promise.resolve(undefined),
  };
}

interface FakeData {
  meta: ReturnType<typeof metaRow>;
  state: ReturnType<typeof stateRow> | null;
  actions: Wire[];
  failure?: 'UNAVAILABLE' | 'RESPONSE_INVALID';
}
function fakeEnvio(data: FakeData): EnvioClient {
  const bad = <T>() =>
    Promise.resolve({ ok: false as const, failure: data.failure ?? 'UNAVAILABLE' } as never as T);
  return {
    readMeta: () =>
      data.failure
        ? bad()
        : Promise.resolve({
            ok: true as const,
            data: { meta: data.meta, state: data.state } as never,
          }),
    readSummary: () =>
      Promise.resolve({
        ok: true as const,
        data:
          data.actions.length === 0
            ? null
            : ({
                id: KEY,
                reviewer: ALICE,
                nextNonce: String(data.actions.length),
                totalReceipts: 1,
                activeReceipts: 1,
                revokedReceipts: 0,
                supersededReceipts: 0,
                actionCount: data.actions.length,
              } as never),
      }),
    readActions: ({ upper, limit }) =>
      Promise.resolve({
        ok: true as const,
        data: data.actions
          .filter((x) => BigInt(x.consumedNonce) <= BigInt(upper))
          .sort((x, y) => (BigInt(y.consumedNonce) > BigInt(x.consumedNonce) ? 1 : -1))
          .slice(0, limit + 1),
      }),
    readAnchors: (ids) =>
      Promise.resolve({ ok: true as const, data: data.actions.filter((x) => ids.includes(x.id)) }),
    readReceipt: () => Promise.resolve({ ok: true as const, data: null }),
    readLink: () => Promise.resolve({ ok: true as const, data: null }),
  };
}
const deps = (data: FakeData, over: Partial<Deps> = {}): Deps => ({
  envio: fakeEnvio(data),
  chain: { live: fakeLive(), policy: POLICY },
  now: () => FIXED,
  continuity: { previous: null },
  ...over,
});
const sample = (n: number): FakeData => ({
  meta: metaRow(),
  state: stateRow(),
  actions: Array.from({ length: n }, (_, i) => action(i)),
});

describe('lag and freshness', () => {
  it('is caught up only when both lags are known, zero and coherent', () => {
    expect(
      computeLag({ progressBlock: '5', sourceBlock: '5', liveCheckpointBlock: '5', coherent: true })
        .freshness,
    ).toBe('caught_up');
    expect(
      computeLag({ progressBlock: '5', sourceBlock: '9', liveCheckpointBlock: '5', coherent: true })
        .freshness,
    ).toBe('catching_up');
    expect(
      computeLag({
        progressBlock: '5',
        sourceBlock: '5',
        liveCheckpointBlock: '8',
        coherent: true,
      }),
    ).toMatchObject({
      freshness: 'catching_up',
      confirmedLag: '3',
    });
    expect(
      computeLag({
        progressBlock: '5',
        sourceBlock: '5',
        liveCheckpointBlock: null,
        coherent: true,
      }).freshness,
    ).toBe('unknown');
    expect(
      computeLag({
        progressBlock: '5',
        sourceBlock: '5',
        liveCheckpointBlock: '5',
        coherent: false,
      }).freshness,
    ).toBe('unknown');
  });
  it('clamps negative lag to zero and keeps uint256 exact', () => {
    const big = (2n ** 200n).toString();
    expect(
      computeLag({ progressBlock: '9', sourceBlock: '4', liveCheckpointBlock: '4', coherent: true })
        .sourceLag,
    ).toBe('0');
    expect(
      computeLag({ progressBlock: '0', sourceBlock: big, liveCheckpointBlock: big, coherent: true })
        .sourceLag,
    ).toBe(big);
  });
});

describe('consistency', () => {
  const read = (m = metaRow(), s: ReturnType<typeof stateRow> | null = stateRow()) =>
    ({ meta: m, state: s }) as never;
  it('accepts the configured deployment and an empty index', () => {
    expect(
      evaluateConsistency({ configured: CONFIGURED, read: read(), previous: null }).value,
    ).toBe('consistent');
    expect(
      evaluateConsistency({ configured: CONFIGURED, read: read(metaRow(), null), previous: null }),
    ).toMatchObject({
      value: 'consistent',
      reasons: ['NO_EVENTS_INDEXED'],
    });
  });
  it('flags another deployment, committed incomplete supersessions and rebuilds', () => {
    expect(
      evaluateConsistency({
        configured: CONFIGURED,
        read: read(metaRow({ chainId: '143' })),
        previous: null,
      }).value,
    ).toBe('inconsistent');
    expect(
      evaluateConsistency({
        configured: CONFIGURED,
        read: read(metaRow(), stateRow({ registryAddress: a(1) })),
        previous: null,
      }).value,
    ).toBe('inconsistent');
    expect(
      evaluateConsistency({
        configured: CONFIGURED,
        read: read(metaRow(), stateRow({ pendingSupersessions: 1 })),
        previous: null,
      }).reasons,
    ).toEqual(['INCOMPLETE_SUPERSESSION']);
    expect(
      evaluateConsistency({
        configured: CONFIGURED,
        read: read(),
        previous: { generation: 'gen-00000000', progress: 130n },
      }).reasons,
    ).toEqual(['GENERATION_CHANGED']);
  });
  it('separates a rollback inside the window from one beyond it', () => {
    const prev = (p: bigint) => ({ generation: 'gen-00000001', progress: p });
    expect(
      evaluateConsistency({ configured: CONFIGURED, read: read(), previous: prev(150n) }).value,
    ).toBe('recovering');
    expect(
      evaluateConsistency({ configured: CONFIGURED, read: read(), previous: prev(400n) }).value,
    ).toBe('inconsistent');
  });
});

describe('cursor', () => {
  const c = {
    v: 1 as const,
    fp: h(1),
    gen: 'gen-00000001',
    r: ALICE,
    upper: '9',
    upperHash: h(2),
    last: '5',
    lastHash: h(3),
  };
  it('round-trips and rejects tampering, junk and non-canonical forms', () => {
    const text = encodeCursor(c);
    expect(decodeCursor(text)).toEqual(c);
    expect(decodeCursor(`${text}A`)).toBeNull();
    expect(decodeCursor('!!!')).toBeNull();
    expect(decodeCursor('x'.repeat(3000))).toBeNull();
    const forged = Buffer.from(JSON.stringify({ ...c, last: '-1' })).toString('base64url');
    expect(decodeCursor(forged)).toBeNull();
    const extra = Buffer.from(JSON.stringify({ ...c, admin: true })).toString('base64url');
    expect(decodeCursor(extra)).toBeNull();
  });
});

describe('Envio client', () => {
  const ok = (body: unknown, init: ResponseInit = {}) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200, ...init }));
  const client = (fetchFn: typeof fetch) => {
    const c = createEnvioClient({
      url: 'https://index.example/graphql',
      token: 'secret-token-value',
      fetchFn,
    });
    if (c === null) throw new Error('client');
    return c;
  };
  it('accepts only https or loopback endpoints without credentials', () => {
    expect(isAllowedEnvioUrl('https://x.example/g')).toBe(true);
    expect(isAllowedEnvioUrl('http://127.0.0.1:8080/g')).toBe(true);
    expect(isAllowedEnvioUrl('http://x.example/g')).toBe(false);
    expect(isAllowedEnvioUrl(['https://', 'user', ':', 'pw', '@x.example/g'].join(''))).toBe(false);
    expect(createEnvioClient({ url: 'http://x.example' })).toBeNull();
  });
  it('sends a named operation with variables and the token header only', async () => {
    const fetchFn = vi.fn((_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as {
        operationName: string;
        variables: unknown;
      };
      expect(body.operationName).toBe('ReviewerSummary');
      expect((init?.headers as Record<string, string>)['authorization']).toBe(
        'Bearer secret-token-value',
      );
      return ok({ data: { ReviewerSummary_by_pk: null } });
    });
    const r = await client(fetchFn).readSummary('k');
    expect(r).toEqual({ ok: true, data: null });
  });
  it('never turns errors, partial data or malformed rows into success', async () => {
    const run = (body: unknown) => client(() => ok(body)).readSummary('k');
    expect(
      await run({ data: { ReviewerSummary_by_pk: null }, errors: [{ message: 'x' }] }),
    ).toEqual({ ok: false, failure: 'GRAPHQL_ERROR' });
    expect(await run({})).toEqual({ ok: false, failure: 'RESPONSE_INVALID' });
    expect(await run({ data: { ReviewerSummary_by_pk: { id: 'x' } } })).toEqual({
      ok: false,
      failure: 'RESPONSE_INVALID',
    });
  });
  it('rejects unsafe integers and negative or fractional numbers', async () => {
    const bad = { ...stateRow(), rawEventCount: 2 ** 60 };
    const r = await client(() =>
      ok({
        data: { _meta: [metaRow()], RegistryState: [bad] },
      }),
    ).readMeta();
    expect(r).toEqual({ ok: false, failure: 'RESPONSE_INVALID' });
    const frac = await client(() =>
      ok({
        data: { _meta: [metaRow({ progressBlock: 1.5 })], RegistryState: [] },
      }),
    ).readMeta();
    expect(frac.ok).toBe(false);
  });
  it('reads the real Hasura shape: _meta as a one-entry list with numeric fields', async () => {
    const live = {
      chainId: 10143,
      startBlock: 100,
      progressBlock: 130,
      sourceBlock: 130,
      isReady: true,
      eventsProcessed: 4,
    };
    const r = await client(() =>
      ok({
        data: { _meta: [live], RegistryState: [stateRow()] },
      }),
    ).readMeta();
    expect(r.ok).toBe(true);
    const bare = await client(() => ok({ data: { _meta: live, RegistryState: [] } })).readMeta();
    expect(bare.ok).toBe(false);
  });
  it('treats more than one registry row as a mismatch', async () => {
    const r = await client(() =>
      ok({
        data: { _meta: [metaRow()], RegistryState: [stateRow(), stateRow()] },
      }),
    ).readMeta();
    expect(r.ok).toBe(false);
  });
  it('bounds the response size', async () => {
    const big = 'x'.repeat(ENVIO_LIMITS.maxResponseBytes + 10);
    const r = await client(() => Promise.resolve(new Response(big, { status: 200 }))).readMeta();
    expect(r).toEqual({ ok: false, failure: 'RESPONSE_TOO_LARGE' });
  });
  it('retries a transient failure once and then reports unavailable', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(new Response('', { status: 503 })));
    const r = await client(fetchFn).readMeta();
    expect(r).toEqual({ ok: false, failure: 'UNAVAILABLE' });
    expect(fetchFn).toHaveBeenCalledTimes(1 + ENVIO_LIMITS.transientRetries);
    const second = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockImplementationOnce(() => ok({ data: { ReviewerSummary_by_pk: null } }));
    expect((await client(second as unknown as typeof fetch).readSummary('k')).ok).toBe(true);
  });
  it('does not retry GraphQL errors and never echoes the token', async () => {
    const fetchFn = vi.fn(() => ok({ errors: [{ message: 'secret-token-value leaked' }] }));
    const r = await client(fetchFn).readMeta();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(r)).not.toContain('secret-token-value');
  });
  it('caps the page size at the maximum plus one lookahead row', async () => {
    const fetchFn = vi.fn((_u: unknown, init?: RequestInit) => {
      const v = (JSON.parse(init?.body as string) as { variables: { limit: number } }).variables;
      expect(v.limit).toBe(ENVIO_LIMITS.maxPageSize + 1);
      return ok({ data: { IndexedAction: [] } });
    });
    await client(fetchFn).readActions({
      reviewer: ALICE,
      upper: '1',
      limit: 9999,
    });
    expect(fetchFn).toHaveBeenCalled();
  });
  it('keeps indexer/queries identical to the operations in use', () => {
    for (const [name, text] of Object.entries(OPERATIONS)) {
      const file = readFileSync(
        fileURLToPath(new URL(`../../../../../indexer/queries/${name}.graphql`, import.meta.url)),
        'utf8',
      );
      expect(file.trim()).toBe(text.trim());
    }
  });
});

describe('history pages', () => {
  it('returns the newest actions first with an anchored cursor', async () => {
    const out = await readHistoryPage(deps(sample(5)), CONFIGURED, {
      reviewer: ALICE,
      cursor: null,
      limit: 2,
    });
    if (out.kind !== 'ok') throw new Error(out.kind);
    expect(out.page.items.map((i) => i.consumedNonce)).toEqual(['4', '3']);
    expect(out.page.anchor).toEqual({ upperNonce: '4', blockHash: h(0x1000 + 114) });
    expect(out.page.nextCursor).not.toBeNull();
    expect(out.page.empty).toBe(false);
  });
  it('continues strictly below the last row and ends without a cursor', async () => {
    const d = deps(sample(5));
    const first = await readHistoryPage(d, CONFIGURED, { reviewer: ALICE, cursor: null, limit: 3 });
    if (first.kind !== 'ok') throw new Error('first');
    const second = await readHistoryPage(d, CONFIGURED, {
      reviewer: ALICE,
      cursor: first.page.nextCursor,
      limit: 3,
    });
    if (second.kind !== 'ok') throw new Error(second.kind);
    expect(second.page.items.map((i) => i.consumedNonce)).toEqual(['1', '0']);
    expect(second.page.nextCursor).toBeNull();
  });
  it('keeps pages stable when newer actions arrive between requests', async () => {
    const data = sample(5);
    const d = deps(data);
    const first = await readHistoryPage(d, CONFIGURED, { reviewer: ALICE, cursor: null, limit: 3 });
    if (first.kind !== 'ok') throw new Error('first');
    data.actions.push(action(5), action(6));
    const second = await readHistoryPage(d, CONFIGURED, {
      reviewer: ALICE,
      cursor: first.page.nextCursor,
      limit: 3,
    });
    if (second.kind !== 'ok') throw new Error(second.kind);
    expect(second.page.items.map((i) => i.consumedNonce)).toEqual(['1', '0']);
  });
  it('requires a history reset when an anchor changed, the generation changed or the cursor is junk', async () => {
    const data = sample(5);
    const d = deps(data);
    const first = await readHistoryPage(d, CONFIGURED, { reviewer: ALICE, cursor: null, limit: 3 });
    if (first.kind !== 'ok') throw new Error('first');
    const cursor = first.page.nextCursor;
    data.actions[4] = action(4, { blockHash: h(0xdead) });
    const changed = await readHistoryPage(d, CONFIGURED, { reviewer: ALICE, cursor, limit: 3 });
    expect(changed).toMatchObject({
      kind: 'reset',
      body: { status: 'history_reset_required', reason: 'ANCHOR_CHANGED' },
    });
    const rebuilt = deps({ ...sample(5), state: stateRow({ generation: 'gen-00000002' }) });
    expect(
      await readHistoryPage(rebuilt, CONFIGURED, { reviewer: ALICE, cursor, limit: 3 }),
    ).toMatchObject({ kind: 'reset', body: { reason: 'GENERATION_CHANGED' } });
    expect(
      await readHistoryPage(d, CONFIGURED, { reviewer: ALICE, cursor: 'junk!', limit: 3 }),
    ).toMatchObject({ kind: 'reset', body: { reason: 'CURSOR_INVALID' } });
  });
  it('rejects a cursor for another reviewer', async () => {
    const d = deps(sample(5));
    const first = await readHistoryPage(d, CONFIGURED, { reviewer: ALICE, cursor: null, limit: 2 });
    if (first.kind !== 'ok') throw new Error('first');
    expect(
      await readHistoryPage(d, CONFIGURED, {
        reviewer: a(0xb0b),
        cursor: first.page.nextCursor,
        limit: 2,
      }),
    ).toMatchObject({ kind: 'reset', body: { reason: 'CURSOR_INVALID' } });
  });
  it('reports an empty page only after coherent coverage', async () => {
    const empty = await readHistoryPage(
      deps({ meta: metaRow(), state: null, actions: [] }),
      CONFIGURED,
      { reviewer: ALICE, cursor: null, limit: 5 },
    );
    expect(empty).toMatchObject({ kind: 'ok', page: { empty: true, items: [] } });
    const down = await readHistoryPage(deps({ ...sample(0), failure: 'UNAVAILABLE' }), CONFIGURED, {
      reviewer: ALICE,
      cursor: null,
      limit: 5,
    });
    expect(down.kind).toBe('unavailable');
  });
  it('is unavailable (not empty) when the index belongs to another deployment', async () => {
    const out = await readHistoryPage(
      deps({ ...sample(2), meta: metaRow({ chainId: '143' }) }),
      CONFIGURED,
      { reviewer: ALICE, cursor: null, limit: 5 },
    );
    expect(out).toMatchObject({
      kind: 'unavailable',
      health: { availability: 'unavailable', indexConsistency: 'inconsistent' },
    });
  });
  it('treats an indexed block hash that differs from the canonical chain as inconsistent', async () => {
    const out = await readHistoryPage(
      deps(sample(3), { chain: { live: fakeLive(130n, () => h(0xbad)), policy: POLICY } }),
      CONFIGURED,
      { reviewer: ALICE, cursor: null, limit: 5 },
    );
    expect(out).toMatchObject({
      kind: 'unavailable',
      health: { reasons: ['ANCHOR_HASH_MISMATCH'] },
    });
  });
  it('labels newer-than-confirmed actions provisional', async () => {
    const out = await readHistoryPage(
      deps(sample(3), { chain: { live: fakeLive(113n), policy: POLICY } }),
      CONFIGURED,
      { reviewer: ALICE, cursor: null, limit: 5 },
    );
    if (out.kind !== 'ok') throw new Error(out.kind);
    // checkpoint = 113 - 3 = 110: all of blocks 111..112 are newer.
    expect(out.page.items.map((i) => i.provisional)).toEqual([true, true, false]);
  });
  it('keeps history readable but labelled when the live checkpoint is unavailable', async () => {
    const live: LiveChainClient = {
      ...fakeLive(),
      getChainId: () => Promise.reject(new Error('rpc down')),
    };
    const out = await readHistoryPage(
      deps(sample(2), { chain: { live, policy: POLICY } }),
      CONFIGURED,
      { reviewer: ALICE, cursor: null, limit: 5 },
    );
    if (out.kind !== 'ok') throw new Error(out.kind);
    expect(out.page.health.live).toBeNull();
    expect(out.page.health.freshness).toBe('unknown');
    expect(out.page.items.every((i) => i.provisional)).toBe(true);
  });
  it('detects tampered ordering bounds in the upstream rows', async () => {
    const bad = deps(sample(3));
    const original = bad.envio as EnvioClient;
    const tampered: EnvioClient = {
      ...original,
      readActions: () => Promise.resolve({ ok: true as const, data: [action(1), action(2)] }),
    };
    expect(
      (
        await readHistoryPage({ ...bad, envio: tampered }, CONFIGURED, {
          reviewer: ALICE,
          cursor: null,
          limit: 5,
        })
      ).kind,
    ).toBe('unavailable');
  });
});

describe('health', () => {
  it('keeps the last event block out of freshness', async () => {
    const { health } = await readHealth(
      deps({ ...sample(1), meta: metaRow({ progressBlock: '130', sourceBlock: '130' }) }),
      CONFIGURED,
    );
    expect(health.index?.lastEventBlock).toBe('120');
    expect(health.freshness).toBe('caught_up');
    expect(health.lag.sourceLag).toBe('0');
  });
  it('shows a stopped indexer as delayed once the live checkpoint advances', async () => {
    const data = sample(1);
    const d = deps(data, { chain: { live: fakeLive(500n), policy: POLICY } });
    const { health } = await readHealth(d, CONFIGURED);
    expect(health.freshness).toBe('catching_up');
    expect(health.lag.confirmedLag).toBe('367');
  });
  it('is unavailable and unknown without an index', async () => {
    const { health } = await readHealth(deps(sample(1), { envio: null }), CONFIGURED);
    expect(health).toMatchObject({
      availability: 'unavailable',
      freshness: 'unknown',
    });
    expect(health.reasons).toContain('INDEX_NOT_CONFIGURED');
  });
  it('does not call a metadata change a success', async () => {
    let n = 0;
    const flapping: EnvioClient = {
      ...fakeEnvio(sample(1)),
      readMeta: () => {
        n += 1;
        return Promise.resolve({
          ok: true as const,
          data: { meta: metaRow({ progressBlock: String(100 + n) }), state: stateRow() } as never,
        });
      },
    };
    const { health } = await readHealth(deps(sample(1), { envio: flapping }), CONFIGURED);
    expect(health.availability).toBe('unavailable');
    expect(health.reasons).toContain('METADATA_CHANGED');
  });
});

describe('receipt history', () => {
  it('keeps not_indexed distinct and never claims current verification on live failure', async () => {
    const live: LiveChainClient = {
      ...fakeLive(),
      getChainId: () => Promise.reject(new Error('down')),
    };
    const out = await readReceiptHistory(
      deps(sample(1), { chain: { live, policy: POLICY } }),
      CONFIGURED,
      { reviewer: ALICE, commitment: h(0xc0) },
    );
    if (out.kind !== 'ok') throw new Error(out.kind);
    expect(out.body.indexed.state).toBe('not_indexed');
    expect(out.body.live).toMatchObject({ status: 'unknown' });
    expect(out.body.comparison).toBe('unavailable');
  });
});

describe('runtime seam', () => {
  it('can be overridden for route tests and cleared again', () => {
    setHistoryRuntimeForTests({ state: 'not_configured', reason: 'INDEX_NOT_CONFIGURED' });
    setHistoryRuntimeForTests(undefined);
  });
});
