import { z } from 'zod';
import type { Hex } from 'viem';
import { TransientError, type LiveBudget } from './budget';
import type { LiveBlock, LiveChainClient } from './live-reader';

/*
 * A minimal public JSON-RPC transport for live registry reads. It sends only the four methods the
 * verifier needs, with only the public parameters (addresses, block numbers, call data built from
 * a reviewer address and commitment). It never sends an opening, files or plain artifact hashes.
 * No cookies or credentials, no redirects, no CCIP-read, no multicall, no hidden retry: every
 * attempt goes through the LiveBudget.
 */

export const RPC_METHODS = [
  'eth_chainId',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_call',
] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];

/** Maximum response body the transport will read. */
export const MAX_RPC_RESPONSE_BYTES = 1024 * 1024;

export const RPC_CONFIG_ERRORS = [
  'NOT_HTTPS',
  'HAS_CREDENTIALS',
  'HAS_QUERY_OR_FRAGMENT',
  'MALFORMED_URL',
] as const;
export type RpcConfigError = (typeof RPC_CONFIG_ERRORS)[number];

export type RpcEndpointResult =
  | { readonly ok: true; readonly url: string; readonly origin: string }
  | { readonly ok: false; readonly error: RpcConfigError };

/**
 * Validates a caller-selected public RPC endpoint. HTTPS only (loopback HTTP only when the
 * caller explicitly allows it, for isolated local chains in tests). No user information, query
 * or fragment is accepted, so a credential cannot ride in the URL.
 */
export function parseRpcEndpoint(
  value: string,
  options: { readonly allowLoopbackHttp?: boolean } = {},
): RpcEndpointResult {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: 'MALFORMED_URL' };
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    url.protocol !== 'https:' &&
    !(options.allowLoopbackHttp === true && loopback && url.protocol === 'http:')
  ) {
    return { ok: false, error: 'NOT_HTTPS' };
  }
  if (url.username !== '' || url.password !== '') return { ok: false, error: 'HAS_CREDENTIALS' };
  if (url.search !== '' || url.hash !== '') return { ok: false, error: 'HAS_QUERY_OR_FRAGMENT' };
  return { ok: true, url: url.toString(), origin: url.origin };
}

/** A fetch-compatible function. Defaults to the platform fetch, read only when a request is made. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class RpcError extends Error {
  readonly kind: 'http' | 'rpc' | 'shape' | 'redirect';
  constructor(kind: RpcError['kind']) {
    super(kind);
    this.name = 'RpcError';
    this.kind = kind;
  }
}

const hexQuantity = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/);
const hexData = z.string().regex(/^0x(?:[0-9a-f]{2})*$/);
const hash32 = z.string().regex(/^0x[0-9a-f]{64}$/);

const envelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number() }).loose().optional(),
});

const blockResult = z
  .object({ number: hexQuantity, hash: hash32, timestamp: hexQuantity })
  .loose()
  .nullable();

const toHexNumber = (value: bigint): string => `0x${value.toString(16)}`;

export interface RpcLiveClientOptions {
  readonly url: string;
  readonly budget: LiveBudget;
  readonly fetch?: FetchLike;
  readonly allowLoopbackHttp?: boolean;
}

/** Builds a LiveChainClient over explicit public JSON-RPC. Throws on an invalid endpoint. */
export function createRpcLiveClient(options: RpcLiveClientOptions): LiveChainClient {
  const endpoint = parseRpcEndpoint(options.url, {
    allowLoopbackHttp: options.allowLoopbackHttp === true,
  });
  if (!endpoint.ok) throw new RpcError('shape');
  const endpointUrl = endpoint.url;
  let nextId = 1;

  async function call(method: RpcMethod, params: readonly unknown[]): Promise<unknown> {
    const id = nextId++;
    return options.budget.run(async (signal) => {
      let response: Response;
      try {
        response = await (options.fetch ?? ((input, init) => fetch(input, init)))(endpointUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          mode: 'cors',
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        // A network or CORS failure (and a refused redirect) is indistinguishable here; one retry.
        throw new TransientError();
      }
      if (response.status === 429 || response.status >= 500) throw new TransientError();
      if (!response.ok || response.redirected) throw new RpcError('http');
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(declared) && declared > MAX_RPC_RESPONSE_BYTES)
        throw new RpcError('shape');
      const text = await response.text();
      if (text.length > MAX_RPC_RESPONSE_BYTES) throw new RpcError('shape');
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new RpcError('shape');
      }
      const parsed = envelope.safeParse(body);
      if (!parsed.success || parsed.data.id !== id) throw new RpcError('shape');
      if (parsed.data.error !== undefined) {
        if (parsed.data.error.code === -32005) throw new TransientError();
        throw new RpcError('rpc');
      }
      return parsed.data.result;
    });
  }

  return {
    async getChainId() {
      const value = hexQuantity.safeParse(await call('eth_chainId', []));
      if (!value.success) throw new RpcError('shape');
      return Number(BigInt(value.data));
    },
    async getBlock(selector): Promise<LiveBlock | null> {
      const tag = 'blockTag' in selector ? selector.blockTag : toHexNumber(selector.blockNumber);
      const value = blockResult.safeParse(await call('eth_getBlockByNumber', [tag, false]));
      if (!value.success) throw new RpcError('shape');
      if (value.data === null) return null;
      return {
        number: BigInt(value.data.number),
        hash: value.data.hash as Hex,
        timestamp: BigInt(value.data.timestamp),
      };
    },
    async getCode({ address, blockNumber }) {
      const value = hexData.safeParse(
        await call('eth_getCode', [address, toHexNumber(blockNumber)]),
      );
      if (!value.success) throw new RpcError('shape');
      return value.data as Hex;
    },
    async call({ to, data, blockNumber }) {
      const value = hexData.safeParse(
        await call('eth_call', [
          { to, data },
          blockNumber === undefined ? 'latest' : toHexNumber(blockNumber),
        ]),
      );
      if (!value.success) throw new RpcError('shape');
      return value.data as Hex;
    },
  };
}
