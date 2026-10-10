import { describe, expect, it } from 'vitest';
import type {
  HistoryAction,
  HistoryHealth,
  HistoryPage,
  ReceiptHistory,
} from '@/domain/history/response';
import type { ApiResult, HistoryApi } from './api-client';
import { HistoryController, POLL_INTERVAL_MS, POLL_WINDOW_MS, type Scheduler } from './controller';
import { createHistoryApi } from './api-client';
import { describeAction, indexerLabel, receiptReferenceText } from './presentation';

const h = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const a = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const ALICE = a(0xa11ce);
const BOB = a(0xb0b);

const health = (over: Partial<HistoryHealth> = {}): HistoryHealth => ({
  schema: 'lexaegis.history-health.v1',
  availability: 'available',
  freshness: 'caught_up',
  indexConsistency: 'consistent',
  observedAt: '2026-10-11T00:00:00.000Z',
  configured: { chainId: '10143', registryAddress: a(0x453b), startBlock: '100' },
  index: null,
  live: null,
  lag: { sourceLag: '0', confirmedLag: '0' },
  reasons: [],
  ...over,
});
const action = (n: number): HistoryAction => ({
  id: `act-${n}`,
  kind: 'ISSUE',
  consumedNonce: String(n),
  commitment: h(n + 1),
  relatedCommitment: null,
  reviewer: ALICE,
  executor: ALICE,
  transactionHash: h(0x700 + n),
  blockNumber: String(110 + n),
  blockHash: h(0x1000 + n),
  timestamp: String(1000 + n),
  eventCount: 1,
  firstLogIndex: 0,
  lastLogIndex: 0,
  provisional: false,
});
const page = (
  items: HistoryAction[],
  nextCursor: string | null = null,
  empty = false,
): HistoryPage => ({
  schema: 'lexaegis.history-page.v1',
  status: 'ok',
  health: health(),
  reviewer: ALICE,
  items,
  nextCursor,
  anchor: items[0] ? { upperNonce: items[0].consumedNonce, blockHash: items[0].blockHash } : null,
  empty,
});

class Gate<T> {
  resolve!: (value: T) => void;
  readonly promise = new Promise<T>((r) => (this.resolve = r));
}

function api(over: Partial<HistoryApi> = {}): HistoryApi {
  return {
    status: () => Promise.resolve({ kind: 'ok', value: health() }),
    page: () => Promise.resolve({ kind: 'ok', value: page([action(1)]) }),
    receipt: () =>
      Promise.resolve({
        kind: 'failed',
        failure: 'unavailable',
      } satisfies ApiResult<ReceiptHistory>),
    ...over,
  };
}

