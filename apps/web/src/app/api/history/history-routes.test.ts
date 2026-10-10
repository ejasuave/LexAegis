import { describe, expect, it, vi } from 'vitest';
import type { ChainPolicy, LiveChainClient } from '@lexaegis/sdk/registry';

vi.mock('server-only', () => ({}));

const { createEnvioClient } = await import('@/server/history/envio-client');
const { setHistoryRuntimeForTests } = await import('@/server/history/runtime');
const { GET: status } = await import('./status/route');
const { GET: reviewer } = await import('./reviewers/[reviewer]/route');
const { GET: receipt } = await import('./receipts/[reviewer]/[commitment]/route');

const h = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const a = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const REGISTRY = a(0x453b);
const ALICE = a(0xa11ce);
const POLICY: ChainPolicy = {
  chainId: '10143',
  registryAddress: REGISTRY,
  deploymentBlock: '100',
  runtimeCodeKeccak256: h(0xc0de),
  executionDelayBlocks: 3,
  executionDelayRevision: 'test',
};
const live: LiveChainClient = {
  getChainId: () => Promise.resolve(10143),
  getBlock: (s) => {
    const number = 'blockTag' in s ? 130n : s.blockNumber;
    return Promise.resolve({
      number,
      hash: h(Number(number) + 0x1000) as `0x${string}`,
      timestamp: 1n,
    });
  },
  getCode: () => Promise.resolve('0x' as `0x${string}`),
  call: () => Promise.resolve(undefined),
};
const meta = {
  chainId: '10143',
  startBlock: '100',
  progressBlock: '130',
  sourceBlock: '130',
  isReady: true,
  eventsProcessed: '0',
};

function install(fetchFn: typeof fetch | null): void {
  const envio =
    fetchFn === null ? null : createEnvioClient({ url: 'https://idx.example/g', fetchFn });
  setHistoryRuntimeForTests({
    state: 'ready',
    configured: { chainId: '10143', registryAddress: REGISTRY, startBlock: '100' },
    deps: {
      envio,
      chain: { live, policy: POLICY },
      now: () => new Date('2026-10-11T00:00:00Z'),
      continuity: { previous: null },
    },
  });
}
const respond = (data: unknown) =>
  (() =>
    Promise.resolve(
      new Response(JSON.stringify({ data }), { status: 200 }),
    )) as unknown as typeof fetch;
const emptyIndex = respond({
  _meta: meta,
  RegistryState: [],
  ReviewerSummary_by_pk: null,
  IndexedAction: [],
  IndexedReceipt_by_pk: null,
});
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });
const req = (path: string, init?: RequestInit) => new Request(`https://app.example${path}`, init);

describe('history routes', () => {
  it('returns typed unavailable bodies when the deployment is not ready', async () => {
    setHistoryRuntimeForTests({ state: 'not_configured', reason: 'DEPLOYMENT_UNAVAILABLE' });
    const res = await status(req('/api/history/status'));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, status: 'unavailable' });
    setHistoryRuntimeForTests(undefined);
  });

  it('answers public requests without any credential and forbids caching', async () => {
    install(emptyIndex);
    const res = await status(req('/api/history/status'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(await res.json()).toMatchObject({
      ok: true,
      health: { availability: 'available', freshness: 'caught_up' },
    });
  });

  it('rejects unknown query parameters, bad limits and non-lowercase or zero reviewers', async () => {
    install(emptyIndex);
    expect((await status(req('/api/history/status?x=1'))).status).toBe(400);
    expect(
      (await reviewer(req(`/api/history/reviewers/${ALICE}?foo=1`), ctx({ reviewer: ALICE })))
        .status,
    ).toBe(400);
    expect(
      (await reviewer(req(`/api/history/reviewers/${ALICE}?limit=51`), ctx({ reviewer: ALICE })))
        .status,
    ).toBe(400);
    expect(
      (await reviewer(req(`/api/history/reviewers/${ALICE}?limit=0`), ctx({ reviewer: ALICE })))
        .status,
    ).toBe(400);
    expect(
      (
        await reviewer(
          req(`/api/history/reviewers/${ALICE}?limit=1&limit=2`),
          ctx({ reviewer: ALICE }),
        )
      ).status,
    ).toBe(400);
    const upper = `0x${'A'.repeat(40)}`;
    expect(
      (await reviewer(req(`/api/history/reviewers/${upper}`), ctx({ reviewer: upper }))).status,
    ).toBe(400);
    const zero = a(0);
    expect(
      (await reviewer(req(`/api/history/reviewers/${zero}`), ctx({ reviewer: zero }))).status,
    ).toBe(400);
    expect((await receipt(req('/x'), ctx({ reviewer: ALICE, commitment: '0x12' }))).status).toBe(
      400,
    );
    expect((await receipt(req('/x'), ctx({ reviewer: ALICE, commitment: h(0) }))).status).toBe(400);
  });

  it('serves a coherent empty page as No indexed history', async () => {
    install(emptyIndex);
    const res = await reviewer(req(`/api/history/reviewers/${ALICE}`), ctx({ reviewer: ALICE }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      status: 'ok',
      empty: true,
      items: [],
      nextCursor: null,
    });
  });

  it('never turns an unreachable index into an empty page', async () => {
    install(() => Promise.resolve(new Response('', { status: 502 })));
    const res = await reviewer(req(`/api/history/reviewers/${ALICE}`), ctx({ reviewer: ALICE }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; items?: unknown };
    expect(body.ok).toBe(false);
    expect(body.items).toBeUndefined();
  });

  it('returns 409 history_reset_required for an invalid cursor', async () => {
    install(emptyIndex);
    const res = await reviewer(
      req(`/api/history/reviewers/${ALICE}?cursor=junk`),
      ctx({ reviewer: ALICE }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      status: 'history_reset_required',
      reason: 'CURSOR_INVALID',
    });
  });

  it('reports an unconfigured index as unavailable while the route still responds', async () => {
    install(null);
    const res = await status(req('/api/history/status'));
    const body = (await res.json()) as { health: { reasons: string[] } };
    expect(res.status).toBe(503);
    expect(body.health.reasons).toContain('INDEX_NOT_CONFIGURED');
  });

  it('keeps indexed state and the live result separate for one receipt', async () => {
    install(emptyIndex);
    const res = await receipt(req('/x'), ctx({ reviewer: ALICE, commitment: h(0xc0) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['indexed']).toEqual({ state: 'not_indexed' });
    expect(body['live']).toBeDefined();
    expect(body).not.toHaveProperty('valid');
  });
});
