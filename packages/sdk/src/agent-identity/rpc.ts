import type { Hex } from 'viem';
import { TransientError, type LiveBudget } from '../registry/budget';
import { parseRpcEndpoint, RpcError, type FetchLike } from '../registry/rpc-client';
import type { LiveBlock } from '../registry/live-reader';

/*
 * A read-only JSON-RPC transport for agent-identity checks. Five methods only: eth_chainId,
 * eth_getBlockByNumber, eth_getCode, eth_getStorageAt and eth_call (whose revert data is kept,
 * because ERC-8004's known "no such agent" answer arrives as a revert). No cookies, credentials,
 * redirects, referrer, CCIP-read, multicall or hidden retry: every attempt goes through the budget.
 */

export type ReadOutcome =
  | { readonly kind: 'ok'; readonly data: Hex }
  | { readonly kind: 'revert'; readonly data: Hex | null };

export interface AgentIdentityChainClient {
  getChainId(): Promise<number>;
  getBlock(
    selector: { readonly blockTag: 'finalized' } | { readonly blockNumber: bigint },
  ): Promise<LiveBlock | null>;
  getCode(args: { readonly address: Hex; readonly blockNumber: bigint }): Promise<Hex | undefined>;
  getStorageAt(args: {
    readonly address: Hex;
    readonly slot: Hex;
    readonly blockNumber: bigint;
  }): Promise<Hex | undefined>;
  read(args: {
    readonly to: Hex;
    readonly data: Hex;
    readonly blockNumber: bigint;
  }): Promise<ReadOutcome>;
}

const quantity = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const hex = /^0x(?:[0-9a-f]{2})*$/;
const toQuantity = (value: bigint): string => `0x${value.toString(16)}`;

/**
 * Builds the read-only transport the resolver uses (five methods, revert data kept). Throws on an
 * invalid endpoint.
 *
 * @example
 * ```ts
 * import { createAgentIdentityRpcClient } from '@lexaegis/sdk/agent-identity';
 * import { LiveBudget } from '@lexaegis/sdk/verify';
 *
 * const budget = new LiveBudget({ totalMs: 10_000 });
 * const client = createAgentIdentityRpcClient({ url: 'https://rpc.example.invalid/', budget });
 * budget.dispose();
 * ```
 */
export function createAgentIdentityRpcClient(options: {
  readonly url: string;
  readonly budget: LiveBudget;
  readonly fetch?: FetchLike;
  readonly allowLoopbackHttp?: boolean;
}): AgentIdentityChainClient {
  const endpoint = parseRpcEndpoint(options.url, {
    allowLoopbackHttp: options.allowLoopbackHttp === true,
  });
  if (!endpoint.ok) throw new RpcError('shape');
  const url = endpoint.url;
  let nextId = 1;

  async function call(method: string, params: readonly unknown[]): Promise<unknown> {
    const id = nextId++;
    return options.budget.run(async (signal) => {
      let response: Response;
      try {
        response = await (options.fetch ?? ((input, init) => fetch(input, init)))(url, {
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
      } catch {
        if (signal.aborted) throw new Error('aborted');
        throw new TransientError();
      }
      if (response.status === 429 || response.status >= 500) throw new TransientError();
      if (!response.ok || response.redirected) throw new RpcError('http');
      const text = await response.text();
      if (text.length > 1024 * 1024) throw new RpcError('shape');
      let body: { id?: unknown; result?: unknown; error?: { code?: number; data?: unknown } };
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        throw new RpcError('shape');
      }
      if (body.id !== id) throw new RpcError('shape');
      if (body.error !== undefined) {
        if (body.error.code === -32005) throw new TransientError();
        if (method === 'eth_call') {
          const data = body.error.data;
          throw new Revert(typeof data === 'string' && hex.test(data) ? (data as Hex) : null);
        }
        throw new RpcError('rpc');
      }
      return body.result;
    });
  }

  return {
    async getChainId() {
      const value = await call('eth_chainId', []);
      if (typeof value !== 'string' || !quantity.test(value)) throw new RpcError('shape');
      return Number(BigInt(value));
    },
    async getBlock(selector) {
      const tag = 'blockTag' in selector ? selector.blockTag : toQuantity(selector.blockNumber);
      const value = (await call('eth_getBlockByNumber', [tag, false])) as {
        number?: unknown;
        hash?: unknown;
        timestamp?: unknown;
      } | null;
      if (value === null) return null;
      if (
        typeof value.number !== 'string' ||
        !quantity.test(value.number) ||
        typeof value.hash !== 'string' ||
        !/^0x[0-9a-f]{64}$/.test(value.hash) ||
        typeof value.timestamp !== 'string' ||
        !quantity.test(value.timestamp)
      ) {
        throw new RpcError('shape');
      }
      return {
        number: BigInt(value.number),
        hash: value.hash as Hex,
        timestamp: BigInt(value.timestamp),
      };
    },
    async getCode({ address, blockNumber }) {
      const value = await call('eth_getCode', [address, toQuantity(blockNumber)]);
      if (typeof value !== 'string' || !hex.test(value)) throw new RpcError('shape');
      return value as Hex;
    },
    async getStorageAt({ address, slot, blockNumber }) {
      const value = await call('eth_getStorageAt', [address, slot, toQuantity(blockNumber)]);
      if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) throw new RpcError('shape');
      return value as Hex;
    },
    async read({ to, data, blockNumber }) {
      try {
        const value = await call('eth_call', [{ to, data }, toQuantity(blockNumber)]);
        if (typeof value !== 'string' || !hex.test(value)) throw new RpcError('shape');
        return { kind: 'ok', data: value as Hex };
      } catch (error) {
        if (error instanceof Revert) return { kind: 'revert', data: error.data };
        throw error;
      }
    },
  };
}

class Revert extends Error {
  constructor(readonly data: Hex | null) {
    super('REVERT');
  }
}
