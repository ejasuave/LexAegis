import { z } from 'zod';
import { applicationErrorSchema, opaqueIdSchema, rfc3339TimestampSchema } from '@lexaegis/protocol';

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

/** Pointer to evidence the application already holds. Chapter 8 extends this with offsets and hashes. */
export const evidenceReferenceSchema = z.strictObject({
  referenceId: opaqueIdSchema,
  documentVersionId: opaqueIdSchema,
  locator: z.string().min(1).max(256),
});
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;

/** Selected matter/document/source context. documentVersionId is null for matter-level requests. */
export const selectedContextSchema = z.strictObject({
  matterId: opaqueIdSchema,
  documentVersionId: opaqueIdSchema.nullable(),
  sourceReferences: z.array(evidenceReferenceSchema).max(64),
});
export type SelectedContext = z.infer<typeof selectedContextSchema>;

export const assistantRequestSchema = z.strictObject({
  schema: z.literal('lexaegis.assistant-request.v1'),
  clientRequestId: opaqueIdSchema,
  intent: assistantIntentSchema,
  utterance: z.string().max(4096),
  context: selectedContextSchema,
});
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;

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
    .max(5),
});
export type AssistantPlan = z.infer<typeof assistantPlanSchema>;

export const toolResultSchema = z.strictObject({
  schema: z.literal('lexaegis.tool-result.v1'),
  toolCallId: opaqueIdSchema,
  toolName: assistantToolNameSchema,
  outcome: z.enum(['succeeded', 'failed']),
  summary: z.string().max(500),
  evidence: z.array(evidenceReferenceSchema).max(20),
});
export type ToolResult = z.infer<typeof toolResultSchema>;

export const answerBlockSchema = z.strictObject({
  kind: z.enum(['explanation', 'quotation', 'calculation', 'finding', 'status']),
  text: z.string().min(1).max(4000),
  references: z.array(evidenceReferenceSchema).max(20),
});
export type AnswerBlock = z.infer<typeof answerBlockSchema>;

export const assistantResponseSchema = z.strictObject({
  schema: z.literal('lexaegis.assistant-response.v1'),
  runId: opaqueIdSchema,
  blocks: z.array(answerBlockSchema).max(8),
});
export type AssistantResponse = z.infer<typeof assistantResponseSchema>;

/**
 * Assistant run state is independent of wallet, vault, review and blockchain state.
 * `completed` never implies human approval, a valid signature or a confirmed transaction.
 */
export const assistantRunStateSchema = z.enum([
  'queued',
  'running',
  'awaiting_input',
  'stopping',
  'completed',
  'cancelled',
  'failed',
]);
export type AssistantRunState = z.infer<typeof assistantRunStateSchema>;

const eventBase = {
  schema: z.literal('lexaegis.assistant-event.v1'),
  runId: opaqueIdSchema,
  matterId: opaqueIdSchema,
  documentVersionId: opaqueIdSchema.nullable(),
  /** Monotonic per-run sequence number, starting at 1. */
  seq: z.int().min(1),
  timestamp: rfc3339TimestampSchema,
};

function event<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.strictObject({ ...eventBase, type: z.literal(type), payload });
}

const emptyPayload = z.strictObject({});

export const assistantEventSchema = z.discriminatedUnion('type', [
  event('plan_updated', z.strictObject({ plan: assistantPlanSchema })),
  event('state_changed', z.strictObject({ state: assistantRunStateSchema })),
  event(
    'tool_started',
    z.strictObject({ toolCallId: opaqueIdSchema, toolName: assistantToolNameSchema }),
  ),
  event('tool_result', z.strictObject({ result: toolResultSchema })),
  event('response_delta', z.strictObject({ block: answerBlockSchema })),
  event(
    'output_reference',
    z.strictObject({ outputId: opaqueIdSchema, kind: z.enum(['response', 'draft_artifact']) }),
  ),
  event('run_completed', emptyPayload),
  event('run_cancelled', emptyPayload),
  event('run_failed', z.strictObject({ error: applicationErrorSchema })),
]);
export type AssistantEvent = z.infer<typeof assistantEventSchema>;

/** Explicit cancellation, bound to the authenticated run owner (derived server-side, never from the browser). */
export const cancelRunInputSchema = z.strictObject({
  runId: opaqueIdSchema,
  ownerId: opaqueIdSchema,
});
export type CancelRunInput = z.infer<typeof cancelRunInputSchema>;