function clock() {
  let now = 0;
  let tick: (() => void) | null = null;
  const scheduler: Scheduler = {
    now: () => now,
    every: (cb) => {
      tick = cb;
      return () => {
        tick = null;
      };
    },
  };
  return {
    scheduler,
    advance: (ms: number) => {
      now += ms;
      tick?.();
    },
    active: () => tick !== null,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('HistoryController', () => {
  it('loads the first page for the selected reviewer and announces the count', async () => {
    const c = new HistoryController(api());
    c.setReviewer(ALICE);
    await settle();
    expect(c.getSnapshot()).toMatchObject({
      list: 'ready',
      empty: false,
      announcement: '1 history entry shown.',
    });
  });

  it('shows No indexed history only for a coherent empty page', async () => {
    const empty = new HistoryController(
      api({ page: () => Promise.resolve({ kind: 'ok', value: page([], null, true) }) }),
    );
    empty.setReviewer(ALICE);
    await settle();
    expect(empty.getSnapshot()).toMatchObject({
      list: 'ready',
      empty: true,
      announcement: 'No indexed history.',
    });
    const down = new HistoryController(
      api({ page: () => Promise.resolve({ kind: 'unavailable', health: null }) }),
    );
    down.setReviewer(ALICE);
    await settle();
    expect(down.getSnapshot()).toMatchObject({ list: 'unavailable', empty: false, items: [] });
  });

  it('appends later pages without duplicating rows', async () => {
    const pages = [page([action(3), action(2)], 'cur'), page([action(2), action(1)])];
    const c = new HistoryController(
      api({ page: () => Promise.resolve({ kind: 'ok', value: pages.shift() as HistoryPage }) }),
    );
    c.setReviewer(ALICE);
    await settle();
    await c.loadMore();
    expect(c.getSnapshot().items.map((i) => i.id)).toEqual(['act-3', 'act-2', 'act-1']);
    expect(c.getSnapshot().nextCursor).toBeNull();
  });

  it('requires a refresh after a history reset and then recovers', async () => {
    let call = 0;
    const c = new HistoryController(
      api({
        page: () => {
          call += 1;
          return Promise.resolve(
            call === 2
              ? ({
                  kind: 'reset',
                  reset: {
                    schema: 'lexaegis.history-error.v1',
                    status: 'history_reset_required',
                    reason: 'ANCHOR_CHANGED',
                  },
                } as const)
              : ({ kind: 'ok', value: page([action(1)], call === 1 ? 'cur' : null) } as const),
          );
        },
      }),
    );
    c.setReviewer(ALICE);
    await settle();
    await c.loadMore();
    expect(c.getSnapshot()).toMatchObject({ list: 'reset_required', items: [] });
    await c.refresh();
    expect(c.getSnapshot()).toMatchObject({ list: 'ready' });
    expect(c.getSnapshot().items).toHaveLength(1);
  });

  it('drops a late response after the account changed', async () => {
    const gate = new Gate<ApiResult<HistoryPage>>();
    const seen: string[] = [];
    const c = new HistoryController(
      api({
        page: (reviewer) => {
          seen.push(reviewer);
          return reviewer === ALICE
            ? gate.promise
            : Promise.resolve({ kind: 'ok', value: page([action(9)]) });
        },
      }),
    );
    c.setReviewer(ALICE);
    c.setReviewer(BOB);
    await settle();
    gate.resolve({ kind: 'ok', value: page([action(1)]) });
    await settle();
    expect(seen).toEqual([ALICE, BOB]);
    expect(c.getSnapshot()).toMatchObject({ reviewer: BOB });
    expect(c.getSnapshot().items.map((i) => i.id)).toEqual(['act-9']);
  });

  it('clears items, selection and detail on lock without keeping labels', async () => {
    const c = new HistoryController(api());
    c.setReviewer(ALICE);
    await settle();
    await c.select(h(2));
    c.clear();
    expect(c.getSnapshot()).toMatchObject({
      reviewer: ALICE,
      items: [],
      selected: null,
      detail: null,
      list: 'idle',
    });
    expect(JSON.stringify(c.getSnapshot())).not.toMatch(/label|title|matter/i);
  });

  it('ignores a late receipt detail after the selection moved', async () => {
    const first = new Gate<ApiResult<ReceiptHistory>>();
    const c = new HistoryController(
      api({
        receipt: (_r, commitment) =>
          commitment === h(2)
            ? first.promise
            : Promise.resolve({ kind: 'failed', failure: 'unavailable' }),
      }),
    );
    c.setReviewer(ALICE);
    await settle();
    void c.select(h(2));
    await c.select(h(3));
    first.resolve({ kind: 'failed', failure: 'unavailable' });
    await settle();
    expect(c.getSnapshot().selected).toBe(h(3));
  });

  it('refreshes every 10 seconds for two minutes, pauses while hidden, then stops', async () => {
    const t = clock();
    let calls = 0;
    const c = new HistoryController(
      api({
        page: () => {
          calls += 1;
          return Promise.resolve({ kind: 'ok', value: page([action(1)]) });
        },
      }),
      t.scheduler,
    );
    c.setReviewer(ALICE);
    await settle();
    expect(calls).toBe(1);
    c.startWatching();
    expect(c.getSnapshot().watching).toBe(true);
    t.advance(POLL_INTERVAL_MS);
    await settle();
    expect(calls).toBe(2);
    c.setPaused(true);
    t.advance(POLL_INTERVAL_MS);
    await settle();
    expect(calls).toBe(2);
    c.setPaused(false);
    t.advance(POLL_WINDOW_MS);
    await settle();
    expect(c.getSnapshot().watching).toBe(false);
    expect(t.active()).toBe(false);
    expect(c.getSnapshot().announcement).toMatch(/Use Refresh/);
    const before = calls;
    t.advance(POLL_INTERVAL_MS);
    expect(calls).toBe(before);
  });

  it('cannot affect any transaction state: it exposes no write capability', () => {
    const c = new HistoryController(api());
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(c)).join(' ')).not.toMatch(
      /sign|submit|confirm|approve|revoke/i,
    );
  });
});

