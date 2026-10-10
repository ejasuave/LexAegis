import { z } from 'zod';
import {
  answerBasisSchema,
  assistantIntentSchema,
  factFieldSchema,
  nextActionSchema,
  unresolvedItemSchema,
} from '../contracts';

/*
 * What a model may return. These shapes are deliberately flat so they fit the provider's
 * structured-output subset. They are requests and proposals only: handles are plain strings here
 * and are resolved, or rejected, by validate-output.ts against the consented catalog and the
 * run's own tool results. No field can carry a hash, an offset, an account or an approval.
 */

export const modelBlockSchema = z.strictObject({
  kind: z.enum(['explanation', 'quotation', 'calculation', 'finding', 'status']),
  text: z.string().max(2000),
  basis: answerBasisSchema,
  sources: z.array(z.string().max(8)).max(8),
  rules: z.array(z.string().max(60)).max(8),
  tools: z.array(z.string().max(8)).max(4),
});
export type ModelBlock = z.infer<typeof modelBlockSchema>;

export const modelProposalSchema = z.strictObject({
  field: factFieldSchema,
  group: z.string().max(40),
  slot: z.string().max(40),
  value: z.string().max(512),
  sources: z.array(z.string().max(8)).max(4),
});

export const modelOutputSchema = z.strictObject({
  outcome: z.enum(['answer', 'needs_input', 'limited_scope', 'unsupported']),
  blocks: z.array(modelBlockSchema).max(8),
  factProposals: z.array(modelProposalSchema).max(10),
  unresolved: z.array(unresolvedItemSchema).max(10),
  questions: z.array(z.string().max(300)).max(3),
  scopeLimitations: z.array(z.string().max(300)).max(8),
  nextActions: z.array(nextActionSchema).max(6),
});
export type ModelOutput = z.infer<typeof modelOutputSchema>;

export const intentSelectionOutputSchema = z.strictObject({
  intent: z.enum([...assistantIntentSchema.options, 'clarify', 'unsupported']),
});

const PROVIDER_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'description',
]);

/**
 * Projects a schema onto the keywords the provider documents for structured output and function
 * parameters: type, properties, required, additionalProperties, items, enum, description. Every
 * object stays closed with all properties required. Length and count limits are not sent; the
 * local Zod schema enforces them on whatever comes back.
 */
export function toProviderSchema(schema: z.ZodType): Record<string, unknown> {
  const project = (node: unknown, insideProperties: boolean): unknown => {
    if (Array.isArray(node)) return node.map((item) => project(item, false));
    if (node === null || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      // Inside "properties" every key is a property name, not a keyword.
      if (!insideProperties && !PROVIDER_KEYWORDS.has(key)) continue;
      out[key] =
        key === 'enum' || key === 'required' ? value : project(value, key === 'properties');
    }
    return out;
  };
  return project(z.toJSONSchema(schema), false) as Record<string, unknown>;
}

export const OUTPUT_SCHEMA_NAME = 'aegis_answer';
export const INTENT_SCHEMA_NAME = 'aegis_intent';
