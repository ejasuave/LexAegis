import { z } from 'zod';
import {
  prepareReviewPackage,
  type ArtifactBytesInput,
  type PreparedReviewPackage,
  type ProtocolResult,
} from '@lexaegis/protocol/v1';
import {
  bytes32Schema,
  chainIdSchema,
  evmAddressSchema,
  receiptLifecycleSchema,
  rfc3339TimestampSchema,
  unavailable,
  unsignedDecimalSchema,
  type Result,
  type SignerAcceptance,
} from '@lexaegis/protocol';

/** Tuple identifying the intended receipt. A commitment alone is not a global identifier. */
export const receiptLookupSchema = z.strictObject({
  chainId: chainIdSchema,
  registryAddress: evmAddressSchema,
  reviewerAddress: evmAddressSchema,
  commitment: bytes32Schema,
});
export type ReceiptLookup = z.infer<typeof receiptLookupSchema>;

/** Caller-supplied chain transport. The SDK never owns an RPC endpoint or credential. */
export interface ChainTransport {
  request(method: string, params: readonly unknown[], signal?: AbortSignal): Promise<unknown>;
}

/** Caller-owned signer acceptance rule; there is no platform-controlled trust list. */
export type SignerPolicy = (reviewerAddress: string) => SignerAcceptance;

export interface ReceiptReadOptions {
  readonly transport: ChainTransport;
  readonly signerPolicy?: SignerPolicy;
  readonly signal?: AbortSignal;
}

export const receiptStatusSchema = z.strictObject({
  receiptLifecycle: receiptLifecycleSchema,
  observedAt: rfc3339TimestampSchema,
});
export type ReceiptStatus = z.infer<typeof receiptStatusSchema>;

/**
 * Receipt operations. Preparation is implemented (Chapter 2) and is purely local: it captures an
 * immutable, unapproved snapshot and never signs, publishes or approves. Contract reads and
 * submission remain unavailable until their chapters.
 */
export interface ReceiptClient {
  prepare(
    manifestInput: unknown,
    artifactBytesById: ArtifactBytesInput,
  ): Promise<ProtocolResult<PreparedReviewPackage>>;
  readStatus(lookup: ReceiptLookup, options: ReceiptReadOptions): Promise<Result<ReceiptStatus>>;
  submit(input: unknown, signal?: AbortSignal): Promise<Result<never>>;
}

/**
 * A client whose only working operation is local `prepare`. `readStatus` and `submit` return the
 * typed `NOT_IMPLEMENTED` failure by design, never a simulated success: use `verifyReceipt` from
 * `@lexaegis/sdk/verify` for read-only live status, and your own signer and transport to submit.
 *
 * @example
 * ```ts
 * import { createReceiptClient } from '@lexaegis/sdk';
 *
 * const client = createReceiptClient();
 * const status = await client.readStatus(
 *   {
 *     chainId: '10143',
 *     registryAddress: '0x1111111111111111111111111111111111111111',
 *     reviewerAddress: '0x2222222222222222222222222222222222222222',
 *     commitment: `0x${'ab'.repeat(32)}`,
 *   },
 *   { transport: { request: () => Promise.reject(new Error('unused')) } },
 * );
 * console.log(status.ok); // false: this placeholder never reports a status
 * ```
 */
export function createReceiptClient(): ReceiptClient {
  return {
    prepare: prepareReviewPackage,
    readStatus: () => Promise.resolve(unavailable('NOT_IMPLEMENTED', 'Receipt status reads')),
    submit: () => Promise.resolve(unavailable('NOT_IMPLEMENTED', 'Receipt submission')),
  };
}

export const indexerCheckpointSchema = z.strictObject({
  progressBlock: unsignedDecimalSchema.nullable(),
  observedAt: rfc3339TimestampSchema,
});
export type IndexerCheckpoint = z.infer<typeof indexerCheckpointSchema>;

export const indexedEventSchema = z.strictObject({
  eventKind: z.enum(['issued', 'revoked', 'superseded', 'nonce_invalidated']),
  reviewerAddress: evmAddressSchema,
  commitment: bytes32Schema,
  blockNumber: unsignedDecimalSchema,
  transactionHash: bytes32Schema,
});
export type IndexedEvent = z.infer<typeof indexedEventSchema>;

export const indexedHistorySchema = z.strictObject({
  items: z.array(indexedEventSchema).max(50),
  checkpoint: indexerCheckpointSchema,
});
export type IndexedHistory = z.infer<typeof indexedHistorySchema>;

export interface HistoryQuery {
  readonly reviewerAddress: string;
  readonly limit: number;
  readonly cursor?: string;
}

/** Indexed history with checkpoint metadata. It can never override a live contract read. */
export interface ReceiptIndexer {
  history(query: HistoryQuery, signal?: AbortSignal): Promise<Result<IndexedHistory>>;
}

/**
 * An indexer placeholder that always returns the typed `NOT_IMPLEMENTED` failure. Indexed history
 * can never override a live contract read.
 *
 * @example
 * ```ts
 * import { createUnavailableReceiptIndexer } from '@lexaegis/sdk';
 *
 * const indexer = createUnavailableReceiptIndexer();
 * const page = await indexer.history({
 *   reviewerAddress: '0x2222222222222222222222222222222222222222',
 *   limit: 10,
 * });
 * console.log(page.ok); // false
 * ```
 */
export function createUnavailableReceiptIndexer(): ReceiptIndexer {
  return {
    history: () => Promise.resolve(unavailable('NOT_IMPLEMENTED', 'Indexed receipt history')),
  };
}
