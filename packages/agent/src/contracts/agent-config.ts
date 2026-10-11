import { z } from 'zod';
import { agentIdentityRefSchema, opaqueIdSchema } from '@lexaegis/protocol';
import { digestSchema, timestampSchema } from '@lexaegis/protocol/v1';
import {
  assistantIntentSchema,
  modelExecutionSchema,
  runOutcomeSchema,
  runUsageSchema,
} from './assistant';
import { assistantToolNameSchema } from './tool-results';

/*
 * AgentConfigV1: what actually ran. It is written from the execution, never from intentions.
 * A code-only handler records modelExecution "none" and no provider section. Unknown stays
 * unknown. It holds no credential, endpoint URL, workspace identifier, prompt text or transcript.
 */

export const outputModeSchema = z.enum(['json_schema', 'json_object']);
export type OutputMode = z.infer<typeof outputModeSchema>;

/** Hard ceilings of one run. Client input can never raise them. */
export const runBudgetSchema = z.strictObject({
  providerAttempts: z.int().min(1).max(6),
  toolExecutions: z.int().min(0).max(8),
  totalMs: z.int().min(1000).max(120_000),
  attemptMs: z.int().min(1000).max(25_000),
  completionTokensPerAttempt: z.int().min(64).max(2048),
  completionTokensPerRun: z.int().min(64).max(8192),
  inputTokensPerAttempt: z.int().min(1024).max(65_536),
  inputTokensPerRun: z.int().min(1024).max(196_608),
});
export type RunBudget = z.infer<typeof runBudgetSchema>;

export const promptManifestRefSchema = z.strictObject({
  manifestVersion: z.string().regex(/^[1-9][0-9]*$/),
  commonPolicySha256: digestSchema,
  intent: assistantIntentSchema.nullable(),
  intentAssetSha256: digestSchema.nullable(),
  outputSchemaSha256: digestSchema,
  tools: z
    .array(
      z.strictObject({
        name: assistantToolNameSchema,
        version: z.string().regex(/^[1-9][0-9]*$/),
        schemaSha256: digestSchema,
      }),
    )
    .max(6),
});

const agentConfigFields = {
  profile: z.strictObject({ id: z.string().max(80), version: z.string().max(8) }),
  runtimeVersion: z.literal('lexaegis.agent-runtime.v1'),
  modelExecution: modelExecutionSchema,
  provider: z
    .strictObject({
      id: z.enum(['qwen', 'scripted-test']),
      region: z.string().regex(/^[a-z0-9-]{1,40}$/),
      requestedModel: z.string().max(64),
      /** As returned by the provider; null when no response reported one. */
      returnedModel: z.string().max(128).nullable(),
      /** A dated snapshot only when the returned model names one; otherwise explicitly unknown. */
      modelSnapshot: z.strictObject({
        status: z.enum(['known', 'unknown']),
        id: z.string().max(128).nullable(),
      }),
      outputMode: outputModeSchema,
      capability: z.strictObject({
        state: z.enum(['verified', 'configured', 'test']),
        checkedAt: timestampSchema.nullable(),
      }),
      requestIds: z.array(z.string().max(128)).max(6),
    })
    .nullable(),
  prompts: promptManifestRefSchema.nullable(),
  /** The fixed generation parameters sent with every request. Output is still not deterministic. */
  parameters: z
    .strictObject({
      enableThinking: z.literal(false),
      parallelToolCalls: z.literal(false),
      enableSearch: z.literal(false),
      stream: z.literal(false),
      temperature: z.literal('0'),
    })
    .nullable(),
  /** The run ceilings that applied. Null only for a check that ran on the device with no run. */
  budget: runBudgetSchema.nullable(),
  usage: runUsageSchema,
  run: z.strictObject({
    runId: opaqueIdSchema,
    intent: assistantIntentSchema.nullable(),
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
    outcome: runOutcomeSchema,
  }),
};

const agentConfigConsistency = (
  ctx: z.core.ParsePayload<{
    modelExecution: string;
    provider: { id: string } | null;
    parameters: unknown;
    prompts: unknown;
    budget: unknown;
    usage: { provenance: string };
  }>,
) => {
  const config = ctx.value;
  const bad = (message: string) =>
    ctx.issues.push({ code: 'custom', message, input: config, path: ['modelExecution'] });
  const none = config.modelExecution === 'none';
  if (none && (config.provider !== null || config.parameters !== null))
    bad('no model ran: provider and parameters must be absent');
  if (!none && (config.provider === null || config.prompts === null))
    bad('a model ran: provider and prompts are required');
  if (config.provider !== null && config.provider.id !== config.modelExecution)
    bad('provider does not match model execution');
  if (none && config.usage.provenance !== 'none') bad('no model ran: usage must be none');
  if (!none && config.budget === null) bad('a model ran: the budget is required');
};

/** The configuration as v1 wrote it. Old bytes keep parsing exactly as before. */
export const agentConfigSchema = z
  .strictObject({ schema: z.literal('lexaegis.agent-config.v1'), ...agentConfigFields })
  .check(agentConfigConsistency);
export type AgentConfigV1 = z.infer<typeof agentConfigSchema>;

/**
 * v2 is v1 plus ONE optional field: the ERC-8004 reference of the assistant that ran. It is an
 * ordinary field of an already hashed artifact, so its bytes are committed with the artifact; it is
 * not a manifest or receipt-reference field. A configuration with no identity stays v1.
 */
export const agentConfigV2Schema = z
  .strictObject({
    schema: z.literal('lexaegis.agent-config.v2'),
    ...agentConfigFields,
    agentIdentity: agentIdentityRefSchema.optional(),
  })
  .check(agentConfigConsistency);
export type AgentConfigV2 = z.infer<typeof agentConfigV2Schema>;

/** Either supported version, selected by the schema identifier. Unknown versions are rejected. */
export const agentConfigAnySchema = z.union([agentConfigSchema, agentConfigV2Schema]);
export type AgentConfig = z.infer<typeof agentConfigAnySchema>;
