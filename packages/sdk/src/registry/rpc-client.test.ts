import { describe, expect, it } from 'vitest';
import { LiveBudget, BudgetError } from './budget';
import { createRpcLiveClient, parseRpcEndpoint, type FetchLike } from './rpc-client';

const URL_OK = 'https://rpc.example.test/';

const reply = (result: unknown, id: number, status = 200): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function recorder(
  handler: (method: string, params: unknown[], id: number) => Response | Promise<Response>,
) {
  const requests: { url: string; init: RequestInit; method: string; params: unknown[] }[] = [];
  const fetchLike: FetchLike = async (url, init) => {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as {
      id: number;
      method: string;
      params: unknown[];
    };
    requests.push({ url, init, method: body.method, params: body.params });
    return handler(body.method, body.params, body.id);
  };
  return { fetchLike, requests };
}

describe('endpoint validation', () => {
  it('accepts a public HTTPS endpoint and nothing that could carry a credential', () => {
    expect(parseRpcEndpoint(URL_OK)).toMatchObject({
      ok: true,
      origin: 'https://rpc.example.test',
    });
    for (const [value, error] of [
      ['http://rpc.example.test/', 'NOT_HTTPS'],
      ['https://user:pass@rpc.example.test/', 'HAS_CREDENTIALS'],
      ['https://rpc.example.test/?key=abc', 'HAS_QUERY_OR_FRAGMENT'],
      ['https://rpc.example.test/#abc', 'HAS_QUERY_OR_FRAGMENT'],
      ['not a url', 'MALFORMED_URL'],
      ['ws://rpc.example.test', 'NOT_HTTPS'],
    ] as const) {
      expect(parseRpcEndpoint(value), value).toEqual({ ok: false, error });
    }
  });

  it('allows loopback HTTP only when a test explicitly asks for it', () => {
    expect(parseRpcEndpoint('http://127.0.0.1:8545/').ok).toBe(false);
    expect(parseRpcEndpoint('http://127.0.0.1:8545/', { allowLoopbackHttp: true }).ok).toBe(true);
    expect(parseRpcEndpoint('http://rpc.example.test/', { allowLoopbackHttp: true }).ok).toBe(
      false,
    );
  });

  it('refuses to build a client for an invalid endpoint', () => {
    const budget = new LiveBudget();
    expect(() => createRpcLiveClient({ url: 'http://rpc.example.test/', budget })).toThrow();
    budget.dispose();
  });
});

