import type {
  ChainEvent,
  IndexedAction,
  IndexedReceipt,
  PendingSupersession,
  RegistryState,
  ReviewerSummary,
} from 'envio';

export type {
  ChainEvent,
  IndexedAction,
  IndexedReceipt,
  PendingSupersession,
  RegistryState,
  ReviewerSummary,
};

export const ZERO_HASH = `0x${'0'.repeat(64)}`;
export const UINT256_MAX = (1n << 256n) - 1n;

/** Bounded, public error codes. Messages never contain payloads. */
export const INTEGRITY_CODES = [
  'WRONG_CHAIN',
  'WRONG_REGISTRY',
  'INVALID_PARAMETER',
  'TIMESTAMP_MISMATCH',
  'EVENT_ORDER_REGRESSION',
  'EVENT_CONFLICT',
  'CONFIG_CHANGED',
  'GENERATION_INVALID',
  'NONCE_DISCONTINUITY',
  'RECEIPT_MISSING',
  'RECEIPT_EXISTS',
  'LIFECYCLE_INVALID',
  'PENDING_MISSING',
  'PENDING_CONFLICT',
  'PAIRED_LOGS_MISMATCH',
  'COUNTER_INVARIANT',
] as const;
export type IntegrityCode = (typeof INTEGRITY_CODES)[number];

export class IntegrityError extends Error {
  readonly code: IntegrityCode;
  readonly position: string;
  constructor(code: IntegrityCode, position: string) {
    super(`INTEGRITY_FAILURE ${code} at ${position}`);
    this.name = 'IntegrityError';
    this.code = code;
    this.position = position;
  }
}

export type EventKindName = ChainEvent['kind'];

/** A decoded, lowercase, validated registry log. */
export interface NormalizedEvent {
  readonly kind: EventKindName;
  readonly chainId: string;
  readonly srcAddress: string;
  readonly reviewer: string;
  /** Issued/Revoked: commitment. Superseded: previous commitment. Nonce events: zero hash. */
  readonly commitment: string;
  /** Issued: predecessor. Superseded: replacement. Otherwise zero hash. */
  readonly relatedCommitment: string;
  readonly nonce: bigint;
  readonly newNonce: bigint | undefined;
  readonly eventTimestamp: bigint;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly blockTimestamp: bigint;
  readonly transactionHash: string;
  readonly executor: string;
  readonly logIndex: number;
}

/** What a handler context offers for one entity: reads and last-write-wins sets. */
export interface Table<T extends { readonly id: string }> {
  readonly get: (id: string) => Promise<T | undefined>;
  readonly set: (entity: T) => void;
}

export interface Tables {
  readonly RegistryState: Table<RegistryState>;
  readonly ReviewerSummary: Table<ReviewerSummary>;
  readonly IndexedReceipt: Table<IndexedReceipt>;
  readonly IndexedAction: Table<IndexedAction>;
  readonly ChainEvent: Table<ChainEvent>;
  readonly PendingSupersession: Table<PendingSupersession>;
}

/** Everything one transition reads. Loaded before any write. */
export interface Snapshot {
  readonly registry: RegistryState;
  readonly summary: ReviewerSummary;
  readonly existingEvent: ChainEvent | undefined;
  readonly receipt: IndexedReceipt | undefined;
  /** Issued: the replacement. Superseded: the replacement. */
  readonly relatedReceipt: IndexedReceipt | undefined;
  readonly pending: PendingSupersession | undefined;
  readonly issuedEvent: ChainEvent | undefined;
}

/** A complete transition, computed before any entity is written. */
export interface Transition {
  readonly noop: boolean;
  readonly registry: RegistryState;
  readonly summary: ReviewerSummary | undefined;
  readonly receipts: readonly IndexedReceipt[];
  readonly action: IndexedAction | undefined;
  readonly events: readonly ChainEvent[];
  readonly pending: PendingSupersession | undefined;
}
