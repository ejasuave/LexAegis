import { z } from 'zod';
import {
  chainIdSchema,
  digestSchema,
  nonZeroAddressSchema,
  receiptReferenceV1Schema,
  uuidSchema,
} from '@lexaegis/protocol/v1';
import { chainCheckpointSchema } from '../registry/live-reader';
import { uint256DecimalSchema } from '../registry/typed-data';

/*
 * VerificationReportV1: an observation, not a certificate. Every dimension is its own field and
 * there is no combined valid flag. Large numbers are decimal strings. Offline verification can
 * establish byte and reference consistency only; it cannot establish issuance, active status,
 * signer acceptance, evidence truth, human conduct or legal correctness.
 */

export const VERIFICATION_REPORT_SCHEMA = 'lexaegis.verification-report.v1';

export const VERIFICATION_MODES = ['reference-only', 'manifest-only', 'full-package'] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

/** Where the expected reference came from. The software cannot prove the origin of a caller's input. */
export const REFERENCE_ORIGINS = ['independent', 'file-declared'] as const;
export type ReferenceOrigin = (typeof REFERENCE_ORIGINS)[number];

export const checkResultSchema = z.enum(['match', 'mismatch', 'unknown']);
export type CheckResult = z.infer<typeof checkResultSchema>;
export const chainStatusSchema = z.enum([
  'unknown',
  'not_found',
  'active',
  'revoked',
  'superseded',
]);
export type ChainStatus = z.infer<typeof chainStatusSchema>;
export const signerAcceptanceReportSchema = z.enum(['accepted', 'rejected', 'unknown']);

/** Stable, content-free issue codes. A code never carries an artifact body, label or hash. */
export const REPORT_ISSUE_CODES = [
  // Offline
  'EXPECTATION_FROM_FILE',
  'MANIFEST_NOT_SUPPLIED',
  'ARTIFACTS_NOT_SUPPLIED',
  'ARTIFACTS_NOT_EVALUATED',
  'DECLARED_REFERENCE_CONFLICT',
  'CONTEXT_MISMATCH',
  'COMMITMENT_MISMATCH',
  'ARTIFACT_MISSING',
  'ARTIFACT_LENGTH_MISMATCH',
  'ARTIFACT_DIGEST_MISMATCH',
  'ARTIFACT_NOT_IN_MANIFEST',
  // Registry and chain
  'NETWORK_NOT_REQUESTED',
  'REGISTRY_POLICY_MISSING',
  'REGISTRY_POLICY_INVALID',
  'REGISTRY_POLICY_MISMATCH',
  'LIVE_RPC_UNAVAILABLE',
  'LIVE_WRONG_CHAIN',
  'LIVE_GENESIS_MISMATCH',
  'LIVE_FINALIZED_UNAVAILABLE',
  'LIVE_BELOW_DEPLOYMENT',
  'LIVE_CODE_MISMATCH',
  'LIVE_PROTOCOL_MISMATCH',
  'LIVE_BLOCK_CHANGED',
  'LIVE_RESPONSE_INVALID',
  'LIVE_DEADLINE',
  'LIVE_ATTEMPTS_EXHAUSTED',
  'LIVE_TIMEOUT',
  'LIVE_ABORTED',
  'BINDING_NOT_EVALUATED',
  'OPENING_CONTEXT_MISMATCH',
  'RECEIPT_TUPLE_MISMATCH',
  'PREDECESSOR_MISMATCH',
  'IMPOSSIBLE_RECORD',
  // History
  'SUCCESSOR_LIMIT_EXHAUSTED',
  'SUCCESSOR_CYCLE',
  'SUCCESSOR_LINK_INVALID',
  'SUCCESSOR_UNREADABLE',
  // Signer
  'SIGNER_POLICY_ABSENT',
  'SIGNER_POLICY_ERROR',
] as const;
export type ReportIssueCode = (typeof REPORT_ISSUE_CODES)[number];

export const reportIssueSchema = z.strictObject({
  code: z.enum(REPORT_ISSUE_CODES),
  /** Opaque artifact UUID, for diagnostics inside the verifying device only. */
  artifactId: uuidSchema.optional(),
});
export type ReportIssue = z.infer<typeof reportIssueSchema>;

export const successorObservationSchema = z.strictObject({
  reference: receiptReferenceV1Schema,
  /** Observed lifecycle of that successor at the same checkpoint. */
  chainStatus: chainStatusSchema,
  /** A successor's files are never carried over from the original: integrity is its own check. */
  packageIntegrity: z.literal('unknown'),
});
export type SuccessorObservation = z.infer<typeof successorObservationSchema>;

export const verificationReportV1Schema = z.strictObject({
  schema: z.literal(VERIFICATION_REPORT_SCHEMA),
  mode: z.enum(VERIFICATION_MODES),
  expectedReference: receiptReferenceV1Schema,
  referenceOrigin: z.enum(REFERENCE_ORIGINS),
  manifestIntegrity: checkResultSchema,
  artifactIntegrity: checkResultSchema,
  registryIdentity: checkResultSchema,
  receiptBinding: checkResultSchema,
  chainStatus: chainStatusSchema,
  signerAcceptance: signerAcceptanceReportSchema,
  /** The verified block the registry was read at, or null when no live read succeeded. */
  checkpoint: chainCheckpointSchema.nullable(),
  /** Identifiers of the caller-owned policies used; null when none was supplied. */
  registryPolicyId: z.string().min(1).max(80).nullable(),
  signerPolicyId: z.string().min(1).max(80).nullable(),
  /** The declared profile of a supplied manifest. It is not evaluated. */
  profile: z.strictObject({ id: z.string().max(80), version: z.string().max(10) }).nullable(),
  profileSemantics: z.literal('not_evaluated'),
  /** Bounded successor observations at the same checkpoint; null when not requested. */
  history: z
    .strictObject({
      complete: z.boolean(),
      successors: z.array(successorObservationSchema).max(8),
    })
    .nullable(),
  /** Actual observation time, recorded once by the orchestrator. */
  observedAt: z.iso.datetime(),
  issues: z.array(reportIssueSchema).max(300),
});
export type VerificationReportV1 = z.infer<typeof verificationReportV1Schema>;

/** The caller-trusted registry deployment. A package can never supply or change it. */
export const registryPolicySchema = z.strictObject({
  /** Caller's identifier for this policy, shown in reports. */
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  chainId: chainIdSchema,
  /** Block 0 hash, pinned from the actual deployment record. */
  genesisHash: digestSchema,
  registryAddress: nonZeroAddressSchema,
  /** Registry protocol version the deployment reports, as a decimal string. */
  protocolVersion: z.string().regex(/^[1-9][0-9]*$/),
  deploymentBlock: uint256DecimalSchema,
  deploymentTransactionHash: digestSchema,
  /** keccak256 of the deployed runtime code, observed at deployment. */
  runtimeCodeKeccak256: digestSchema,
  executionDelayBlocks: z.number().int().min(0).max(64),
  executionDelayRevision: z.string().min(1).max(200),
});
export type RegistryPolicy = z.infer<typeof registryPolicySchema>;
