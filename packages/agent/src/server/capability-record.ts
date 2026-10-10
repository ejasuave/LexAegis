import { z } from 'zod';
import { timestampSchema } from '@lexaegis/protocol/v1';
import { outputModeSchema, providerIdSchema } from '../contracts';

/*
 * The stored result of the synthetic capability checks for one exact configuration. "Configured"
 * and "verified" are separate: only a passing record for the current fingerprint enables
 * real-matter inference, and a changed endpoint, model or output mode has no record.
 */

export const capabilityRecordSchema = z.strictObject({
  schema: z.literal('lexaegis.assistant-capability.v1'),
  fingerprint: z.string().regex(/^0x[0-9a-f]{64}$/),
  provider: providerIdSchema,
  model: z.string().max(64),
  region: z.string().max(40),
  outputMode: outputModeSchema,
  nativeToolCalls: z.boolean(),
  structuredOutput: z.boolean(),
  /** Whether responses carried usage. False leaves usage unknown; it does not block verification. */
  usageReported: z.boolean(),
  cancellation: z.boolean(),
  returnedModel: z.string().max(128).nullable(),
  requestIds: z.array(z.string().max(200)).max(4),
  failures: z.array(z.string().max(60)).max(8),
  checkedAt: timestampSchema,
  /** True only when tool calls, the output mode and cancellation all passed. */
  verified: z.boolean(),
});
export type CapabilityRecord = z.infer<typeof capabilityRecordSchema>;
