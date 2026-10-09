/**
 * JSON-RPC access restricted to this machine. Everything in the contracts tooling that talks to
 * a node goes through here, so no script or test can reach a public network by accident.
 */
import type { ChainTransport } from '@lexaegis/sdk';
import { z } from 'zod';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Chains that must never be touched by local tooling, even through a loopback tunnel. */
export const PUBLIC_CHAIN_IDS: ReadonlySet<bigint> = new Set([143n, 10143n]);

export class LocalOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalOnlyError';
  }
}

/** Returns the URL unchanged when it is a plain http loopback endpoint; throws otherwise. */
export function assertLoopbackUrl(rpcUrl: string): string {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new LocalOnlyError('The RPC URL is not a valid URL.');
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new LocalOnlyError(
      `Refusing RPC target ${url.host}: only http loopback endpoints (127.0.0.1, localhost, ::1) are allowed.`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new LocalOnlyError('Refusing an RPC URL that carries credentials.');
  }
  return rpcUrl;
}

/** A JSON-RPC error response. `data` carries revert data when the node supplies it. */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

const responseSchema = z.union([
  z.strictObject({ jsonrpc: z.literal('2.0'), id: z.int(), result: z.unknown() }),
  z.strictObject({
    jsonrpc: z.literal('2.0'),
    id: z.int(),
    error: z.strictObject({ code: z.int(), message: z.string(), data: z.unknown().optional() }),
  }),
]);

/** A ChainTransport for a loopback node. A JSON-RPC error rejects with JsonRpcError. */
export function createLocalTransport(rpcUrl: string): ChainTransport {
  const endpoint = assertLoopbackUrl(rpcUrl);
  let nextId = 0;
  return {
    async request(method, params, signal) {
      nextId += 1;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params }),
        ...(signal !== undefined && { signal }),
      });
      const body = responseSchema.parse(await response.json());
      if ('error' in body) {
        throw new JsonRpcError(body.error.code, body.error.message, body.error.data);
      }
      return body.result;
    },
  };
}

const quantitySchema = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/);

/** Reads `eth_chainId` and refuses a public chain, whatever the URL looked like. */
export async function requireLocalChain(transport: ChainTransport): Promise<bigint> {
  const chainId = BigInt(quantitySchema.parse(await transport.request('eth_chainId', [])));
  if (PUBLIC_CHAIN_IDS.has(chainId)) {
    throw new LocalOnlyError(
      `Refusing chain ${chainId}: it is a public network, not a local chain.`,
    );
  }
  return chainId;
}
