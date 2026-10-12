import { z } from 'zod';
import { addressSchema, digestSchema, timestampSchema } from '@lexaegis/protocol/v1';

/*
 * The generic profile of this example. The protocol does not interpret it: id and version are
 * declared data, and what the artifacts mean is this example's business alone. This is a code
 * review, not an employment settlement: no legal artifact is manufactured.
 */
export const PROFILE = { id: 'lexaegis.ai-pr-signoff', version: '1' } as const;

export const DECISION_SCHEMA = 'lexaegis.ai-pr-signoff.decision.v1';
export const MAX_RATIONALE_CHARS = 2000;

/**
 * The reviewer's decision file: an example-local, versioned, closed schema outside the generic
 * protocol. It binds the reviewer and an explicit package-approval decision to the SHA-256 of the
 * exact diff and summary bytes, with a bounded rationale and a supplied decision time. It cannot
 * name the package commitment (that would be circular): the commitment is computed over this file.
 */
export const decisionSchema = z.strictObject({
  schema: z.literal(DECISION_SCHEMA),
  reviewer: addressSchema,
  decision: z.literal('approve-review-package'),
  diffSha256: digestSchema,
  summarySha256: digestSchema,
  rationale: z.string().min(1).max(MAX_RATIONALE_CHARS),
  decidedAt: timestampSchema,
});
export type DecisionV1 = z.infer<typeof decisionSchema>;
