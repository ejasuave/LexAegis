import { z } from 'zod';

/*
 * History is a public, indexed view of registry events. These schemas are deliberately outside
 * the receipt protocol: nothing here can change a receipt reference, a commitment or a
 * confirmed transaction state.
 */

const decimal = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
/** GraphQL numerics arrive as strings or safe integers. Anything else is rejected, never coerced. */
const wireQuantity = z
  .union([decimal, z.number().int().nonnegative()])
  .transform((value) => String(value));
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const digest = z.string().regex(/^0x[0-9a-f]{64}$/);

export const ACTION_KINDS = ['ISSUE', 'REVOKE', 'SUPERSEDE', 'INVALIDATE_NONCE'] as const;
export const RECEIPT_LIFECYCLES = ['ACTIVE', 'REVOKED', 'SUPERSEDED'] as const;

export const wireMetaSchema = z.strictObject({
  chainId: wireQuantity,
  startBlock: wireQuantity,
  progressBlock: wireQuantity,
  sourceBlock: wireQuantity,
  isReady: z.boolean(),
  eventsProcessed: wireQuantity,
});

export const wireRegistryStateSchema = z.strictObject({
  id: z.string().max(300),
  chainId: wireQuantity,
  genesisHash: digest,
  registryAddress: address,
  configFingerprint: digest,
  generation: z.string().regex(/^[a-z0-9][a-z0-9-]{7,63}$/),
  projectionVersion: z.string().max(64),
  startBlock: wireQuantity,
  rawEventCount: z.number().int().nonnegative(),
  actionCount: z.number().int().nonnegative(),
  pendingSupersessions: z.number().int().nonnegative(),
  lastEventId: z.string().max(400).nullable(),
  lastEventBlockNumber: wireQuantity.nullable(),
  lastEventBlockHash: digest.nullable(),
  lastEventLogIndex: z.number().int().nonnegative().nullable(),
});
export type WireRegistryState = z.infer<typeof wireRegistryStateSchema>;

export const wireSummarySchema = z.strictObject({
  id: z.string().max(300),
  reviewer: address,
  nextNonce: wireQuantity,
  totalReceipts: z.number().int().nonnegative(),
  activeReceipts: z.number().int().nonnegative(),
  revokedReceipts: z.number().int().nonnegative(),
  supersededReceipts: z.number().int().nonnegative(),
  actionCount: z.number().int().nonnegative(),
});

export const wireActionSchema = z.strictObject({
  id: z.string().max(300),
  reviewer: address,
  kind: z.enum(ACTION_KINDS),
  consumedNonce: wireQuantity,
  nextNonce: wireQuantity,
  commitment: digest.nullable(),
  relatedCommitment: digest.nullable(),
  transactionHash: digest,
  executor: address,
  blockNumber: wireQuantity,
  blockHash: digest,
  timestamp: wireQuantity,
  firstEventId: z.string().max(400),
  lastEventId: z.string().max(400),
  firstLogIndex: z.number().int().nonnegative(),
  lastLogIndex: z.number().int().nonnegative(),
  eventCount: z.number().int().min(1).max(2),
});
export type WireAction = z.infer<typeof wireActionSchema>;

export const wireReceiptSchema = z.strictObject({
  id: z.string().max(400),
  reviewer: address,
  commitment: digest,
  status: z.enum(RECEIPT_LIFECYCLES),
  predecessor: digest,
  successor: digest,
  issuedAt: wireQuantity,
  updatedAt: wireQuantity,
  issuingActionId: z.string().max(300),
  latestActionId: z.string().max(300),
});
export type WireReceipt = z.infer<typeof wireReceiptSchema>;

// ---- Public response bodies ----------------------------------------------------------------

export const AVAILABILITY = ['available', 'unavailable'] as const;
export const FRESHNESS = ['caught_up', 'catching_up', 'unknown'] as const;
export const INDEX_CONSISTENCY = ['consistent', 'recovering', 'inconsistent', 'unknown'] as const;

