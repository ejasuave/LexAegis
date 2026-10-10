import type { AssistantRequest, ProviderScope } from '../contracts/assistant';
import { canonicalDigest } from './hash';

/*
 * The exact disclosure a consent covers: the provider scope and every part of the request that
 * leaves the browser. Both sides compute this digest; the server refuses a request whose consent
 * names another one. It binds what was shown, it does not prove what a provider does with it.
 */

export type DisclosedRequest = Omit<AssistantRequest, 'consent'>;

export function disclosureBody(request: DisclosedRequest, providerScope: ProviderScope) {
  return {
    schema: 'lexaegis.disclosure.v1',
    providerScope,
    matterId: request.matterId,
    documentVersionId: request.documentVersionId,
    snapshot: request.snapshot,
    vaultGeneration: request.vaultGeneration,
    intent: request.intent,
    trigger: request.trigger,
    utterance: request.utterance,
    context: request.context,
    history: request.history,
    clientObserved: request.clientObserved,
  };
}

export const disclosureDigest = (
  request: DisclosedRequest,
  providerScope: ProviderScope,
): Promise<string> => canonicalDigest(disclosureBody(request, providerScope));

/** What a disclosure preview lists, derived from the request itself so the two cannot diverge. */
export interface DisclosureSummary {
  readonly providerScope: ProviderScope;
  readonly matterId: string;
  readonly documentVersionId: string | null;
  readonly excerpts: readonly {
    handle: string;
    page: number;
    documentVersionId: string;
    bytes: number;
  }[];
  readonly facts: number;
  readonly evidenceDescriptors: number;
  readonly savedContextEntries: number;
  readonly conversationMessages: number;
  readonly utteranceBytes: number;
}

export function summariseDisclosure(
  request: DisclosedRequest,
  providerScope: ProviderScope,
): DisclosureSummary {
  const encoder = new TextEncoder();
  return {
    providerScope,
    matterId: request.matterId,
    documentVersionId: request.documentVersionId,
    excerpts: request.context.sources.map((entry) => ({
      handle: entry.handle,
      page: entry.reference.page,
      documentVersionId: entry.reference.documentVersionId,
      bytes: encoder.encode(entry.reference.quote).byteLength,
    })),
    facts: request.context.facts.length,
    evidenceDescriptors: request.context.evidence.length,
    savedContextEntries: request.context.savedContext.length,
    conversationMessages: request.history.length,
    utteranceBytes: encoder.encode(request.utterance).byteLength,
  };
}
