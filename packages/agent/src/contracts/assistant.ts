import { z } from 'zod';
import { applicationErrorSchema, opaqueIdSchema, rfc3339TimestampSchema } from '@lexaegis/protocol';
import { digestSchema, timestampSchema, uuidSchema } from '@lexaegis/protocol/v1';
import { ASSISTANT_LIMITS, jsonBytes, utf8Bytes } from './limits';
import {
  confirmedFactSchema,
  evidenceSelectionSchema,
  extractionWarningSchema,
  factFieldSchema,
  sourceReferenceSchema,
} from './review';
import {
  assistantToolNameSchema,
  clientObservedStatusSchema,
  providerIdSchema,
  ruleIdSchema,
  sourceHandleSchema,
  toolHandleSchema,
  toolResultSchema,
} from './tool-results';

/*
 * Assistant request, plan, response and event contracts. Closed and versioned. Nothing in a run
 * state, a response or an event means a human approved anything, a signature exists or a
 * transaction was sent: those have their own gates outside the assistant.
 */

/**
 * Allowed assistant intents. Stop is a controller operation handled by code, never a model intent.
 * No sign, approve, revoke, supersede, send-message or arbitrary-execution capability exists here.
 */
export const assistantIntentSchema = z.enum([
  'summarise',
  'explain',
  'check_payments',
  'missing_evidence',
  'brief_matter',
  'prepare_review',
  'status',
]);
export type AssistantIntent = z.infer<typeof assistantIntentSchema>;

/** How an intent was chosen. Only an ambiguous free-text request may use a model completion. */
export const intentSelectionSchema = z.strictObject({
  schema: z.literal('lexaegis.intent-selection.v1'),
  intent: assistantIntentSchema.nullable(),
  via: z.enum(['command', 'ui_action', 'phrase', 'model', 'none']),
  /** Set when no intent applies: the request is asked back or declined, never guessed. */
  disposition: z.enum(['selected', 'clarify', 'unsupported']),
});
export type IntentSelectionV1 = z.infer<typeof intentSelectionSchema>;

// ---- Selected context -----------------------------------------------------------------------------

/**
 * One consented excerpt. The model is shown the handle, page and text only; the full reference
 * (hashes, offsets, artifact IDs) stays in application memory and is never model-authored.
 */
export const sourceCatalogEntrySchema = z.strictObject({
  handle: sourceHandleSchema,
  reference: sourceReferenceSchema,
  coverage: z.enum(['complete', 'partial', 'none']),
  warnings: z.array(extractionWarningSchema).max(16),
});
export type SourceCatalogEntry = z.infer<typeof sourceCatalogEntrySchema>;

const limitIssue = (ctx: { issues: unknown[]; value: unknown }, message: string, path: string) =>
  (ctx.issues as { code: 'custom'; message: string; input: unknown; path: string[] }[]).push({
    code: 'custom',
    message,
    input: ctx.value,
    path: [path],
  });

/**
 * The deliberate selection a request discloses: excerpts, confirmed facts, evidence descriptors
 * and explicitly selected saved context. Everything in it is untrusted document data, never an
 * instruction. Excerpts are partial, so absence in them says nothing about the whole document.
 */
