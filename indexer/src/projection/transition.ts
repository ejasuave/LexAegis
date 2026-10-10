import { BINDING } from '../binding.generated';
import { actionId, eventId, receiptId, registryKey, reviewerKey } from './keys';
import {
  IntegrityError,
  UINT256_MAX,
  ZERO_HASH,
  type ChainEvent,
  type IndexedAction,
  type IndexedReceipt,
  type NormalizedEvent,
  type PendingSupersession,
  type RegistryState,
  type ReviewerSummary,
  type Snapshot,
  type Transition,
} from './types';

const GENERATION = /^[a-z0-9][a-z0-9-]{7,63}$/;

export function assertGeneration(generation: string | undefined): string {
  if (generation === undefined || !GENERATION.test(generation)) {
    throw new IntegrityError('GENERATION_INVALID', 'startup');
  }
  return generation;
}

export function initialRegistry(generation: string): RegistryState {
  return {
    id: registryKey(),
    chainId: BINDING.chainId,
    genesisHash: BINDING.genesisHash,
    registryAddress: BINDING.registryAddress,
    configFingerprint: BINDING.configFingerprint,
    generation,
    projectionVersion: BINDING.projectionVersion,
    startBlock: BigInt(BINDING.startBlock),
    rawEventCount: 0,
    actionCount: 0,
    pendingSupersessions: 0,
    lastEventId: undefined,
    lastEventBlockNumber: undefined,
    lastEventBlockHash: undefined,
    lastEventLogIndex: undefined,
  };
}

export function initialSummary(reviewer: string): ReviewerSummary {
  return {
    id: reviewerKey(reviewer),
    registryKey: registryKey(),
    reviewer,
    nextNonce: 0n,
    totalReceipts: 0,
    activeReceipts: 0,
    revokedReceipts: 0,
    supersededReceipts: 0,
    actionCount: 0,
  };
}

const at = (ev: NormalizedEvent): string => `${ev.blockNumber.toString()}/${ev.logIndex}`;

export const idOf = (ev: NormalizedEvent): string =>
  eventId(ev.blockHash, ev.transactionHash, ev.logIndex);

function sameEventPayload(stored: ChainEvent, ev: NormalizedEvent): boolean {
  return (
    stored.kind === ev.kind &&
    stored.reviewer === ev.reviewer &&
    stored.commitment === ev.commitment &&
    stored.relatedCommitment === ev.relatedCommitment &&
    stored.nonce === ev.nonce &&
    stored.newNonce === ev.newNonce &&
    stored.eventTimestamp === ev.eventTimestamp &&
    stored.blockNumber === ev.blockNumber &&
    stored.blockHash === ev.blockHash &&
    stored.blockTimestamp === ev.blockTimestamp &&
    stored.transactionHash === ev.transactionHash &&
    stored.executor === ev.executor &&
    stored.logIndex === ev.logIndex
  );
}

function rawEvent(ev: NormalizedEvent, actionIdValue: string | undefined): ChainEvent {
  return {
    id: idOf(ev),
    registryKey: registryKey(),
    kind: ev.kind,
    reviewer: ev.reviewer,
    commitment: ev.commitment,
    relatedCommitment: ev.relatedCommitment,
    nonce: ev.nonce,
    newNonce: ev.newNonce,
    eventTimestamp: ev.eventTimestamp,
    blockNumber: ev.blockNumber,
    blockHash: ev.blockHash,
    blockTimestamp: ev.blockTimestamp,
    transactionHash: ev.transactionHash,
    executor: ev.executor,
    logIndex: ev.logIndex,
    actionId: actionIdValue,
  };
}

function advanceRegistry(
  registry: RegistryState,
  ev: NormalizedEvent,
  delta: { readonly actions: number; readonly pending: number },
): RegistryState {
  const pendingSupersessions = registry.pendingSupersessions + delta.pending;
  if (pendingSupersessions < 0) throw new IntegrityError('COUNTER_INVARIANT', at(ev));
  return {
    ...registry,
    rawEventCount: registry.rawEventCount + 1,
    actionCount: registry.actionCount + delta.actions,
    pendingSupersessions,
    lastEventId: idOf(ev),
    lastEventBlockNumber: ev.blockNumber,
    lastEventBlockHash: ev.blockHash,
    lastEventLogIndex: ev.logIndex,
  };
}

