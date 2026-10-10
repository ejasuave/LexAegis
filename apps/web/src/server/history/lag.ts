import type { HistoryReason } from './schemas';

export type Freshness = 'caught_up' | 'catching_up' | 'unknown';

const big = (value: string | null): bigint | null => (value === null ? null : BigInt(value));
const diff = (a: bigint | null, b: bigint | null): string | null =>
  a === null || b === null ? null : (a > b ? a - b : 0n).toString();

export interface LagInput {
  readonly progressBlock: string | null;
  readonly sourceBlock: string | null;
  readonly liveCheckpointBlock: string | null;
  /** True only when the index state is coherent and was observed in this request. */
  readonly coherent: boolean;
}

export interface Lag {
  readonly sourceLag: string | null;
  readonly confirmedLag: string | null;
  readonly freshness: Freshness;
  readonly reasons: readonly HistoryReason[];
}

/**
 * sourceLag = max(0, sourceBlock - progressBlock); confirmedLag = max(0, checkpoint - progressBlock).
 * caught_up needs both known and zero on coherent coverage. The last event block is never an
 * input: an old last event does not mean the indexer has stalled.
 */
export function computeLag(input: LagInput): Lag {
  const progress = big(input.progressBlock);
  const sourceLag = diff(big(input.sourceBlock), progress);
  const confirmedLag = diff(big(input.liveCheckpointBlock), progress);
  const reasons: HistoryReason[] = [];
  if (sourceLag === null) reasons.push('INDEX_COVERAGE_UNKNOWN');
  if (confirmedLag === null) reasons.push('LIVE_CHECKPOINT_UNAVAILABLE');
  if (sourceLag !== null && sourceLag !== '0') reasons.push('SOURCE_BEHIND');
  if (confirmedLag !== null && confirmedLag !== '0') reasons.push('CONFIRMED_BEHIND');
  let freshness: Freshness = 'unknown';
  if (sourceLag !== null && confirmedLag !== null && input.coherent) {
    freshness = sourceLag === '0' && confirmedLag === '0' ? 'caught_up' : 'catching_up';
  } else if (
    (sourceLag !== null && sourceLag !== '0') ||
    (confirmedLag !== null && confirmedLag !== '0')
  ) {
    freshness = input.coherent ? 'catching_up' : 'unknown';
  }
  return { sourceLag, confirmedLag, freshness, reasons };
}