export const selectedContextSchema = z
  .strictObject({
    schema: z.literal('lexaegis.selected-context.v1'),
    matterId: uuidSchema,
    /** Null for a matter-level request. A document identity is never invented. */
    documentVersionId: uuidSchema.nullable(),
    untrustedDocumentData: z.literal(true),
    sources: z.array(sourceCatalogEntrySchema),
    facts: z.array(confirmedFactSchema).max(200),
    evidence: z.array(evidenceSelectionSchema).max(40),
    savedContext: z
      .array(
        z.strictObject({
          entryId: opaqueIdSchema,
          kind: z.enum(['note', 'outcome']),
          text: z.string().min(1).max(8192),
        }),
      )
      .max(ASSISTANT_LIMITS.savedContextEntries),
    /** The documents the selection came from. Coverage is that of the excerpts, not the files. */
    searchedScope: z.strictObject({
      documentVersionIds: z.array(uuidSchema).max(8),
      excerptsOnly: z.literal(true),
    }),
  })
  .check((ctx) => {
    const context = ctx.value;
    if (context.sources.length > ASSISTANT_LIMITS.catalogEntries) {
      limitIssue(ctx, 'CATALOG_TOO_LARGE', 'sources');
      return;
    }
    context.sources.forEach((entry, index) => {
      if (entry.handle !== `S${index + 1}`) limitIssue(ctx, 'handle order', 'sources');
      if (utf8Bytes(entry.reference.quote) > ASSISTANT_LIMITS.quoteBytes)
        limitIssue(ctx, 'QUOTE_TOO_LONG', 'sources');
      if (!context.searchedScope.documentVersionIds.includes(entry.reference.documentVersionId))
        limitIssue(ctx, 'source outside searched scope', 'sources');
    });
    if (context.facts.some((fact) => fact.matterId !== context.matterId))
      limitIssue(ctx, 'fact from another matter', 'facts');
    if (
      context.documentVersionId !== null &&
      !context.searchedScope.documentVersionIds.includes(context.documentVersionId)
    )
      limitIssue(ctx, 'selected version outside searched scope', 'documentVersionId');
    if (jsonBytes(context) > ASSISTANT_LIMITS.contextBytes)
      limitIssue(ctx, 'CONTEXT_TOO_LARGE', 'sources');
  });
export type SelectedContextV1 = z.infer<typeof selectedContextSchema>;

/** Prior conversation text: bounded, untrusted data. System, tool and provider roles do not exist. */
export const conversationMessageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(ASSISTANT_LIMITS.utteranceBytes),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

// ---- Disclosure consent ---------------------------------------------------------------------------

/** Who receives disclosed text. The region is the endpoint's identifier, not a residency promise. */
export const providerScopeSchema = z.strictObject({
  provider: providerIdSchema,
  model: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  region: z.string().regex(/^[a-z0-9-]{1,40}$/),
});
export type ProviderScope = z.infer<typeof providerScopeSchema>;

/**
 * Consent to one exact disclosure. The digest covers the provider scope and the exact serialized
 * request content; any change to either needs a new explicit Send. Vault unlock, local intake or
 * an earlier conversation never stand in for it.
 */
export const disclosureConsentSchema = z.strictObject({
  schema: z.literal('lexaegis.disclosure-consent.v1'),
  action: z.literal('explicit_send'),
  providerScope: providerScopeSchema,
  matterId: uuidSchema,
  documentVersionId: uuidSchema.nullable(),
  disclosureDigest: digestSchema,
  consentedAt: timestampSchema,
});
export type DisclosureConsentV1 = z.infer<typeof disclosureConsentSchema>;

// ---- Request --------------------------------------------------------------------------------------

/**
 * One assistant request. The account and the run are derived by the server from the session; no
 * field here names an owner, a provider endpoint, a system message, a tool message or an approval.
 */
export const assistantRequestSchema = z
  .strictObject({
    schema: z.literal('lexaegis.assistant-request.v1'),
    clientRequestId: uuidSchema,
    matterId: uuidSchema,
    documentVersionId: uuidSchema.nullable(),
    /** The review inputs this request was built from. A different digest is a different request. */
    snapshot: z.strictObject({ digest: digestSchema, revision: z.int().min(0).max(1_000_000) }),
    vaultGeneration: z.int().min(0).max(1_000_000_000),
    /** Set for commands and interface actions; null lets the router classify free text. */
    intent: assistantIntentSchema.nullable(),
    trigger: z.enum(['command', 'ui_action', 'free_text']),
    utterance: z.string().max(ASSISTANT_LIMITS.utteranceBytes),
    context: selectedContextSchema,
    history: z.array(conversationMessageSchema),
    clientObserved: clientObservedStatusSchema.nullable(),
    consent: disclosureConsentSchema,
  })
  .check((ctx) => {
    const request = ctx.value;
    if (utf8Bytes(request.utterance) > ASSISTANT_LIMITS.utteranceBytes)
      limitIssue(ctx, 'UTTERANCE_TOO_LARGE', 'utterance');
    if (
      request.history.length > ASSISTANT_LIMITS.historyMessages ||
      request.history.reduce((sum, message) => sum + utf8Bytes(message.text), 0) >
        ASSISTANT_LIMITS.historyBytes
    )
      limitIssue(ctx, 'HISTORY_TOO_LARGE', 'history');
    if (
      request.context.matterId !== request.matterId ||
      request.context.documentVersionId !== request.documentVersionId
    )
      limitIssue(ctx, 'context binding', 'context');
    if (
      request.consent.matterId !== request.matterId ||
      request.consent.documentVersionId !== request.documentVersionId
    )
      limitIssue(ctx, 'consent binding', 'consent');
    if (request.trigger !== 'free_text' && request.intent === null)
      limitIssue(ctx, 'intent required', 'intent');
  });
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;
export type AssistantRequestV1 = AssistantRequest;

