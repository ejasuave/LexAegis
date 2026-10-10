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

import { ACTION_KINDS, RECEIPT_LIFECYCLES } from '@/domain/history/response';

export * from '@/domain/history/response';

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
