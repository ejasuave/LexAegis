import {
  LOCAL_INTENTS,
  type AssistantIntent,
  type AssistantRequest,
  type ClientObservedStatus,
  type ConfirmedFactV1,
  type ConversationMessage,
  type SourceReferenceV1,
} from '@lexaegis/agent/contracts';
import type { DisclosedRequest } from '@lexaegis/agent/review';
import { EVIDENCE_PREFIX, FACT_PREFIX } from '@/features/review/persistence';
import type {
  AssistantContextResult,
  AssistantContextSelection,
  ReviewSnapshot,
} from '@/features/review/controller';
import type { VaultSnapshot } from '@/features/vault/public';

/*
 * Builds the body of one assistant request from what the reviewer deliberately selected. It reads
 * only through the review controller, which resolves every excerpt against the decrypted,
 * hash-verified artifacts of this unlock. Nothing is sent from here: the body goes to the
 * disclosure preview, and only an explicit Send turns it into a request.
 */

/** Saved assistant outcomes ride on context entries with this prefix (see saved-outcomes.ts). */
export const OUTCOME_PREFIX = 'lexaegis.assistant-outcome.v1:';

export interface ContextPorts {
  readonly review: {
    getSnapshot(): ReviewSnapshot;
    assistantContext(selection: AssistantContextSelection): Promise<AssistantContextResult>;
  };
  readonly vault: { getSnapshot(): VaultSnapshot };
  readonly account: () => { readonly unlocked: boolean; readonly present: boolean };
  readonly newId: () => string;
}

export interface RequestInput {
  readonly intent: AssistantIntent | null;
  readonly trigger: AssistantRequest['trigger'];
  readonly utterance: string;
  /** The version the request is about; null for a matter-level request. */
  readonly documentVersionId: string | null;
  /** Passages the reviewer selected for this request. */
  readonly references: readonly SourceReferenceV1[];
  /** Saved context entries the reviewer explicitly ticked. */
  readonly savedEntryIds: readonly string[];
  /** Earlier messages of this conversation, only if the reviewer left them included. */
  readonly history: readonly ConversationMessage[];
}

export type RequestBodyResult =
  | { readonly ok: true; readonly body: DisclosedRequest }
  | { readonly ok: false; readonly code: string };

/**
 * Which confirmed facts a request for this intent needs. A summary or explanation of selected
 * text needs none; a payment question needs the payment facts; a briefing, evidence review or
 * draft preparation needs them all. Fewer private inputs are sent, never more than the intent uses.
 */
export function factsFor(
  intent: AssistantIntent | null,
  facts: readonly ConfirmedFactV1[],
): readonly ConfirmedFactV1[] {
  switch (intent) {
    case 'check_payments':
      return facts.filter((fact) => fact.field.startsWith('payment_'));
    case 'missing_evidence':
    case 'prepare_review':
    case 'brief_matter':
      return facts;
    default:
      return [];
  }
}

const usesEvidence = (intent: AssistantIntent | null): boolean =>
  intent === 'missing_evidence' || intent === 'prepare_review' || intent === 'brief_matter';

const usesClientStatus = (intent: AssistantIntent | null): boolean =>
  intent === null || intent === 'status' || intent === 'prepare_review';

/** The browser's own readings, labelled as such: the server cannot inspect any of them. */
export function observeClient(ports: ContextPorts): ClientObservedStatus {
  const vault = ports.vault.getSnapshot();
  const review = ports.review.getSnapshot();
  const account = ports.account();
  const save: Record<VaultSnapshot['save'], ClientObservedStatus['vaultSave']> = {
    idle: 'saved',
    saved: 'saved',
    saving: 'saving',
    unsaved: 'unsaved',
    conflict: 'conflict',
    unknown_outcome: 'unknown',
  };
  return {
    provenance: 'client_observed',
    account: !account.present ? 'none' : account.unlocked ? 'unlocked' : 'locked',
    vault:
      vault.state === 'unlocked' || vault.state === 'saving'
        ? 'unlocked'
        : vault.state === 'unavailable'
          ? 'unavailable'
          : vault.state === 'locked'
            ? 'locked'
            : 'unknown',
    vaultSave: review.save === 'unsaved' ? 'unsaved' : save[vault.save],
    checks: review.checks.status,
    selectedDocuments: Math.min(8, review.documents.filter((d) => d.selected).length),
    confirmedFacts: Math.min(200, review.facts.length),
    savedPackages: Math.min(1000, vault.checkedCaptures.length),
  };
}