export const HISTORY_REASONS = [
  'INDEX_NOT_CONFIGURED',
  'INDEX_UNAVAILABLE',
  'INDEX_RESPONSE_INVALID',
  'INDEX_COVERAGE_UNKNOWN',
  'DEPLOYMENT_MISMATCH',
  'INCOMPLETE_SUPERSESSION',
  'GENERATION_CHANGED',
  'COVERAGE_REGRESSED',
  'REORG_BEYOND_WINDOW',
  'ANCHOR_HASH_MISMATCH',
  'ANCHOR_UNVERIFIED',
  'LIVE_CHECKPOINT_UNAVAILABLE',
  'SOURCE_BEHIND',
  'CONFIRMED_BEHIND',
  'NO_EVENTS_INDEXED',
  'METADATA_CHANGED',
] as const;
export type HistoryReason = (typeof HISTORY_REASONS)[number];

const quantity = decimal;
export const historyHealthSchema = z.strictObject({
  schema: z.literal('lexaegis.history-health.v1'),
  availability: z.enum(AVAILABILITY),
  freshness: z.enum(FRESHNESS),
  indexConsistency: z.enum(INDEX_CONSISTENCY),
  observedAt: z.iso.datetime(),
  configured: z.strictObject({
    chainId: quantity,
    registryAddress: address,
    startBlock: quantity,
  }),
  index: z
    .strictObject({
      configFingerprint: digest,
      generation: z.string(),
      projectionVersion: z.string(),
      progressBlock: quantity,
      sourceBlock: quantity,
      isReady: z.boolean(),
      lastEventBlock: quantity.nullable(),
      rawEventCount: z.number().int().nonnegative(),
      pendingSupersessions: z.number().int().nonnegative(),
    })
    .nullable(),
  live: z.strictObject({ checkpointBlock: quantity, checkpointHash: digest }).nullable(),
  lag: z.strictObject({ sourceLag: quantity.nullable(), confirmedLag: quantity.nullable() }),
  reasons: z.array(z.enum(HISTORY_REASONS)).max(16),
});
export type HistoryHealth = z.infer<typeof historyHealthSchema>;

export const historyActionSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(ACTION_KINDS),
  consumedNonce: quantity,
  commitment: digest.nullable(),
  relatedCommitment: digest.nullable(),
  reviewer: address,
  executor: address,
  transactionHash: digest,
  blockNumber: quantity,
  blockHash: digest,
  timestamp: quantity,
  eventCount: z.number().int().min(1).max(2),
  firstLogIndex: z.number().int(),
  lastLogIndex: z.number().int(),
  /** Newer than the confirmed live checkpoint: indexed visibility only. */
  provisional: z.boolean(),
});
export type HistoryAction = z.infer<typeof historyActionSchema>;

export const historyPageSchema = z.strictObject({
  schema: z.literal('lexaegis.history-page.v1'),
  status: z.literal('ok'),
  health: historyHealthSchema,
  reviewer: address,
  items: z.array(historyActionSchema).max(50),
  nextCursor: z.string().max(2048).nullable(),
  anchor: z.strictObject({ upperNonce: quantity, blockHash: digest }).nullable(),
  /** "No indexed history" only when coverage was coherent. */
  empty: z.boolean(),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;

export const historyResetSchema = z.strictObject({
  schema: z.literal('lexaegis.history-error.v1'),
  status: z.literal('history_reset_required'),
  reason: z.enum([
    'ANCHOR_CHANGED',
    'GENERATION_CHANGED',
    'COVERAGE_BELOW_ANCHOR',
    'CURSOR_INVALID',
  ]),
});
export type HistoryReset = z.infer<typeof historyResetSchema>;

export const COMPARISONS = [
  'same_block_match',
  'same_block_mismatch',
  'different_checkpoints',
  'unavailable',
] as const;

export const receiptHistorySchema = z.strictObject({
  schema: z.literal('lexaegis.receipt-history.v1'),
  status: z.literal('ok'),
  health: historyHealthSchema,
  reviewer: address,
  commitment: digest,
  indexed: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('not_indexed') }),
    z.strictObject({
      state: z.literal('indexed'),
      lifecycle: z.enum(RECEIPT_LIFECYCLES),
      predecessor: digest.nullable(),
      successor: digest.nullable(),
      issuedAt: quantity,
      updatedAt: quantity,
    }),
  ]),
  live: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('ok'),
      receiptStatus: z.enum(['not_found', 'active', 'revoked', 'superseded']),
      checkpointBlock: quantity,
      checkpointHash: digest,
    }),
    z.strictObject({ status: z.literal('unknown'), reason: z.string().max(64) }),
  ]),
  comparison: z.enum(COMPARISONS),
  provisionalNewerThanLive: z.boolean(),
});
export type ReceiptHistory = z.infer<typeof receiptHistorySchema>;
