import { z } from 'zod';
import { TOOL_VERSION, type AssistantIntent, type AssistantToolName } from '../contracts';
import { toProviderSchema } from './model-schemas';
import type { ProviderTool } from './provider';

/*
 * The closed registry of read-only tools: versioned input schemas, descriptions and the intents
 * that may use each. Arguments name catalog handles, pinned rule IDs, a payment group or a status
 * scope. No argument can name another account or matter, a URL, code, a fact value or a secret.
 */

export const TOOL_INPUTS = {
  read_sources: z.strictObject({ sourceIds: z.array(z.string().max(8)).min(1).max(16) }),
  get_rules: z.strictObject({ ruleIds: z.array(z.string().max(60)).min(1).max(40) }),
  check_payments: z.strictObject({ groupId: z.string().max(40) }),
  check_evidence: z.strictObject({ ruleIds: z.array(z.string().max(60)).max(40) }),
  get_status: z.strictObject({ scope: z.enum(['matter', 'selected_receipt']) }),
  prepare_review: z.strictObject({}),
} as const satisfies Record<AssistantToolName, z.ZodType>;

export type ToolInput<N extends AssistantToolName> = z.infer<(typeof TOOL_INPUTS)[N]>;

export const TOOL_DESCRIPTIONS: Readonly<Record<AssistantToolName, string>> = {
  read_sources:
    'Read the text of selected source excerpts by handle (for example S1). Returns only excerpts the reviewer selected, with extraction coverage.',
  get_rules:
    'Read rules of the pinned rule pack by rule ID, with the pack review state. Use ["all"] to list every rule.',
  check_payments:
    'Reconcile the stated total with the payment schedule for one group (usually "settlement"), from confirmed facts only. Returns the code-computed result.',
  check_evidence:
    'Report the evidence checklist state for the given rule IDs (empty array for all), limited to the reviewer links for the selected documents.',
  get_status:
    'Read application status for the matter or the selected receipt: assistant, session, client-observed vault and account, live chain, indexed history.',
  prepare_review:
    'List what is still required before a review draft can be assembled. Saves and freezes nothing.',
};

export const TOOL_INTENTS: Readonly<Record<AssistantToolName, readonly AssistantIntent[]>> = {
  read_sources: ['summarise', 'explain', 'check_payments', 'missing_evidence', 'brief_matter', 'ask_matter'],
  get_rules: ['explain', 'check_payments', 'missing_evidence', 'prepare_review'],
  check_payments: ['check_payments', 'brief_matter', 'prepare_review'],
  check_evidence: ['missing_evidence', 'brief_matter', 'prepare_review'],
  get_status: ['status', 'brief_matter'],
  prepare_review: ['prepare_review'],
};

export const TOOL_NAMES = Object.keys(TOOL_INPUTS) as AssistantToolName[];

export const toolsForIntent = (intent: AssistantIntent): AssistantToolName[] =>
  TOOL_NAMES.filter((name) => TOOL_INTENTS[name].includes(intent));

export const providerTool = (name: AssistantToolName): ProviderTool => ({
  name,
  description: TOOL_DESCRIPTIONS[name],
  parameters: toProviderSchema(TOOL_INPUTS[name]),
});

/** The canonical description of one tool that the manifest hashes. */
export const toolManifestEntry = (name: AssistantToolName) => ({
  name,
  version: TOOL_VERSION,
  description: TOOL_DESCRIPTIONS[name],
  intents: TOOL_INTENTS[name],
  parameters: toProviderSchema(TOOL_INPUTS[name]),
});
