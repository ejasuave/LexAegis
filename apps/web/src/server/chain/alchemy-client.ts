import 'server-only';
import { createPublicClient, http, type Hex, type PublicClient } from 'viem';
import { liveClientFromViem, type LiveChainClient } from '@lexaegis/sdk/registry';
import type { MonitorClient } from '@lexaegis/sdk/transactions';
import { loadServerConfig } from '../env';
import { CHAIN, localTestChainRequested } from './config';

/*
 * One server-only viem client with an explicit HTTP transport to the configured Alchemy Monad
 * testnet endpoint. The chain definition carries no default RPC URL, so nothing can silently
 * fall back to a public endpoint. No client-supplied URL, method or header ever reaches it.
 */

const ALCHEMY_HOST = /^monad-testnet\.g\.alchemy\.com$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const TIMEOUT_MS = 8_000;

export interface EndpointCheck {
  readonly ok: boolean;
}

/** HTTPS Alchemy Monad testnet host; plain loopback only when tests explicitly allow it. */
export function isIntendedEndpoint(value: string, allowLoopback = false): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return ALCHEMY_HOST.test(url.hostname);
    return allowLoopback && url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
}

/** Origin only: the path and query of an Alchemy URL may carry the API key. */
export function redactEndpoint(value: string): string {
  try {
    return `${new URL(value).origin}/…`;
  } catch {
    return '[invalid endpoint]';
  }
}

export interface ChainClientOptions {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly allowLoopback?: boolean;
  readonly fetchFn?: typeof fetch;
}

export interface ServerChainClient {
  readonly public: PublicClient;
  readonly live: LiveChainClient;
  readonly monitor: MonitorClient;
  /** Broadcast with no transport retry; identity is reconciled explicitly by the caller. */
  sendRawTransaction(serialized: Hex): Promise<Hex>;
}

export function createChainClient(options: ChainClientOptions): ServerChainClient | null {
  if (!isIntendedEndpoint(options.rpcUrl, options.allowLoopback === true)) return null;
  const chain = {
    id: options.chainId,
    name: CHAIN.name,
    nativeCurrency: { name: CHAIN.currency, symbol: CHAIN.currency, decimals: CHAIN.decimals },
    // Deliberately empty: the transport below is the only endpoint.
    rpcUrls: { default: { http: [] as string[] } },
  };
  const transportOptions = {
    timeout: TIMEOUT_MS,
    retryCount: 2,
    retryDelay: 250,
    ...(options.fetchFn !== undefined && { fetchFn: options.fetchFn }),
  };
  const client = createPublicClient({ chain, transport: http(options.rpcUrl, transportOptions) });
  // Broadcasts and other mutations never retry at the transport layer.
  const mutating = createPublicClient({
    chain,
    transport: http(options.rpcUrl, { ...transportOptions, retryCount: 0 }),
  });
  const live = liveClientFromViem(client);
  const monitor: MonitorClient = {
    ...live,
    async getTransaction(hash) {
      try {
        const tx = await client.getTransaction({ hash });
        return {
          hash: tx.hash,
          from: tx.from,
          to: tx.to ?? null,
          nonce: BigInt(tx.nonce),
          value: tx.value,
          input: tx.input,
          gas: tx.gas,
          blockNumber: (tx as { blockNumber: bigint | null }).blockNumber,
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async getTransactionReceipt(hash) {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        return {
          transactionHash: receipt.transactionHash,
          from: receipt.from,
          to: receipt.to ?? null,
          status: receipt.status,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          effectiveGasPrice: receipt.effectiveGasPrice,
          gasUsed: receipt.gasUsed,
          logs: receipt.logs.map((log) => ({
            address: log.address,
            topics: [...log.topics],
            data: log.data,
          })),
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    getTransactionCount: async (address) => BigInt(await client.getTransactionCount({ address })),
    getBalance: (address, blockNumber) =>
      client.getBalance({ address, ...(blockNumber !== undefined && { blockNumber }) }),
  };
  return {
    public: client,
    live,
    monitor,
    sendRawTransaction: (serialized) =>
      mutating.sendRawTransaction({ serializedTransaction: serialized }),
  };
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  return name === 'TransactionNotFoundError' || name === 'TransactionReceiptNotFoundError';
}

export interface CapabilityReport {
  readonly chainId: boolean;
  readonly blockReads: boolean;
  readonly finalizedTag: boolean;
  readonly historicalState: boolean;
  readonly getCode: boolean;
  readonly feeEstimation: boolean;
  readonly transactionCount: boolean;
}

/** Records what the endpoint actually did. A package import is not evidence of support. */
export async function probeCapabilities(
  client: ServerChainClient,
  registry: Hex | null,
): Promise<CapabilityReport> {
  const attempt = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return true;
    } catch {
      return false;
    }
  };
  const head = await client.public.getBlockNumber().catch(() => null);
  return {
    chainId: await attempt(() => client.public.getChainId()),
    blockReads: head !== null,
    finalizedTag: await attempt(() => client.public.getBlock({ blockTag: 'finalized' })),
    historicalState:
      head !== null &&
      (await attempt(() =>
        client.public.getBalance({
          address: `0x${'00'.repeat(20)}`,
          blockNumber: head > 5n ? head - 5n : 0n,
        }),
      )),
    getCode:
      registry !== null && (await attempt(() => client.public.getCode({ address: registry }))),
    feeEstimation: await attempt(() => client.public.estimateFeesPerGas()),
    transactionCount: await attempt(() =>
      client.public.getTransactionCount({ address: `0x${'00'.repeat(20)}` }),
    ),
  };
}

let cached: ServerChainClient | null | undefined;

/** Missing or wrong configuration returns null; callers map that to a typed unavailable state. */
export function getChainClient(): ServerChainClient | null {
  if (cached !== undefined) return cached;
  const loaded = loadServerConfig(process.env);
  const rpcUrl = loaded.ok ? loaded.config.alchemy.rpcUrl : undefined;
  cached =
    rpcUrl === undefined
      ? null
      : createChainClient({
          rpcUrl,
          chainId: Number(CHAIN.id),
          // Only the Chapter 12 loopback test chain may use a plain-HTTP loopback endpoint.
          allowLoopback: localTestChainRequested(),
        });
  return cached;
}