// ---- Plan -----------------------------------------------------------------------------------------

export const planStepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
]);

/** A bounded plan of at most five observable steps. Steps describe work, not model reasoning. */
export const assistantPlanSchema = z.strictObject({
  schema: z.literal('lexaegis.assistant-plan.v1'),
  steps: z
    .array(
      z.strictObject({
        stepId: opaqueIdSchema,
        label: z.string().min(1).max(120),
        status: planStepStatusSchema,
      }),
    )
    .min(1)
    .max(ASSISTANT_LIMITS.planSteps),
});
export type AssistantPlan = z.infer<typeof assistantPlanSchema>;

// ---- Response -------------------------------------------------------------------------------------

/** supported: the cited references carry the statement. Otherwise it is marked as such. */
export const answerBasisSchema = z.enum(['supported', 'interpretation', 'uncertain']);
export type AnswerBasis = z.infer<typeof answerBasisSchema>;

const references = {
  sources: z.array(sourceHandleSchema).max(8),
  rules: z.array(ruleIdSchema).max(8),
  tools: z.array(toolHandleSchema).max(4),
};
const blockText = z.string().min(1).max(2000);
const comment = z.string().max(500);

/**
 * Answer blocks refer to sources, rules and tool results by handle. A quotation shows the
 * catalog's stored quote; a calculation or status shows the referenced code result. No block
 * carries a model-typed hash, offset, total or chain status.
 */
export const answerBlockSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('explanation'),
    text: blockText,
    basis: answerBasisSchema,
    ...references,
  }),
  z.strictObject({ kind: z.literal('quotation'), source: sourceHandleSchema, comment }),
  z.strictObject({ kind: z.literal('calculation'), tool: toolHandleSchema, comment }),
  z.strictObject({
    kind: z.literal('finding'),
    text: blockText,
    basis: answerBasisSchema,
    ...references,
  }),
  z.strictObject({ kind: z.literal('status'), tool: toolHandleSchema, comment }),
]);
export type AnswerBlock = z.infer<typeof answerBlockSchema>;

/**
 * A proposed fact. It is a proposal only: there is no confirmed state, decision record or
 * approval field, and it becomes a FactCandidateV1 for the reviewer's explicit confirmation.
 */
export const factProposalSchema = z.strictObject({
  proposalId: z.string().regex(/^P(?:[1-9]|10)$/),
  field: factFieldSchema,
  group: z.string().regex(/^[a-z0-9-]{1,40}$/),
  slot: z.string().regex(/^[a-z0-9-]{1,40}$/),
  value: z.string().min(1).max(512),
  sources: z.array(sourceHandleSchema).min(1).max(4),
});
export type FactProposal = z.infer<typeof factProposalSchema>;

export const unresolvedItemSchema = z.strictObject({
  code: z.enum([
    'MISSING_INPUT',
    'UNCONFIRMED_FACT',
    'UNSUPPORTED_CLAIM',
    'REVIEWER_STATEMENT_REQUIRED',
    'OUT_OF_SCOPE',
    'NEEDS_NARROWING',
  ]),
  text: z.string().min(1).max(300),
});
export type UnresolvedItem = z.infer<typeof unresolvedItemSchema>;

/** The only identifiers that can become a control the reviewer operates. Nothing runs by itself. */
export const NEXT_ACTIONS = [
  'open_source',
  'confirm_fact',
  'run_payment_check',
  'link_evidence',
  'select_more_context',
  'prepare_review',
  'save_outcome',
  'open_status',
] as const;
export const nextActionSchema = z.enum(NEXT_ACTIONS);
export type NextAction = z.infer<typeof nextActionSchema>;

export const modelExecutionSchema = z.enum(['qwen', 'scripted-test', 'none']);
export type ModelExecution = z.infer<typeof modelExecutionSchema>;