/** Counter invariant after any completed transition. */
export function assertSummary(summary: ReviewerSummary, ev: NormalizedEvent): ReviewerSummary {
  const {
    activeReceipts: a,
    revokedReceipts: r,
    supersededReceipts: s,
    totalReceipts: t,
  } = summary;
  if (a < 0 || r < 0 || s < 0 || t < 0 || summary.actionCount < 0 || t !== a + r + s) {
    throw new IntegrityError('COUNTER_INVARIANT', at(ev));
  }
  return summary;
}

function expectNonce(summary: ReviewerSummary, nonce: bigint, ev: NormalizedEvent): void {
  if (summary.nextNonce !== nonce) throw new IntegrityError('NONCE_DISCONTINUITY', at(ev));
  if (nonce >= UINT256_MAX) throw new IntegrityError('NONCE_DISCONTINUITY', at(ev));
}

function newAction(
  ev: NormalizedEvent,
  kind: IndexedAction['kind'],
  fields: Pick<IndexedAction, 'commitment' | 'relatedCommitment'>,
  first: { readonly id: string; readonly logIndex: number },
): IndexedAction {
  return {
    id: actionId(ev.reviewer, ev.nonce),
    registryKey: registryKey(),
    reviewer: ev.reviewer,
    kind,
    consumedNonce: ev.nonce,
    nextNonce: ev.nonce + 1n,
    commitment: fields.commitment,
    relatedCommitment: fields.relatedCommitment,
    transactionHash: ev.transactionHash,
    executor: ev.executor,
    blockNumber: ev.blockNumber,
    blockHash: ev.blockHash,
    timestamp: ev.blockTimestamp,
    firstEventId: first.id,
    lastEventId: idOf(ev),
    firstLogIndex: first.logIndex,
    lastLogIndex: ev.logIndex,
    eventCount: first.id === idOf(ev) ? 1 : 2,
  };
}

function receiptRow(
  ev: NormalizedEvent,
  commitment: string,
  predecessor: string,
  action: IndexedAction,
): IndexedReceipt {
  return {
    id: receiptId(ev.reviewer, commitment),
    registryKey: registryKey(),
    reviewer: ev.reviewer,
    commitment,
    status: 'ACTIVE',
    predecessor,
    successor: ZERO_HASH,
    issuedAt: ev.blockTimestamp,
    updatedAt: ev.blockTimestamp,
    issuingActionId: action.id,
    latestActionId: action.id,
  };
}

function requireRegistryIdentity(registry: RegistryState, ev: NormalizedEvent): void {
  if (
    registry.configFingerprint !== BINDING.configFingerprint ||
    registry.registryAddress !== BINDING.registryAddress ||
    registry.chainId !== BINDING.chainId
  ) {
    throw new IntegrityError('CONFIG_CHANGED', at(ev));
  }
}

/**
 * Computes one complete transition from a loaded snapshot. Pure: no I/O, no clock. Anything that
 * violates the registry's rules throws before the caller writes a single entity.
 */
export function computeTransition(snap: Snapshot, ev: NormalizedEvent): Transition {
  requireRegistryIdentity(snap.registry, ev);

  if (snap.existingEvent !== undefined) {
    if (!sameEventPayload(snap.existingEvent, ev))
      throw new IntegrityError('EVENT_CONFLICT', at(ev));
    return {
      noop: true,
      registry: snap.registry,
      summary: undefined,
      receipts: [],
      action: undefined,
      events: [],
      pending: undefined,
    };
  }

  const { registry } = snap;
  if (registry.lastEventBlockNumber !== undefined && registry.lastEventLogIndex !== undefined) {
    const regressed =
      ev.blockNumber < registry.lastEventBlockNumber ||
      (ev.blockNumber === registry.lastEventBlockNumber &&
        ev.logIndex <= registry.lastEventLogIndex);
    if (regressed) throw new IntegrityError('EVENT_ORDER_REGRESSION', at(ev));
  }

  switch (ev.kind) {
    case 'RECEIPT_ISSUED':
      return ev.relatedCommitment === ZERO_HASH ? issue(snap, ev) : stageSupersession(snap, ev);
    case 'RECEIPT_REVOKED':
      return revoke(snap, ev);
    case 'RECEIPT_SUPERSEDED':
      return completeSupersession(snap, ev);
    case 'NONCE_INVALIDATED':
      return invalidate(snap, ev);
  }
}

