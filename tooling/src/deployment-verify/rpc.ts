import { z } from 'zod';

/*
 * Read-only JSON-RPC for the deployment check. Five read methods, nothing else: there is no code
 * path that signs, sends or estimates a transaction. Limits: 10 seconds per call, one retry of a
 * transient failure, 60 seconds for the whole live check. Importing this module makes no request.
 */

export const READ_METHODS = [
  'eth_chainId',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
] as const;
export type ReadMethod = (typeof READ_METHODS)[number];

export const LIVE_LIMITS = Object.freeze({ callMs: 10_000, transientRetries: 1, totalMs: 60_000 });

export class RpcUnavailable extends Error {
  constructor(
    readonly code: 'RPC_UNAVAILABLE' | 'RPC_MALFORMED' | 'BUDGET_EXCEEDED' | 'RPC_ENDPOINT_INVALID',
  ) {
    super(code);
    this.name = 'RpcUnavailable';
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RpcReader {
  /** Origin only: never a path, query or credential. */
  readonly endpoint: string;
  /** Every method sent, in order, for the no-write assertion and the evidence record. */
  readonly methods: ReadMethod[];
  call(method: ReadMethod, params: readonly unknown[]): Promise<unknown>;
}

const responseSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: z.number(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number() }).optional(),
});

export function createRpcReader(options: {
  readonly url: string;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  /** Loopback HTTP is for local test chains only. */
  readonly allowLoopbackHttp?: boolean;
  readonly limits?: {
    readonly callMs: number;
    readonly transientRetries: number;
    readonly totalMs: number;
  };
}): RpcReader {
  let parsed: URL;
  try {
    parsed = new URL(options.url);
  } catch {
    throw new RpcUnavailable('RPC_ENDPOINT_INVALID');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  const secure =
    parsed.protocol === 'https:' ||
    (options.allowLoopbackHttp === true && loopback && parsed.protocol === 'http:');
  if (!secure || parsed.username !== '' || parsed.password !== '')
    throw new RpcUnavailable('RPC_ENDPOINT_INVALID');

  // Stricter limits may be supplied; looser ones are clamped to the documented ceiling.
  const limits = {
    callMs: Math.min(options.limits?.callMs ?? LIVE_LIMITS.callMs, LIVE_LIMITS.callMs),
    transientRetries: Math.min(
      options.limits?.transientRetries ?? LIVE_LIMITS.transientRetries,
      LIVE_LIMITS.transientRetries,
    ),
    totalMs: Math.min(options.limits?.totalMs ?? LIVE_LIMITS.totalMs, LIVE_LIMITS.totalMs),
  };
  const now = options.now ?? (() => Date.now());
  const methods: ReadMethod[] = [];
  let startedAt: number | null = null;
  let nextId = 1;

  async function attempt(method: ReadMethod, params: readonly unknown[]): Promise<unknown> {
    const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
    const id = nextId;
    nextId += 1;
    const response = await send(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(limits.callMs),
    });
    if (response.status === 429 || response.status >= 500)
      throw new RpcUnavailable('RPC_UNAVAILABLE');
    if (!response.ok) throw new RpcUnavailable('RPC_MALFORMED');
    const body = responseSchema.safeParse(await response.json());
    if (!body.success || body.data.id !== id) throw new RpcUnavailable('RPC_MALFORMED');
    if (body.data.error !== undefined) throw new RpcUnavailable('RPC_UNAVAILABLE');
    if (!('result' in body.data)) throw new RpcUnavailable('RPC_MALFORMED');
    return body.data.result;
  }

  return {
    endpoint: parsed.origin,
    methods,
    async call(method, params) {
      if (!(READ_METHODS as readonly string[]).includes(method))
        throw new RpcUnavailable('RPC_MALFORMED');
      startedAt ??= now();
      for (let tries = 0; ; tries += 1) {
        if (now() - startedAt > limits.totalMs) throw new RpcUnavailable('BUDGET_EXCEEDED');
        methods.push(method);
        try {
          return await attempt(method, params);
        } catch (error) {
          // A malformed answer is not retried: asking again cannot make it trustworthy.
          const transient = !(error instanceof RpcUnavailable) || error.code === 'RPC_UNAVAILABLE';
          if (!transient) throw error;
          if (tries >= limits.transientRetries) throw new RpcUnavailable('RPC_UNAVAILABLE');
        }
      }
    },
  };
}
