import { describe, expect, it } from 'vitest';
import {
  LIVE_LIMITS,
  READ_METHODS,
  RpcUnavailable,
  createRpcReader,
  type FetchLike,
  type ReadMethod,
} from './rpc';

/* UNIT CASES WITH A STUBBED fetch. No request leaves the process. */

const ok =
  (result: unknown): FetchLike =>
  (_url, init) =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: (JSON.parse(init.body as string) as { id: number }).id,
          result,
        }),
      ),
    );

describe('read-only RPC reader', () => {
  it('documents its limits: 10 s per call, one transient retry, 60 s in total', () => {
    expect(LIVE_LIMITS).toEqual({ callMs: 10_000, transientRetries: 1, totalMs: 60_000 });
  });
  it('sends only the five read methods and reports the origin, never the path or a key', async () => {
    const seen: { url: string; body: { method: string }; init: RequestInit }[] = [];
    const reader = createRpcReader({
      url: 'https://rpc.example.invalid/v2/key-shaped-path-segment',
      fetch: (url, init) => {
        seen.push({ url, body: JSON.parse(init.body as string) as { method: string }, init });
        return ok('0x279f')(url, init);
      },
    });
    expect(reader.endpoint).toBe('https://rpc.example.invalid');
    expect(await reader.call('eth_chainId', [])).toBe('0x279f');
    expect(seen[0]?.init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' });
    await expect(
      reader.call('eth_sendRawTransaction' as ReadMethod, ['0x00']),
    ).rejects.toMatchObject({ code: 'RPC_MALFORMED' });
    await expect(reader.call('eth_sign' as ReadMethod, [])).rejects.toBeInstanceOf(RpcUnavailable);
    expect(seen.map((item) => item.body.method)).toEqual(['eth_chainId']);
    expect(READ_METHODS.some((method) => /send|sign|estimate/i.test(method))).toBe(false);
  });
  it('refuses a non-HTTPS endpoint and credentials in the address', () => {
    expect(() => createRpcReader({ url: 'http://rpc.example.invalid/' })).toThrow(RpcUnavailable);
    expect(() =>
      createRpcReader({ url: ['https://', 'user', ':', 'word', '@rpc.example.invalid/'].join('') }),
    ).toThrow(RpcUnavailable);
    expect(() => createRpcReader({ url: 'not a url' })).toThrow(RpcUnavailable);
    expect(() =>
      createRpcReader({ url: 'http://127.0.0.1:8545/', allowLoopbackHttp: true }),
    ).not.toThrow();
    expect(() => createRpcReader({ url: 'http://127.0.0.1:8545/' })).toThrow(RpcUnavailable);
  });
  it('retries one transient failure and no more', async () => {
    let calls = 0;
    const flaky: FetchLike = (url, init) => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('socket')) : ok('0x1')(url, init);
    };
    const reader = createRpcReader({ url: 'https://rpc.example.invalid/', fetch: flaky });
    expect(await reader.call('eth_chainId', [])).toBe('0x1');
    expect(reader.methods).toEqual(['eth_chainId', 'eth_chainId']);

    let attempts = 0;
    const down = createRpcReader({
      url: 'https://rpc.example.invalid/',
      fetch: () => {
        attempts += 1;
        return Promise.resolve(new Response('busy', { status: 503 }));
      },
    });
    await expect(down.call('eth_chainId', [])).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE' });
    expect(attempts).toBe(2);
  });
  it('does not retry a malformed answer or a mismatched id', async () => {
    let attempts = 0;
    const reader = createRpcReader({
      url: 'https://rpc.example.invalid/',
      fetch: () => {
        attempts += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: '2.0', id: 999, result: '0x1' })),
        );
      },
    });
    await expect(reader.call('eth_chainId', [])).rejects.toMatchObject({ code: 'RPC_MALFORMED' });
    expect(attempts).toBe(1);
    const html = createRpcReader({
      url: 'https://rpc.example.invalid/',
      fetch: () => Promise.resolve(new Response('<html>', { status: 200 })),
    });
    await expect(html.call('eth_chainId', [])).rejects.toBeInstanceOf(Error);
  });
  it('stops at the total budget and cannot be given looser limits', async () => {
    let clock = 0;
    const reader = createRpcReader({
      url: 'https://rpc.example.invalid/',
      now: () => clock,
      limits: { callMs: 999_999, transientRetries: 50, totalMs: 999_999 },
      fetch: (url, init) => {
        clock += 25_000;
        return ok('0x1')(url, init);
      },
    });
    await reader.call('eth_chainId', []); // 25 s
    await reader.call('eth_chainId', []); // 50 s
    await reader.call('eth_chainId', []); // 75 s: started within the budget
    await expect(reader.call('eth_chainId', [])).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });

    let attempts = 0;
    const noExtraRetries = createRpcReader({
      url: 'https://rpc.example.invalid/',
      limits: { callMs: 1, transientRetries: 50, totalMs: 1 },
      now: () => 0,
      fetch: () => {
        attempts += 1;
        return Promise.reject(new Error('socket'));
      },
    });
    await expect(noExtraRetries.call('eth_chainId', [])).rejects.toMatchObject({
      code: 'RPC_UNAVAILABLE',
    });
    expect(attempts).toBe(2);
  });
});
