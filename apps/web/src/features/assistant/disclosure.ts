import {
  assistantRequestSchema,
  limitCodeOf,
  type AssistantAvailability,
  type AssistantRequest,
  type ProviderScope,
} from '@lexaegis/agent/contracts';
import {
  disclosureDigest,
  summariseDisclosure,
  type DisclosedRequest,
  type DisclosureSummary,
} from '@lexaegis/agent/review';

/*
 * The disclosure step between building a request and sending it. A pending disclosure shows
 * exactly what would leave the browser and to whom. Consent exists only for that exact content
 * and provider scope: any change to either produces a different digest and needs a new Send.
 * Unlocking the vault, importing a document or an earlier conversation is never consent.
 */

export interface PendingDisclosure {
  readonly body: DisclosedRequest;
  readonly providerScope: ProviderScope;
  readonly digest: string;
  readonly summary: DisclosureSummary;
  /** Scripted test provider or real Qwen: shown as what it is. */
  readonly testProvider: boolean;
  readonly verified: boolean;
  readonly notices: readonly string[];
}

/** Statements that hold for every disclosure. None claims residency, retention or secrecy. */
export const DISCLOSURE_FACTS: readonly string[] = [
  'The selected text is sent in readable form to the LexAegis server and from there to the model provider.',
  'Each excerpt is sent to the LexAegis server with its source reference: document identifiers, page, position and the SHA-256 of the file and of its extracted text. Those digests are not passed to the model provider.',
  'It is not end-to-end encrypted through analysis, and sending cannot be undone once it has happened.',
  'The endpoint region names where requests are addressed. It does not prove where data is processed or how long the provider keeps it; this application does not know those settings.',
  'Nothing else from your vault is sent. Aegis cannot read further documents, open links or approve anything.',
];

export type PrepareResult =
  | { readonly ok: true; readonly pending: PendingDisclosure }
  | { readonly ok: false; readonly code: string };

export async function prepareDisclosure(
  body: DisclosedRequest,
  availability: AssistantAvailability,
): Promise<PrepareResult> {
  const scope = availability.providerScope;
  if (scope === null || availability.state === 'not_configured')
    return { ok: false, code: 'ASSISTANT_NOT_CONFIGURED' };
  if (availability.state === 'configured_unverified')
    return { ok: false, code: 'ASSISTANT_NOT_VERIFIED' };
  return {
    ok: true,
    pending: {
      body,
      providerScope: scope,
      digest: await disclosureDigest(body, scope),
      summary: summariseDisclosure(body, scope),
      testProvider: availability.state === 'test_provider',
      verified: availability.state === 'verified',
      notices: availability.notices,
    },
  };
}

/** What a pending disclosure must still match at the moment of Send. */
export interface CurrentBinding {
  readonly providerScope: ProviderScope | null;
  readonly matterId: string | null;
  readonly inputRevision: number;
  readonly vaultGeneration: number;
}

export function disclosureIsCurrent(pending: PendingDisclosure, current: CurrentBinding): boolean {
  const scope = current.providerScope;
  return (
    scope !== null &&
    scope.provider === pending.providerScope.provider &&
    scope.model === pending.providerScope.model &&
    scope.region === pending.providerScope.region &&
    current.matterId === pending.body.matterId &&
    current.inputRevision === pending.body.snapshot.revision &&
    current.vaultGeneration === pending.body.vaultGeneration
  );
}

export type ConsentResult =
  | { readonly ok: true; readonly request: AssistantRequest }
  | { readonly ok: false; readonly code: string };

/**
 * Turns a pending disclosure into a consented request. Called only from the explicit Send
 * control, and only while the disclosure is still current.
 */
export function consentToDisclosure(
  pending: PendingDisclosure,
  current: CurrentBinding,
  now: Date,
): ConsentResult {
  if (!disclosureIsCurrent(pending, current)) return { ok: false, code: 'DISCLOSURE_STALE' };
  const parsed = assistantRequestSchema.safeParse({
    ...pending.body,
    consent: {
      schema: 'lexaegis.disclosure-consent.v1',
      action: 'explicit_send',
      providerScope: pending.providerScope,
      matterId: pending.body.matterId,
      documentVersionId: pending.body.documentVersionId,
      disclosureDigest: pending.digest,
      consentedAt: now.toISOString(),
    },
  });
  if (parsed.success) return { ok: true, request: parsed.data };
  return { ok: false, code: limitCodeOf(parsed.error) ?? 'REQUEST_INVALID' };
}