function issue(snap: Snapshot, ev: NormalizedEvent): Transition {
  if (snap.receipt !== undefined) throw new IntegrityError('RECEIPT_EXISTS', at(ev));
  expectNonce(snap.summary, ev.nonce, ev);
  const id = idOf(ev);
  const action = newAction(
    ev,
    'ISSUE',
    { commitment: ev.commitment, relatedCommitment: undefined },
    { id, logIndex: ev.logIndex },
  );
  const summary = assertSummary(
    {
      ...snap.summary,
      nextNonce: ev.nonce + 1n,
      totalReceipts: snap.summary.totalReceipts + 1,
      activeReceipts: snap.summary.activeReceipts + 1,
      actionCount: snap.summary.actionCount + 1,
    },
    ev,
  );
  return {
    noop: false,
    registry: advanceRegistry(snap.registry, ev, { actions: 1, pending: 0 }),
    summary,
    receipts: [receiptRow(ev, ev.commitment, ZERO_HASH, action)],
    action,
    events: [rawEvent(ev, action.id)],
    pending: undefined,
  };
}

function stageSupersession(snap: Snapshot, ev: NormalizedEvent): Transition {
  const predecessor = ev.relatedCommitment;
  if (predecessor === ev.commitment) throw new IntegrityError('LIFECYCLE_INVALID', at(ev));
  if (snap.receipt !== undefined) throw new IntegrityError('RECEIPT_EXISTS', at(ev));
  if (snap.relatedReceipt === undefined) throw new IntegrityError('RECEIPT_MISSING', at(ev));
  if (snap.relatedReceipt.status !== 'ACTIVE')
    throw new IntegrityError('LIFECYCLE_INVALID', at(ev));
  expectNonce(snap.summary, ev.nonce, ev);
  if (snap.pending !== undefined) throw new IntegrityError('PENDING_CONFLICT', at(ev));
  const pending: PendingSupersession = {
    id: `${reviewerKey(ev.reviewer)}:${ev.nonce.toString(10)}`,
    reviewer: ev.reviewer,
    nonce: ev.nonce,
    predecessor,
    replacement: ev.commitment,
    issuedEventId: idOf(ev),
    issuedLogIndex: ev.logIndex,
    blockNumber: ev.blockNumber,
    blockHash: ev.blockHash,
    transactionHash: ev.transactionHash,
    timestamp: ev.blockTimestamp,
    complete: false,
  };
  return {
    noop: false,
    registry: advanceRegistry(snap.registry, ev, { actions: 0, pending: 1 }),
    summary: undefined,
    receipts: [],
    action: undefined,
    events: [rawEvent(ev, undefined)],
    pending,
  };
}

function revoke(snap: Snapshot, ev: NormalizedEvent): Transition {
  const current = snap.receipt;
  if (current === undefined) throw new IntegrityError('RECEIPT_MISSING', at(ev));
  if (current.status !== 'ACTIVE') throw new IntegrityError('LIFECYCLE_INVALID', at(ev));
  expectNonce(snap.summary, ev.nonce, ev);
  const id = idOf(ev);
  const action = newAction(
    ev,
    'REVOKE',
    { commitment: ev.commitment, relatedCommitment: undefined },
    { id, logIndex: ev.logIndex },
  );
  const summary = assertSummary(
    {
      ...snap.summary,
      nextNonce: ev.nonce + 1n,
      activeReceipts: snap.summary.activeReceipts - 1,
      revokedReceipts: snap.summary.revokedReceipts + 1,
      actionCount: snap.summary.actionCount + 1,
    },
    ev,
  );
  return {
    noop: false,
    registry: advanceRegistry(snap.registry, ev, { actions: 1, pending: 0 }),
    summary,
    receipts: [
      { ...current, status: 'REVOKED', updatedAt: ev.blockTimestamp, latestActionId: action.id },
    ],
    action,
    events: [rawEvent(ev, action.id)],
    pending: undefined,
  };
}

