import { z } from 'zod';
import { opaqueIdSchema } from '@lexaegis/protocol';
import { digestSchema, uuidSchema } from '@lexaegis/protocol/v1';
import { ASSISTANT_LIMITS, jsonBytes } from './limits';
import {
  evaluatorKeySchema,
  evidenceStateSchema,
  extractionWarningSchema,
  paymentReconciliationSchema,
} from './review';

/*
 * Results of the six read-only review tools. Every value here was produced by application code;
 * a model can only refer to a result by its run-scoped handle. No tool can approve, sign, save,
 * freeze, confirm a fact, change a rule or reach a URL.
 */

/** Read-only tools the model may request. Approval and signing are deliberately absent. */
export const assistantToolNameSchema = z.enum([
  'read_sources',
  'get_rules',
  'check_payments',
  'check_evidence',
  'get_status',
  'prepare_review',
]);
export type AssistantToolName = z.infer<typeof assistantToolNameSchema>;

/** Source handle S1…S64, issued deterministically for one request's consented catalog. */
export const sourceHandleSchema = z.string().regex(/^S(?:[1-9]|[1-5][0-9]|6[0-4])$/);
/** Tool-result handle T1…T8, issued by the server for one run. */
export const toolHandleSchema = z.string().regex(/^T[1-8]$/);
export const ruleIdSchema = z.string().regex(/^[a-z0-9-]{1,60}$/);

export const providerIdSchema = z.enum(['qwen', 'scripted-test']);
export type ProviderId = z.infer<typeof providerIdSchema>;

/**
 * What the browser reports about its own state. The server cannot inspect browser-held keys or
 * the vault, so these readings are labelled client_observed wherever they are shown.
 */
export const clientObservedStatusSchema = z.strictObject({
  provenance: z.literal('client_observed'),
  account: z.enum(['none', 'locked', 'unlocked', 'unknown']),
  vault: z.enum(['unavailable', 'locked', 'unlocked', 'unknown']),
  vaultSave: z.enum(['saved', 'unsaved', 'saving', 'conflict', 'error', 'unknown']),
  checks: z.enum(['none', 'running', 'fresh', 'stale', 'unknown']),
  selectedDocuments: z.int().min(0).max(8),
  confirmedFacts: z.int().min(0).max(200),
  savedPackages: z.int().min(0).max(1000),
});
export type ClientObservedStatus = z.infer<typeof clientObservedStatusSchema>;

/** Separate readings. None implies another: a run says nothing about approval or a receipt. */
export const statusReadingSchema = z.strictObject({
  scope: z.enum(['matter', 'selected_receipt']),
  assistant: z.strictObject({
    provenance: z.literal('server'),
    provider: providerIdSchema,
    capability: z.enum(['verified', 'configured', 'test']),
  }),
  session: z.strictObject({ provenance: z.literal('server'), signedIn: z.literal(true) }),
  client: clientObservedStatusSchema.nullable(),
  liveChain: z.strictObject({
    provenance: z.literal('server'),
    state: z.enum(['ready', 'not_configured', 'not_deployed', 'unknown']),
  }),
  indexedHistory: z.strictObject({ state: z.enum(['not_connected', 'unknown']) }),
  /** A receipt is read only for an explicitly selected public reference; otherwise not_selected. */
  receipt: z.strictObject({
    lifecycle: z.enum(['active', 'revoked', 'superseded', 'not_found', 'unknown', 'not_selected']),
    provenance: z.enum(['live_read', 'none']),
  }),
});
export type StatusReading = z.infer<typeof statusReadingSchema>;

export const draftRequirementCodeSchema = z.enum([
  'AGENT_CONFIG_MISSING',
  'DECISION_LOG_MISSING',
  'HUMAN_REVIEW_GATE_PENDING',
  'EVIDENCE_NOT_CONFIRMED',
  'FINDING_UNRESOLVED',
  'INPUT_NOT_CONFIRMED',
  'NO_DOCUMENT_SELECTED',
]);

