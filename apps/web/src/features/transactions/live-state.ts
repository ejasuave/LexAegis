/*
 * Read-only client for the latest registry state of one receipt and the reviewer's action nonce
 * (/api/chain/state). It is a provider observation at one identified block: not confirmed, not
 * finalised, and never produced by the indexer. Failure is "unknown", never a guess.
 */

export type ReceiptLifecycle = 'not_found' | 'active' | 'revoked' | 'superseded';

export type LiveState =
  | {
      readonly status: 'ok';
      readonly blockNumber: string;
      readonly blockTimestamp: string;
      /** ISO time the server read the state. Preflight freshness is judged from this. */
      readonly observedAt: string;
      readonly registryNonce: string;
      readonly receiptLifecycle: ReceiptLifecycle;
    }
  | { readonly status: 'unknown'; readonly reason: string };

export type LiveStateReader = (reviewer: string, commitment: string) => Promise<LiveState>;

const LIFECYCLES: readonly string[] = ['not_found', 'active', 'revoked', 'superseded'];
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;

export function parseLiveState(value: unknown): LiveState {
  if (typeof value !== 'object' || value === null) return { status: 'unknown', reason: 'INVALID' };
  const v = value as Record<string, unknown>;
  if (v.status !== 'ok') {
    return { status: 'unknown', reason: typeof v.reason === 'string' ? v.reason : 'UNKNOWN' };
  }
  if (
    typeof v.blockNumber === 'string' &&
    DECIMAL.test(v.blockNumber) &&
    typeof v.blockTimestamp === 'string' &&
    DECIMAL.test(v.blockTimestamp) &&
    typeof v.observedAt === 'string' &&
    !Number.isNaN(Date.parse(v.observedAt)) &&
    typeof v.registryNonce === 'string' &&
    DECIMAL.test(v.registryNonce) &&
    typeof v.receiptLifecycle === 'string' &&
    LIFECYCLES.includes(v.receiptLifecycle)
  ) {
    return {
      status: 'ok',
      blockNumber: v.blockNumber,
      blockTimestamp: v.blockTimestamp,
      observedAt: v.observedAt,
      registryNonce: v.registryNonce,
      receiptLifecycle: v.receiptLifecycle as ReceiptLifecycle,
    };
  }
  return { status: 'unknown', reason: 'INVALID' };
}

export function createLiveStateReader(fetchFn: typeof fetch = fetch): LiveStateReader {
  return async (reviewer, commitment) => {
    try {
      const response = await fetchFn(`/api/chain/state/${reviewer}/${commitment}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) return { status: 'unknown', reason: 'HTTP' };
      return parseLiveState(await response.json());
    } catch {
      // The request may not have reached the server: the state is unknown, not "absent".
      return { status: 'unknown', reason: 'NETWORK' };
    }
  };
}

/** The confirmed-checkpoint reading of a receipt (/api/chain/receipts), with its as-of block. */
export type ConfirmedLifecycle =
  | {
      readonly status: 'ok';
      readonly receiptLifecycle: ReceiptLifecycle;
      readonly blockNumber: string;
      readonly blockTimestamp: string;
      readonly observedAt: string;
    }
  | { readonly status: 'unknown'; readonly reason: string };

export function parseConfirmedLifecycle(value: unknown): ConfirmedLifecycle {
  if (typeof value !== 'object' || value === null) return { status: 'unknown', reason: 'INVALID' };
  const v = value as {
    status?: unknown;
    reason?: unknown;
    receipt?: unknown;
    checkpoint?: unknown;
  };
  if (v.status !== 'ok') {
    return { status: 'unknown', reason: typeof v.reason === 'string' ? v.reason : 'UNKNOWN' };
  }
  const receipt = v.receipt as { receiptLifecycle?: unknown } | null;
  const checkpoint = v.checkpoint as {
    blockNumber?: unknown;
    blockTimestamp?: unknown;
    observedAt?: unknown;
  } | null;
  if (
    receipt !== null &&
    typeof receipt === 'object' &&
    typeof receipt.receiptLifecycle === 'string' &&
    LIFECYCLES.includes(receipt.receiptLifecycle) &&
    checkpoint !== null &&
    typeof checkpoint === 'object' &&
    typeof checkpoint.blockNumber === 'string' &&
    DECIMAL.test(checkpoint.blockNumber) &&
    typeof checkpoint.blockTimestamp === 'string' &&
    typeof checkpoint.observedAt === 'string'
  ) {
    return {
      status: 'ok',
      receiptLifecycle: receipt.receiptLifecycle as ReceiptLifecycle,
      blockNumber: checkpoint.blockNumber,
      blockTimestamp: checkpoint.blockTimestamp,
      observedAt: checkpoint.observedAt,
    };
  }
  return { status: 'unknown', reason: 'INVALID' };
}

export async function readConfirmedLifecycle(
  reviewer: string,
  commitment: string,
  fetchFn: typeof fetch = fetch,
): Promise<ConfirmedLifecycle> {
  try {
    const response = await fetchFn(`/api/chain/receipts/${reviewer}/${commitment}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return response.ok
      ? parseConfirmedLifecycle(await response.json())
      : { status: 'unknown', reason: 'HTTP' };
  } catch {
    return { status: 'unknown', reason: 'NETWORK' };
  }
}
