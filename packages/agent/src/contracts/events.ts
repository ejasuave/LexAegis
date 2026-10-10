import { z } from 'zod';
import { applicationErrorSchema, opaqueIdSchema, rfc3339TimestampSchema } from '@lexaegis/protocol';
import { digestSchema } from '@lexaegis/protocol/v1';
import { agentConfigSchema } from './agent-config';
import {
  agentRunMetadataSchema,
  answerBlockSchema,
  assistantPlanSchema,
  assistantRunStateSchema,
  responseSummarySchema,
  runFailureCodeSchema,
} from './assistant';
import { assistantToolNameSchema, toolResultSchema } from './tool-results';

/*
 * Server-sent run events. Every event carries the run, matter, version, input snapshot and vault
 * generation it belongs to, and a contiguous per-run sequence number. Exactly one terminal event
 * ends a run. No event means a human approved anything or that a transaction exists.
 */

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
    z.strictObject({
      outcome: z.enum(['completed', 'needs_input', 'limited_scope']),
      /** What actually ran, for the provenance artifact. Written from the execution itself. */
      agentConfig: agentConfigSchema,
      ...terminal,
    }),
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
