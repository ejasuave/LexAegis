import type {
  AgentConfigV1,
  AssistantIntent,
  AssistantRequest,
  AssistantToolName,
  OutputMode,
  SelectedContextV1,
} from '../contracts';
import { TOOL_VERSION } from '../contracts';
import {
  COMMON_POLICY,
  INTENT_ASSETS,
  INTENT_SCHEMA_SHA256,
  OUTPUT_SCHEMA_SHA256,
  PROMPT_MANIFEST_VERSION,
  ROUTER_ASSET,
  TOOL_SCHEMA_SHA256,
} from './generated/prompt-assets';
import {
  INTENT_SCHEMA_NAME,
  OUTPUT_SCHEMA_NAME,
  intentSelectionOutputSchema,
  modelOutputSchema,
  toProviderSchema,
} from './model-schemas';
import type { ChatMessage, ResponseFormat } from './provider';

/*
 * Assembles provider messages from the pinned repository assets. The system message is always the
 * common policy plus exactly one intent asset. Everything from the request goes into one user
 * message as labelled data; no document, history or tool text can become a system or tool message.
 */

const DEFAULT_REQUEST: Readonly<Record<AssistantIntent, string>> = {
  summarise: 'Summarise the selected sources.',
  explain: 'Explain the selected clause.',
  check_payments: 'Check whether the payment schedule adds up to the stated total.',
  missing_evidence: 'What evidence is missing within the selected scope?',
  brief_matter: 'Brief me on this matter from the selected material.',
  ask_matter: 'Analyse the current matter using the retrieved evidence.',
  prepare_review: 'What is still required before a review draft can be assembled?',
  status: 'What is the current status?',
};

/**
 * The compact view of the consented context a model sees: handles and minimal metadata. Excerpt
 * text is not included; it is read through read_sources. No hash, offset, artifact ID, matter ID
 * or account appears here.
 */
export function modelContextView(context: SelectedContextV1) {
  const documents = context.searchedScope.documentVersionIds;
  const documentLabel = (id: string) => `D${documents.indexOf(id) + 1}`;
  const handleOf = (ref: { documentVersionId: string; page: number; start: number; end: number }) =>
    context.sources.find(
      (entry) =>
        entry.reference.documentVersionId === ref.documentVersionId &&
        entry.reference.page === ref.page &&
        entry.reference.start === ref.start &&
        entry.reference.end === ref.end,
    )?.handle;
  return {
    sources: context.sources.map((entry) => ({
      handle: entry.handle,
      document: documentLabel(entry.reference.documentVersionId),
      page: entry.reference.page,
      characters: entry.reference.quote.length,
      coverage: entry.coverage,
    })),
    facts: context.facts.map((fact) => ({
      field: fact.field,
      group: fact.group,
      slot: fact.slot,
      value: fact.value,
      basis: fact.basis,
      sources: fact.references.flatMap((ref) => handleOf(ref) ?? []),
    })),
    evidence: context.evidence.map((selection) => ({
      requirement: selection.requirement,
      linkedFiles: selection.artifactIds.length,
      confirmedForCheck: selection.confirmedForCheck,
      notApplicable: selection.notApplicableReason !== null,
    })),
    saved: context.savedContext.map((entry) => ({ kind: entry.kind, text: entry.text })),
    scope: {
      selectedDocuments: documents.length,
      aboutOneDocument: context.documentVersionId !== null,
      excerptsOnly: true,
      ...(context.searchedScope.automatic !== undefined && {
        automaticRetrieval: context.searchedScope.automatic,
      }),
    },
  };
}

export const systemPrompt = (intent: AssistantIntent): string =>
  `${COMMON_POLICY.text.trimEnd()}\n\n${INTENT_ASSETS[intent].text.trimEnd()}`;

export function initialMessages(intent: AssistantIntent, request: AssistantRequest): ChatMessage[] {
  const utterance = request.utterance.trim();
  const asked = utterance === '' || utterance.startsWith('/') ? DEFAULT_REQUEST[intent] : utterance;
  const parts = [`CONTEXT\n${JSON.stringify(modelContextView(request.context))}`];
  if (request.history.length > 0) parts.push(`HISTORY\n${JSON.stringify(request.history)}`);
  parts.push(`REQUEST\n${asked}`);
  return [
    { role: 'system', content: systemPrompt(intent) },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

const OUTPUT_SCHEMA = toProviderSchema(modelOutputSchema);
const INTENT_SCHEMA = toProviderSchema(intentSelectionOutputSchema);

/** json_schema is sent as the response format; json_object needs the schema and the word JSON in the prompt. */
function structured(
  mode: OutputMode,
  name: string,
  schema: Record<string, unknown>,
  instruction: string,
): { format: ResponseFormat; instruction: string } {
  return mode === 'json_schema'
    ? { format: { mode, name, schema }, instruction }
    : {
        format: { mode },
        instruction: `${instruction}\nThe JSON object must match this JSON schema exactly:\n${JSON.stringify(schema)}`,
      };
}

export const finalRound = (mode: OutputMode) =>
  structured(
    mode,
    OUTPUT_SCHEMA_NAME,
    OUTPUT_SCHEMA,
    'Give the final answer now: one JSON object matching the supplied schema and nothing else.',
  );

/** A repair names what was rejected by code. It never repeats the case or suggests content. */
export const repairRound = (mode: OutputMode, codes: readonly string[]) =>
  structured(
    mode,
    OUTPUT_SCHEMA_NAME,
    OUTPUT_SCHEMA,
    `Your previous JSON was rejected: ${codes.slice(0, 8).join(', ')}. Return one corrected JSON object matching the supplied schema. Use only handles, rule IDs and tool results you were given. Do not add facts.`,
  );

export const toolRepairInstruction = (codes: readonly string[]): string =>
  `Your previous tool call was rejected: ${codes.slice(0, 8).join(', ')}. Call one offered tool with valid arguments, or reply DONE.`;

/** The single bounded classification request. It sees the utterance only: no context, no history. */
export function routerRound(mode: OutputMode, utterance: string) {
  const { format, instruction } = structured(
    mode,
    INTENT_SCHEMA_NAME,
    INTENT_SCHEMA,
    'Return the JSON classification now.',
  );
  const messages: ChatMessage[] = [
    { role: 'system', content: ROUTER_ASSET.text.trimEnd() },
    { role: 'user', content: `REQUEST\n${utterance}\n\n${instruction}` },
  ];
  return { format, messages };
}

/** Which pinned assets and schemas a run used, by digest. */
export function promptManifestRef(
  intent: AssistantIntent | null,
  tools: readonly AssistantToolName[],
): NonNullable<AgentConfigV1['prompts']> {
  return {
    manifestVersion: PROMPT_MANIFEST_VERSION,
    commonPolicySha256: COMMON_POLICY.sha256,
    intent,
    intentAssetSha256: intent === null ? null : INTENT_ASSETS[intent].sha256,
    outputSchemaSha256: OUTPUT_SCHEMA_SHA256,
    tools: tools.map((name) => ({
      name,
      version: TOOL_VERSION,
      schemaSha256: TOOL_SCHEMA_SHA256[name],
    })),
  };
}

export const ROUTER_DIGESTS = Object.freeze({
  routerAssetSha256: ROUTER_ASSET.sha256,
  intentSchemaSha256: INTENT_SCHEMA_SHA256,
});