const readSourcesOutput = z.strictObject({
  tool: z.literal('read_sources'),
  /** Only excerpts of the consented catalog; never the whole document. */
  searchedScope: z.literal('selected_excerpts'),
  sources: z
    .array(
      z.strictObject({
        handle: sourceHandleSchema,
        documentVersionId: uuidSchema,
        page: z.int().min(1).max(80),
        text: z.string().min(1),
        coverage: z.enum(['complete', 'partial', 'none']),
        warnings: z.array(extractionWarningSchema).max(16),
      }),
    )
    .max(ASSISTANT_LIMITS.catalogEntries),
});

const getRulesOutput = z.strictObject({
  tool: z.literal('get_rules'),
  packId: z.string().max(80),
  packVersion: z.string().max(8),
  packDigest: digestSchema,
  /** The pack's actual review state. demo_draft means nobody has reviewed its content. */
  reviewState: z.enum(['demo_draft', 'reviewed']),
  rules: z
    .array(
      z.strictObject({
        ruleId: ruleIdSchema,
        title: z.string().max(160),
        category: z.enum(['statutory_checklist', 'product_check']),
        evaluator: evaluatorKeySchema,
        requiredInputs: z.array(z.string().max(60)).max(8),
        evidenceRequirement: z.string().max(40).nullable(),
        prompt: z.string().max(400),
      }),
    )
    .max(40),
});

const checkPaymentsOutput = z.strictObject({
  tool: z.literal('check_payments'),
  /** Computed by the Chapter 8 calculator from confirmed facts only. */
  result: paymentReconciliationSchema,
});

const checkEvidenceOutput = z.strictObject({
  tool: z.literal('check_evidence'),
  /** What was searched: the reviewer's evidence links for the selected documents, nothing wider. */
  searchedScope: z.literal('reviewer_links_for_selected_documents'),
  searchedDocumentVersionIds: z.array(uuidSchema).max(8),
  assessed: z.boolean(),
  items: z
    .array(
      z.strictObject({
        ruleId: ruleIdSchema,
        requirement: z.string().max(40),
        state: evidenceStateSchema,
        linkedArtifacts: z.int().min(0).max(16),
      }),
    )
    .max(40),
});

const getStatusOutput = z.strictObject({
  tool: z.literal('get_status'),
  status: statusReadingSchema,
});

const prepareReviewOutput = z.strictObject({
  tool: z.literal('prepare_review'),
  /** A preview of requirements. Nothing was saved, frozen, signed or sent. */
  saved: z.literal(false),
  frozen: z.literal(false),
  requirements: z
    .array(z.strictObject({ code: draftRequirementCodeSchema, detail: z.string().min(1).max(200) }))
    .max(80),
});

export const toolOutputSchema = z.discriminatedUnion('tool', [
  readSourcesOutput,
  getRulesOutput,
  checkPaymentsOutput,
  checkEvidenceOutput,
  getStatusOutput,
  prepareReviewOutput,
]);
export type ToolOutput = z.infer<typeof toolOutputSchema>;

export const TOOL_VERSION = '1';

export const toolResultSchema = z
  .strictObject({
    schema: z.literal('lexaegis.tool-result.v1'),
    /** Server-issued, valid inside this run only. */
    handle: toolHandleSchema,
    toolCallId: opaqueIdSchema,
    toolName: assistantToolNameSchema,
    toolVersion: z.literal(TOOL_VERSION),
    /** needs_narrowing: the result would exceed its limit; nothing partial is returned. */
    outcome: z.enum(['succeeded', 'failed', 'needs_narrowing']),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/),
    output: toolOutputSchema.nullable(),
  })
  .check((ctx) => {
    const result = ctx.value;
    const bad = (message: string) =>
      ctx.issues.push({ code: 'custom', message, input: result, path: ['output'] });
    if (result.outcome === 'succeeded' && result.output === null) bad('missing output');
    if (result.outcome !== 'succeeded' && result.output !== null) bad('output on failure');
    if (result.output !== null && result.output.tool !== result.toolName) bad('tool mismatch');
    if (jsonBytes(result) > ASSISTANT_LIMITS.toolResultBytes + 512) bad('TOOL_RESULT_TOO_LARGE');
  });
export type ToolResult = z.infer<typeof toolResultSchema>;