describe('JSON-RPC transport', () => {
  it('sends only public parameters with no cookies, no redirects and no referrer', async () => {
    const { fetchLike, requests } = recorder((method, _params, id) =>
      reply(method === 'eth_chainId' ? '0x7a69' : '0x', id),
    );
    const budget = new LiveBudget();
    const client = createRpcLiveClient({ url: URL_OK, budget, fetch: fetchLike });
    expect(await client.getChainId()).toBe(31337);
    await client.getCode({ address: `0x${'ab'.repeat(20)}`, blockNumber: 12n });
    expect(requests.map((request) => request.method)).toEqual(['eth_chainId', 'eth_getCode']);
    for (const request of requests) {
      expect(request.url).toBe(URL_OK);
      expect(request.init).toMatchObject({
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
      expect(request.init.headers).not.toHaveProperty('authorization');
    }
    expect(requests[1]?.params).toEqual([`0x${'ab'.repeat(20)}`, '0xc']);
    budget.dispose();
  });

  it('reads blocks by tag and number and validates every response shape', async () => {
    const block = { number: '0x61', hash: `0x${'11'.repeat(32)}`, timestamp: '0x10', extra: 1 };
    const { fetchLike, requests } = recorder((_method, params, id) =>
      reply(params[0] === '0x999' ? null : block, id),
    );
    const budget = new LiveBudget();
    const client = createRpcLiveClient({ url: URL_OK, budget, fetch: fetchLike });
    expect(await client.getBlock({ blockTag: 'finalized' })).toEqual({
      number: 97n,
      hash: `0x${'11'.repeat(32)}`,
      timestamp: 16n,
    });
    expect(await client.getBlock({ blockNumber: 0x999n })).toBeNull();
    expect(requests[0]?.params).toEqual(['finalized', false]);
    const bad = recorder((_m, _p, id) => reply({ number: 'not-hex' }, id));
    const other = createRpcLiveClient({ url: URL_OK, budget, fetch: bad.fetchLike });
    await expect(other.getBlock({ blockTag: 'latest' })).rejects.toThrow();
    budget.dispose();
  });

  it('rejects a mismatched response id, a redirect and an RPC error', async () => {
    const budget = new LiveBudget();
    const wrongId = createRpcLiveClient({
      url: URL_OK,
      budget,
      fetch: recorder((_m, _p, id) => reply('0x1', id + 1)).fetchLike,
    });
    await expect(wrongId.getChainId()).rejects.toThrow();
    const error = createRpcLiveClient({
      url: URL_OK,
      budget,
      fetch: recorder(
        (_m, _p, id) =>
          new Response(
            JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'secret' } }),
          ),
      ).fetchLike,
    });
    await expect(error.getChainId()).rejects.toThrow();
    const redirected = createRpcLiveClient({
      url: URL_OK,
      budget,
      fetch: () => Promise.reject(new TypeError('redirect mode is set to error')),
    });
    await expect(redirected.getChainId()).rejects.toThrow();
    budget.dispose();
  });

  it('retries one transient failure and no more', async () => {
    let attempts = 0;
    const flaky = recorder((_m, _p, id) =>
      ++attempts === 1 ? new Response('busy', { status: 503 }) : reply('0x1', id),
    );
    const budget = new LiveBudget();
    const client = createRpcLiveClient({ url: URL_OK, budget, fetch: flaky.fetchLike });
    expect(await client.getChainId()).toBe(1);
    expect(flaky.requests).toHaveLength(2);
    const down = recorder(() => new Response('busy', { status: 503 }));
    const other = createRpcLiveClient({ url: URL_OK, budget, fetch: down.fetchLike });
    await expect(other.getChainId()).rejects.toThrow();
    expect(down.requests).toHaveLength(2);
    budget.dispose();
  });
});

describe('live budget', () => {
  it('never exceeds four concurrent reads', async () => {
    const budget = new LiveBudget();
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        budget.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 5));
          running -= 1;
        }),
      ),
    );
    expect(peak).toBe(4);
    budget.dispose();
  });

  it('stops at 64 attempts and cannot be loosened past the documented limits', async () => {
    const budget = new LiveBudget({ maxAttempts: 10_000, totalMs: 10 * 60_000, concurrency: 99 });
    for (let index = 0; index < 64; index += 1) await budget.run(() => Promise.resolve(index));
    await expect(budget.run(() => Promise.resolve(0))).rejects.toMatchObject({
      failure: 'ATTEMPTS',
    });
    expect(budget.attempts).toBe(64);
    budget.dispose();
  });

  it('times out one read at the per-read limit and reports it', async () => {
    const budget = new LiveBudget({ perReadMs: 20 });
    const never = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await expect(budget.run(never)).rejects.toMatchObject({ failure: 'TIMEOUT' });
    expect(budget.lastFailure).toBe('TIMEOUT');
    budget.dispose();
  });

  it('cancels in-flight and queued reads on abort and on dispose', async () => {
    const controller = new AbortController();
    const budget = new LiveBudget({}, controller.signal);
    const wait = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const reads = Array.from({ length: 6 }, () => budget.run(wait));
    setTimeout(() => controller.abort(), 10);
    for (const read of reads) await expect(read).rejects.toBeInstanceOf(BudgetError);
    expect(budget.lastFailure).toBe('ABORTED');
    budget.dispose();
  });
});