const responseBody = {
  intent: assistantIntentSchema.nullable(),
  /** completed and limited_scope carry an answer; needs_input asks for more. None is approval. */
  outcome: z.enum(['completed', 'needs_input', 'limited_scope']),
  modelExecution: modelExecutionSchema,
  factProposals: z.array(factProposalSchema).max(ASSISTANT_LIMITS.factProposals),
  unresolved: z.array(unresolvedItemSchema).max(ASSISTANT_LIMITS.unresolvedItems),
  questions: z.array(z.string().min(1).max(300)).max(3),
  scopeLimitations: z.array(z.string().min(1).max(300)).max(8),
  nextActions: z.array(nextActionSchema).max(6),
};

export const responseSummarySchema = z.strictObject({
  ...responseBody,
  blockCount: z.int().min(0).max(ASSISTANT_LIMITS.answerBlocks),
});
export type ResponseSummary = z.infer<typeof responseSummarySchema>;

export const assistantResponseSchema = z
  .strictObject({
    schema: z.literal('lexaegis.assistant-response.v1'),
    runId: opaqueIdSchema,
    ...responseBody,
    blocks: z.array(answerBlockSchema).max(ASSISTANT_LIMITS.answerBlocks),
    snapshotDigest: digestSchema,
    vaultGeneration: z.int().min(0),
  })
  .check((ctx) => {
    if (jsonBytes(ctx.value) > ASSISTANT_LIMITS.outputBytes)
      limitIssue(ctx, 'OUTPUT_TOO_LARGE', 'blocks');
  });
export type AssistantResponse = z.infer<typeof assistantResponseSchema>;
export type AssistantResponseV1 = AssistantResponse;

// ---- Run state ------------------------------------------------------------------------------------

/**
 * Assistant run state is independent of wallet, vault, review and blockchain state.
 * `completed` never implies human approval, a valid signature or a confirmed transaction.
 * awaiting_input is terminal: the run finished by asking; a reply starts a new run.
 * interrupted: the worker stopped without acknowledging, so the provider outcome is unknown.
 */
export const assistantRunStateSchema = z.enum([
  'queued',
  'running',
  'awaiting_input',
  'stopping',
  'completed',
  'cancelled',
  'failed',
  'interrupted',
]);
export type AssistantRunState = z.infer<typeof assistantRunStateSchema>;

export const TERMINAL_RUN_STATES: readonly AssistantRunState[] = [
  'awaiting_input',
  'completed',
  'cancelled',
  'failed',
  'interrupted',
];
export const isTerminalRunState = (state: AssistantRunState): boolean =>
  TERMINAL_RUN_STATES.includes(state);

export const runOutcomeSchema = z.enum([
  'completed',
  'needs_input',
  'limited_scope',
  'cancelled',
  'failed',
  'interrupted',
]);
export type RunOutcome = z.infer<typeof runOutcomeSchema>;

export const runFailureCodeSchema = z.enum([
  'NOT_CONFIGURED',
  'NOT_VERIFIED',
  'FEATURE_DISABLED',
  'UNSUPPORTED_REQUEST',
  'STALE_SNAPSHOT',
  'SESSION_INVALID',
  'PROVIDER_AUTHENTICATION',
  'PROVIDER_CAPABILITY',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_TRANSPORT',
  'PROVIDER_REFUSAL',
  'OUTPUT_MALFORMED',
  'OUTPUT_TRUNCATED',
  'PARALLEL_TOOL_CALLS',
  'TOOL_LIMIT',
  'BUDGET_EXHAUSTED',
  'DEADLINE_EXCEEDED',
  'INTERNAL',
]);
export type RunFailureCode = z.infer<typeof runFailureCodeSchema>;

// ---- Events ---------------------------------------------------------------------------------------

const eventBase = {
  schema: z.literal('lexaegis.assistant-event.v1'),
  runId: opaqueIdSchema,
  matterId: opaqueIdSchema,
  documentVersionId: opaqueIdSchema.nullable(),
  /** The inputs and vault generation the run is bound to; an event for others is discarded. */
  snapshotDigest: digestSchema,
  vaultGeneration: z.int().min(0),
  /** Contiguous per-run sequence number, starting at 1. */
  seq: z.int().min(1),
  timestamp: rfc3339TimestampSchema,
};

function event<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.strictObject({ ...eventBase, type: z.literal(type), payload });
}

