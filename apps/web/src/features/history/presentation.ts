import type { HistoryAction, HistoryHealth } from '@/domain/history/response';

/** Plain-language descriptions. They state registry activity only: no legal or identity claim. */
export function describeAction(action: HistoryAction): string {
  switch (action.kind) {
    case 'ISSUE':
      return 'Receipt issued';
    case 'REVOKE':
      return 'Receipt revoked';
    case 'SUPERSEDE':
      return 'Receipt replaced by a newer version';
    case 'INVALIDATE_NONCE':
      return 'Pending authorisations cancelled';
  }
}

const EXPLORER = 'https://testnet.monadvision.com';
export const explorerTxUrl = (hash: string): string => `${EXPLORER}/tx/${hash}`;

export interface IndexerLabel {
  readonly text: string;
  /** Always present so state never depends on colour alone. */
  readonly tone: 'ok' | 'warn' | 'bad' | 'muted';
}

/** The indexer reading for the system strip. Not a verification result. */
export function indexerLabel(health: HistoryHealth | null): IndexerLabel {
  if (health === null) return { text: 'Not checked', tone: 'muted' };
  if (health.availability === 'unavailable') {
    if (health.indexConsistency === 'recovering') return { text: 'Recovering', tone: 'warn' };
    if (health.indexConsistency === 'inconsistent') return { text: 'Inconsistent', tone: 'bad' };
    return { text: 'Unavailable', tone: 'bad' };
  }
  if (health.freshness === 'caught_up') return { text: 'Caught up', tone: 'ok' };
  if (health.freshness === 'catching_up') {
    const lag = health.lag.confirmedLag ?? health.lag.sourceLag;
    return {
      text: lag === null ? 'Catching up' : `Catching up (${lag} blocks behind)`,
      tone: 'warn',
    };
  }
  return { text: 'Coverage unknown', tone: 'warn' };
}

/** Copyable public receipt reference text: the five public fields and nothing else. */
export function receiptReferenceText(args: {
  readonly chainId: string;
  readonly registryAddress: string;
  readonly reviewer: string;
  readonly commitment: string;
}): string {
  return JSON.stringify({
    schema: 'lexaegis.receipt-ref.v1',
    chainId: args.chainId,
    registryAddress: args.registryAddress,
    reviewerAddress: args.reviewer,
    commitment: args.commitment,
  });
}