describe('createHistoryApi', () => {
  const respond = (status: number, body: unknown) => () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  it('validates bodies, maps statuses and never sends credentials', async () => {
    let init: RequestInit | undefined;
    const client = createHistoryApi((_u, i) => {
      init = i;
      return respond(200, { ok: true, ...page([action(1)]) })();
    });
    const ok = await client.page(ALICE, { cursor: null, limit: 20 });
    expect(ok.kind).toBe('ok');
    expect(init?.credentials).toBe('omit');
    expect(
      (
        await createHistoryApi(respond(200, { ok: true, status: 'ok' })).page(ALICE, {
          cursor: null,
          limit: 20,
        })
      ).kind,
    ).toBe('failed');
    expect(
      (
        await createHistoryApi(
          respond(409, {
            schema: 'lexaegis.history-error.v1',
            status: 'history_reset_required',
            reason: 'ANCHOR_CHANGED',
          }),
        ).page(ALICE, { cursor: 'x', limit: 20 })
      ).kind,
    ).toBe('reset');
    expect(
      await createHistoryApi(
        respond(503, { ok: false, health: health({ availability: 'unavailable' }) }),
      ).page(ALICE, { cursor: null, limit: 20 }),
    ).toMatchObject({ kind: 'unavailable' });
    expect(
      await createHistoryApi(respond(429, {})).page(ALICE, { cursor: null, limit: 20 }),
    ).toEqual({ kind: 'failed', failure: 'rate_limited' });
    expect(
      await createHistoryApi(() => Promise.reject(new Error('x'))).page(ALICE, {
        cursor: null,
        limit: 20,
      }),
    ).toEqual({ kind: 'failed', failure: 'unavailable' });
  });
  it('puts only public values in URLs', async () => {
    const urls: string[] = [];
    const client = createHistoryApi((u) => {
      urls.push(u);
      return respond(503, {})();
    });
    await client.page(ALICE, { cursor: 'abc', limit: 5 });
    await client.receipt(ALICE, h(2));
    await client.status();
    expect(urls).toEqual([
      `/api/history/reviewers/${ALICE}?limit=5&cursor=abc`,
      `/api/history/receipts/${ALICE}/${h(2)}`,
      '/api/history/status',
    ]);
  });
});

describe('presentation', () => {
  it('states registry activity without legal or identity claims', () => {
    const texts = (['ISSUE', 'REVOKE', 'SUPERSEDE', 'INVALIDATE_NONCE'] as const).map((kind) =>
      describeAction({ ...action(1), kind }),
    );
    expect(texts.join(' ')).not.toMatch(/valid|verified|legal|identity|lawyer|approved/i);
    expect(new Set(texts).size).toBe(4);
  });
  it('labels every indexer state in text', () => {
    expect(indexerLabel(null).text).toBe('Not checked');
    expect(indexerLabel(health()).text).toBe('Caught up');
    expect(
      indexerLabel(health({ freshness: 'catching_up', lag: { sourceLag: '0', confirmedLag: '7' } }))
        .text,
    ).toBe('Catching up (7 blocks behind)');
    expect(
      indexerLabel(health({ availability: 'unavailable', indexConsistency: 'recovering' })).text,
    ).toBe('Recovering');
    expect(
      indexerLabel(health({ availability: 'unavailable', indexConsistency: 'inconsistent' })).text,
    ).toBe('Inconsistent');
    expect(indexerLabel(health({ availability: 'unavailable' })).text).toBe('Unavailable');
    expect(indexerLabel(health({ freshness: 'unknown' })).text).toBe('Coverage unknown');
  });
  it('copies only the five public reference fields', () => {
    const text = receiptReferenceText({
      chainId: '10143',
      registryAddress: a(1),
      reviewer: ALICE,
      commitment: h(2),
    });
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      'schema',
      'chainId',
      'registryAddress',
      'reviewerAddress',
      'commitment',
    ]);
  });
});
