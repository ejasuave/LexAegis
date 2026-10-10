import { indexer } from 'envio';
import { commitTransition, loadSnapshot } from '../projection/apply';
import { normalize, type RawLog } from '../projection/normalize';
import { computeTransition } from '../projection/transition';
import type { Tables } from '../projection/types';

/*
 * Handlers only translate a decoded log into a RawLog and delegate. Projection state lives in
 * Envio context entities, so Envio's rollback covers every row. Reads happen in both phases;
 * writes happen only when processing, never during the preload pass.
 */

const CONTRACT = 'ProofOfReviewRegistry' as const;

interface HandlerContext extends Tables {
  readonly isPreload: boolean;
}

async function handle(context: HandlerContext, raw: RawLog): Promise<void> {
  const event = normalize(raw);
  const snapshot = await loadSnapshot(context, event, process.env['ENVIO_INDEX_GENERATION']);
  if (context.isPreload) return;
  commitTransition(context, computeTransition(snapshot, event));
}

indexer.onEvent({ contract: CONTRACT, event: 'ReceiptIssued' }, async ({ event, context }) => {
  await handle(context, {
    kind: 'RECEIPT_ISSUED',
    chainId: event.chainId,
    srcAddress: event.srcAddress,
    reviewer: event.params.reviewer,
    commitment: event.params.commitment,
    relatedCommitment: event.params.predecessor,
    nonce: event.params.nonce,
    eventTimestamp: event.params.timestamp,
    blockNumber: event.block.number,
    blockHash: event.block.hash,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    executor: event.transaction.from ?? '',
    logIndex: event.logIndex,
  });
});

indexer.onEvent({ contract: CONTRACT, event: 'ReceiptRevoked' }, async ({ event, context }) => {
  await handle(context, {
    kind: 'RECEIPT_REVOKED',
    chainId: event.chainId,
    srcAddress: event.srcAddress,
    reviewer: event.params.reviewer,
    commitment: event.params.commitment,
    nonce: event.params.nonce,
    eventTimestamp: event.params.timestamp,
    blockNumber: event.block.number,
    blockHash: event.block.hash,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    executor: event.transaction.from ?? '',
    logIndex: event.logIndex,
  });
});

indexer.onEvent({ contract: CONTRACT, event: 'ReceiptSuperseded' }, async ({ event, context }) => {
  await handle(context, {
    kind: 'RECEIPT_SUPERSEDED',
    chainId: event.chainId,
    srcAddress: event.srcAddress,
    reviewer: event.params.reviewer,
    commitment: event.params.previousCommitment,
    relatedCommitment: event.params.replacementCommitment,
    nonce: event.params.nonce,
    eventTimestamp: event.params.timestamp,
    blockNumber: event.block.number,
    blockHash: event.block.hash,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    executor: event.transaction.from ?? '',
    logIndex: event.logIndex,
  });
});

indexer.onEvent({ contract: CONTRACT, event: 'NonceInvalidated' }, async ({ event, context }) => {
  await handle(context, {
    kind: 'NONCE_INVALIDATED',
    chainId: event.chainId,
    srcAddress: event.srcAddress,
    reviewer: event.params.reviewer,
    nonce: event.params.previousNonce,
    newNonce: event.params.newNonce,
    eventTimestamp: event.params.timestamp,
    blockNumber: event.block.number,
    blockHash: event.block.hash,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    executor: event.transaction.from ?? '',
    logIndex: event.logIndex,
  });
});
