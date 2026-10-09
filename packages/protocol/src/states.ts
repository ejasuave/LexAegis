import { z } from 'zod';

/** A configured integration is not automatically verified. */
export const integrationStateSchema = z.enum([
  'unimplemented',
  'unconfigured',
  'configured',
  'verified',
  'blocked',
]);
export type IntegrationState = z.infer<typeof integrationStateSchema>;

export const reviewWorkflowStateSchema = z.enum([
  'draft',
  'analyzing',
  'needs_review',
  'ready_to_approve',
  'submitting',
  'confirmed',
  'failed',
]);
export type ReviewWorkflowState = z.infer<typeof reviewWorkflowStateSchema>;

export const packageIntegritySchema = z.enum(['match', 'mismatch', 'unknown']);
export type PackageIntegrity = z.infer<typeof packageIntegritySchema>;

export const receiptLifecycleSchema = z.enum([
  'active',
  'revoked',
  'superseded',
  'not_found',
  'unknown',
]);
export type ReceiptLifecycle = z.infer<typeof receiptLifecycleSchema>;

export const signerAcceptanceSchema = z.enum(['accepted', 'rejected', 'unknown']);
export type SignerAcceptance = z.infer<typeof signerAcceptanceSchema>;

/**
 * The three verification dimensions are independent required fields. There is no combined
 * "valid" flag: matching bytes say nothing about on-chain status or signer acceptance.
 */
export const verificationStatusSchema = z.strictObject({
  packageIntegrity: packageIntegritySchema,
  receiptLifecycle: receiptLifecycleSchema,
  signerAcceptance: signerAcceptanceSchema,
});
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

export function unknownVerificationStatus(): VerificationStatus {
  return { packageIntegrity: 'unknown', receiptLifecycle: 'unknown', signerAcceptance: 'unknown' };
}