function completeSupersession(snap: Snapshot, ev: NormalizedEvent): Transition {
  const { pending, issuedEvent } = snap;
  if (pending === undefined || issuedEvent === undefined) {
    throw new IntegrityError('PENDING_MISSING', at(ev));
  }
  if (pending.complete) throw new IntegrityError('PENDING_CONFLICT', at(ev));
  const replacement = ev.relatedCommitment;
  const previous = ev.commitment;
  if (
    pending.predecessor !== previous ||
    pending.replacement !== replacement ||
    pending.nonce !== ev.nonce ||
    pending.transactionHash !== ev.transactionHash ||
    pending.blockHash !== ev.blockHash ||
    pending.timestamp !== ev.blockTimestamp ||
    pending.issuedLogIndex >= ev.logIndex ||
    issuedEvent.id !== pending.issuedEventId
  ) {
    throw new IntegrityError('PAIRED_LOGS_MISMATCH', at(ev));
  }
  const old = snap.receipt;
  if (old === undefined) throw new IntegrityError('RECEIPT_MISSING', at(ev));
  if (old.status !== 'ACTIVE') throw new IntegrityError('LIFECYCLE_INVALID', at(ev));
  if (snap.relatedReceipt !== undefined) throw new IntegrityError('RECEIPT_EXISTS', at(ev));
  expectNonce(snap.summary, ev.nonce, ev);

  const action = newAction(
    ev,
    'SUPERSEDE',
    { commitment: previous, relatedCommitment: replacement },
    { id: pending.issuedEventId, logIndex: pending.issuedLogIndex },
  );
  const summary = assertSummary(
    {
      ...snap.summary,
      nextNonce: ev.nonce + 1n,
      totalReceipts: snap.summary.totalReceipts + 1,
      supersededReceipts: snap.summary.supersededReceipts + 1,
      actionCount: snap.summary.actionCount + 1,
    },
    ev,
  );
  return {
    noop: false,
    registry: advanceRegistry(snap.registry, ev, { actions: 1, pending: -1 }),
    summary,
    receipts: [
      {
        ...old,
        status: 'SUPERSEDED',
        successor: replacement,
        updatedAt: ev.blockTimestamp,
        latestActionId: action.id,
      },
      receiptRow(ev, replacement, previous, action),
    ],
    action,
    events: [{ ...issuedEvent, actionId: action.id }, rawEvent(ev, action.id)],
    pending: { ...pending, complete: true },
  };
}

function invalidate(snap: Snapshot, ev: NormalizedEvent): Transition {
  if (ev.newNonce === undefined || ev.newNonce !== ev.nonce + 1n) {
    throw new IntegrityError('NONCE_DISCONTINUITY', at(ev));
  }
  expectNonce(snap.summary, ev.nonce, ev);
  const id = idOf(ev);
  const action = newAction(
    ev,
    'INVALIDATE_NONCE',
    { commitment: undefined, relatedCommitment: undefined },
    { id, logIndex: ev.logIndex },
  );
  const summary = assertSummary(
    { ...snap.summary, nextNonce: ev.newNonce, actionCount: snap.summary.actionCount + 1 },
    ev,
  );
  return {
    noop: false,
    registry: advanceRegistry(snap.registry, ev, { actions: 1, pending: 0 }),
    summary,
    receipts: [],
    action,
    events: [rawEvent(ev, action.id)],
    pending: undefined,
  };
}
