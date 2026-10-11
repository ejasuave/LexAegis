import { z } from 'zod';
import { receiptReferenceV1Schema } from '@lexaegis/protocol/v1';
import {
  REFERENCE_ORIGINS,
  REPORT_ISSUE_CODES,
  VERIFICATION_MODES,
  chainStatusSchema,
  checkResultSchema,
  type VerificationReportV1,
} from '@lexaegis/sdk';

/*
 * The downloadable verification result: a versioned projection of public fields only. It carries
 * no opening, private digest, label, artifact ID or content, endpoint, or raw error. It is an
 * unsigned observation, not a certificate, and it is never accepted as a review package.
 */

export const RESULT_EXPORT_SCHEMA = 'lexaegis.verification-result.v1';
/** A generic name: never a matter title, file name or commitment. */
export const RESULT_FILE_NAME = 'proof-of-review-verification-result.json';

export const RESULT_NOTICE =
  'Unsigned observation. It is not a certificate and not a review package. Verify again for current status.';

export const verificationResultV1Schema = z.strictObject({
  schema: z.literal(RESULT_EXPORT_SCHEMA),
  notice: z.literal(RESULT_NOTICE),
  mode: z.enum(VERIFICATION_MODES),
  expectedReference: receiptReferenceV1Schema,
  referenceOrigin: z.enum(REFERENCE_ORIGINS),
  checks: z.strictObject({
    manifestIntegrity: checkResultSchema,
    artifactIntegrity: checkResultSchema,
    registryIdentity: checkResultSchema,
    receiptBinding: checkResultSchema,
    chainStatus: chainStatusSchema,
    signerAcceptance: z.enum(['accepted', 'rejected', 'unknown']),
  }),
  checkpoint: z
    .strictObject({
      chainId: z.string(),
      blockNumber: z.string(),
      blockHash: z.string(),
      finalizedHeight: z.string(),
      blockTimestamp: z.string(),
    })
    .nullable(),
  registryPolicyId: z.string().nullable(),
  signerPolicyId: z.string().nullable(),
  profileSemantics: z.literal('not_evaluated'),
  history: z
    .strictObject({
      complete: z.boolean(),
      successors: z.array(
        z.strictObject({ commitment: z.string(), chainStatus: chainStatusSchema }),
      ),
    })
    .nullable(),
  /** Issue codes only, with no artifact identifiers. */
  issues: z.array(z.enum(REPORT_ISSUE_CODES)),
  observedAt: z.iso.datetime(),
});
export type VerificationResultV1 = z.infer<typeof verificationResultV1Schema>;

export function projectResult(report: VerificationReportV1): VerificationResultV1 {
  return verificationResultV1Schema.parse({
    schema: RESULT_EXPORT_SCHEMA,
    notice: RESULT_NOTICE,
    mode: report.mode,
    expectedReference: report.expectedReference,
    referenceOrigin: report.referenceOrigin,
    checks: {
      manifestIntegrity: report.manifestIntegrity,
      artifactIntegrity: report.artifactIntegrity,
      registryIdentity: report.registryIdentity,
      receiptBinding: report.receiptBinding,
      chainStatus: report.chainStatus,
      signerAcceptance: report.signerAcceptance,
    },
    checkpoint:
      report.checkpoint === null
        ? null
        : {
            chainId: report.checkpoint.chainId,
            blockNumber: report.checkpoint.blockNumber,
            blockHash: report.checkpoint.blockHash,
            finalizedHeight: report.checkpoint.finalizedHeight,
            blockTimestamp: report.checkpoint.blockTimestamp,
          },
    registryPolicyId: report.registryPolicyId,
    signerPolicyId: report.signerPolicyId,
    profileSemantics: report.profileSemantics,
    history:
      report.history === null
        ? null
        : {
            complete: report.history.complete,
            successors: report.history.successors.map((link) => ({
              commitment: link.reference.commitment,
              chainStatus: link.chainStatus,
            })),
          },
    issues: [...new Set(report.issues.map((issue) => issue.code))],
    observedAt: report.observedAt,
  });
}

/** Pretty JSON text of the projection, ready for an explicit download. */
export function resultJson(report: VerificationReportV1): string {
  return `${JSON.stringify(projectResult(report), null, 2)}\n`;
}