/**
 * Saved context the reviewer ticked: confirmed entries of this matter only. Facts and evidence
 * selections live in the same store under typed prefixes and are never sent as free text here;
 * a saved assistant outcome is sent as the concise text it was saved with.
 */
export function savedContextOf(
  vault: VaultSnapshot,
  entryIds: readonly string[],
): { ok: true; entries: AssistantContextSelection['savedContext'] } | { ok: false; code: string } {
  const matter = vault.selectedMatter;
  if (matter === null)
    return entryIds.length === 0 ? { ok: true, entries: [] } : { ok: false, code: 'VAULT_LOCKED' };
  const entries: { entryId: string; kind: 'note' | 'outcome'; text: string }[] = [];
  for (const id of new Set(entryIds)) {
    const entry = matter.context.entries.find((candidate) => candidate.entryId === id);
    if (entry === undefined) return { ok: false, code: 'CONTEXT_ENTRY_NOT_FOUND' };
    if (entry.status !== 'confirmed') return { ok: false, code: 'CONTEXT_ENTRY_UNCONFIRMED' };
    if (entry.text.startsWith(FACT_PREFIX) || entry.text.startsWith(EVIDENCE_PREFIX)) {
      return { ok: false, code: 'CONTEXT_ENTRY_NOT_TEXT' };
    }
    const outcome = entry.text.startsWith(OUTCOME_PREFIX);
    entries.push({
      entryId: entry.entryId,
      kind: outcome ? 'outcome' : 'note',
      text: outcome ? outcomeText(entry.text) : entry.text,
    });
  }
  return { ok: true, entries };
}

function outcomeText(stored: string): string {
  try {
    const parsed = JSON.parse(stored.slice(OUTCOME_PREFIX.length)) as { summary?: unknown };
    return typeof parsed.summary === 'string' && parsed.summary !== ''
      ? parsed.summary
      : '(saved outcome)';
  } catch {
    return '(saved outcome)';
  }
}

export async function buildRequestBody(
  ports: ContextPorts,
  input: RequestInput,
): Promise<RequestBodyResult> {
  if (
    input.trigger !== 'ui_action' &&
    input.intent !== null &&
    LOCAL_INTENTS.includes(input.intent)
  ) {
    // A directly requested deterministic check or status reading is served locally and discloses nothing.
    return { ok: false, code: 'LOCAL_INTENT' };
  }
  const review = ports.review.getSnapshot();
  if (review.matterId === null) return { ok: false, code: 'NO_MATTER' };
  const saved = savedContextOf(ports.vault.getSnapshot(), input.savedEntryIds);
  if (!saved.ok) return saved;

  const facts = factsFor(input.intent, review.facts);
  // The passages a disclosed fact cites travel with it, so the answer can cite them.
  const references = [...input.references, ...facts.flatMap((fact) => fact.references)];
  const built = await ports.review.assistantContext({
    documentVersionId: input.documentVersionId,
    references,
    factIds: facts.map((fact) => fact.factId),
    includeEvidence: usesEvidence(input.intent),
    savedContext: saved.entries,
  });
  if (!built.ok) return built;
  return {
    ok: true,
    body: {
      schema: 'lexaegis.assistant-request.v1',
      clientRequestId: ports.newId(),
      matterId: review.matterId,
      documentVersionId: input.documentVersionId,
      snapshot: built.snapshot,
      vaultGeneration: built.vaultGeneration,
      intent: input.intent,
      trigger: input.trigger,
      utterance: input.utterance,
      context: built.context,
      history: [...input.history],
      clientObserved: usesClientStatus(input.intent) ? observeClient(ports) : null,
    },
  };
}
