import { receiptId, registryKey, reviewerKey } from './keys';
import {
  assertGeneration,
  computeTransition,
  idOf,
  initialRegistry,
  initialSummary,
} from './transition';
import {
  ZERO_HASH,
  type NormalizedEvent,
  type Snapshot,
  type Tables,
  type Transition,
} from './types';

/** Reads every entity the transition may need. Safe in the preload phase: it only reads. */
export async function loadSnapshot(
  tables: Tables,
  ev: NormalizedEvent,
  generation: string | undefined,
): Promise<Snapshot> {
  const [registry, summary, existingEvent] = await Promise.all([
    tables.RegistryState.get(registryKey()),
    tables.ReviewerSummary.get(reviewerKey(ev.reviewer)),
    tables.ChainEvent.get(idOf(ev)),
  ]);
  const isReplacementIssue = ev.kind === 'RECEIPT_ISSUED' && ev.relatedCommitment !== ZERO_HASH;
  const isSuperseded = ev.kind === 'RECEIPT_SUPERSEDED';
  const receiptKey = receiptId(ev.reviewer, ev.commitment);
  const relatedKey = receiptId(ev.reviewer, ev.relatedCommitment);
  const pendingKey = `${reviewerKey(ev.reviewer)}:${ev.nonce.toString(10)}`;
  const needsReceipt = ev.kind !== 'NONCE_INVALIDATED';
  const needsRelated = isReplacementIssue || isSuperseded;
  const needsPending = isReplacementIssue || isSuperseded;

  const [receipt, relatedReceipt, pending] = await Promise.all([
    needsReceipt ? tables.IndexedReceipt.get(receiptKey) : undefined,
    needsRelated ? tables.IndexedReceipt.get(relatedKey) : undefined,
    needsPending ? tables.PendingSupersession.get(pendingKey) : undefined,
  ]);
  const issuedEvent =
    pending !== undefined ? await tables.ChainEvent.get(pending.issuedEventId) : undefined;
  // `receipt` is the receipt named by the event's commitment; `relatedReceipt` the one named by
  // its related commitment (predecessor on a replacement issue, replacement on a supersession).
  return {
    registry: registry ?? initialRegistry(assertGeneration(generation)),
    summary: summary ?? initialSummary(ev.reviewer),
    existingEvent,
    receipt,
    relatedReceipt,
    pending,
    issuedEvent,
  };
}

/** Writes a computed transition. Nothing is written for a no-op duplicate. */
export function commitTransition(tables: Tables, t: Transition): void {
  if (t.noop) return;
  tables.RegistryState.set(t.registry);
  if (t.summary !== undefined) tables.ReviewerSummary.set(t.summary);
  for (const r of t.receipts) tables.IndexedReceipt.set(r);
  if (t.action !== undefined) tables.IndexedAction.set(t.action);
  for (const e of t.events) tables.ChainEvent.set(e);
  if (t.pending !== undefined) tables.PendingSupersession.set(t.pending);
}

export async function projectEvent(
  tables: Tables,
  ev: NormalizedEvent,
  generation: string | undefined,
): Promise<void> {
  const snapshot = await loadSnapshot(tables, ev, generation);
  commitTransition(tables, computeTransition(snapshot, ev));
}
