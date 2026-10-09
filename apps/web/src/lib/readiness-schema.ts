import { z } from 'zod';
import { integrationStateSchema, opaqueIdSchema } from '@lexaegis/protocol';
import { PRODUCT_FLAGS } from '@/config/flags';

export const capabilityNameSchema = z.enum([
  'account.mera',
  'vault.storage',
  'assistant.qwen',
  'chain.rpc',
  'chain.registry',
  'history.envio',
  'database.postgres',
  'storage.s3',
]);
export type CapabilityName = z.infer<typeof capabilityNameSchema>;

export const capabilityReasonSchema = z.enum([
  'NOT_IMPLEMENTED',
  'CONFIG_INVALID',
  'NOT_CONFIGURED',
  'UNVERIFIED',
  'OK',
]);
export type CapabilityReason = z.infer<typeof capabilityReasonSchema>;

/** Safe, machine-readable readiness payload: names, states and reason codes only. */
export const readinessReportSchema = z.strictObject({
  status: z.enum(['ready', 'unavailable']),
  requestId: opaqueIdSchema,
  /** Enabled optional features only. A disabled feature is absent, never listed as unavailable. */
  optionalFeatures: z.array(z.enum(PRODUCT_FLAGS)),
  capabilities: z.array(
    z.strictObject({
      name: capabilityNameSchema,
      state: integrationStateSchema,
      reason: capabilityReasonSchema,
    }),
  ),
});
export type ReadinessReport = z.infer<typeof readinessReportSchema>;