/** Counters only. Usage is reported, or explicitly unknown; never guessed. */
export const runUsageSchema = z.strictObject({
  provenance: z.enum(['provider_reported', 'partially_reported', 'unknown', 'none']),
  providerAttempts: z.int().min(0).max(64),
  toolExecutions: z.int().min(0).max(64),
  /** Conservative reservation, labelled as an estimate; not a token count. */
  reservedInputTokens: z.int().min(0),
  reservedOutputTokens: z.int().min(0),
  inputEstimate: z.enum(['conservative_utf8_bytes', 'none']),
  reportedInputTokens: z.int().min(0).nullable(),
  reportedOutputTokens: z.int().min(0).nullable(),
});
export type RunUsage = z.infer<typeof runUsageSchema>;

/**
 * Operational facts about one run: identifiers, state, deadlines and counters. It holds no
 * matter, document, prompt, answer or tool payload, and it is all a status lookup ever returns.
 */
export const agentRunMetadataSchema = z.strictObject({
  schema: z.literal('lexaegis.agent-run-metadata.v1'),
  runId: opaqueIdSchema,
  clientRequestId: opaqueIdSchema,
  state: assistantRunStateSchema,
  outcome: runOutcomeSchema.nullable(),
  cancelRequested: z.boolean(),
  /** True when this request ID had already been admitted: nothing ran again for it. */
  repeatedAdmission: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  deadlineAt: timestampSchema,
  usage: runUsageSchema,
});
export type AgentRunMetadataV1 = z.infer<typeof agentRunMetadataSchema>;

const terminal = { metadata: agentRunMetadataSchema };

export const assistantEventSchema = z.discriminatedUnion('type', [
  event('plan_updated', z.strictObject({ plan: assistantPlanSchema })),
  event('state_changed', z.strictObject({ state: assistantRunStateSchema })),
  event(
    'tool_started',
    z.strictObject({ toolCallId: opaqueIdSchema, toolName: assistantToolNameSchema }),
  ),
  event('tool_result', z.strictObject({ result: toolResultSchema })),
  /** One complete, validated block. Never raw provider text or a partial answer. */
  event(
    'response_delta',
    z.strictObject({ index: z.int().min(0).max(7), block: answerBlockSchema }),
  ),
  event('response_completed', z.strictObject({ summary: responseSummarySchema })),
  event(
    'output_reference',
    z.strictObject({ outputId: opaqueIdSchema, kind: z.enum(['response', 'draft_artifact']) }),
  ),
  event(
    'run_completed',
    z.strictObject({ outcome: z.enum(['completed', 'needs_input', 'limited_scope']), ...terminal }),
  ),
  event('run_cancelled', z.strictObject(terminal)),
  event(
    'run_failed',
    z.strictObject({
      error: applicationErrorSchema,
      failure: runFailureCodeSchema,
      /** Validated tool results delivered before the failure remain usable as partial work. */
      partial: z.boolean(),
      ...terminal,
    }),
  ),
  event('run_interrupted', z.strictObject(terminal)),
]);
export type AssistantEvent = z.infer<typeof assistantEventSchema>;
export type AssistantEventV1 = AssistantEvent;

export const TERMINAL_EVENT_TYPES: readonly AssistantEvent['type'][] = [
  'run_completed',
  'run_cancelled',
  'run_failed',
  'run_interrupted',
];

/** Explicit cancellation, bound to the authenticated run owner (derived server-side, never from the browser). */
export const cancelRunInputSchema = z.strictObject({
  runId: opaqueIdSchema,
  ownerId: opaqueIdSchema,
});
export type CancelRunInput = z.infer<typeof cancelRunInputSchema>;

/** What the browser may learn about the configured provider before any disclosure. */
export const assistantAvailabilitySchema = z.strictObject({
  schema: z.literal('lexaegis.assistant-availability.v1'),
  /** verified: capability checks passed for this exact endpoint, model and output mode. */
  state: z.enum(['not_configured', 'configured_unverified', 'verified', 'test_provider']),
  providerScope: providerScopeSchema.nullable(),
  /** What is known about the provider's handling. Unknown stays unknown. */
  notices: z.array(z.string().min(1).max(240)).max(6),
  briefingEnabled: z.boolean(),
});
export type AssistantAvailability = z.infer<typeof assistantAvailabilitySchema>;
