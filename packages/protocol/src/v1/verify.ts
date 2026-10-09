import { z } from 'zod';
import { packageIntegritySchema } from '../states';
import { collectArtifacts, type ArtifactBytesInput } from './artifacts';
import { bytesToHex, hexToBytes } from './bytes';
import { canonicalizeReviewPackage } from './canonicalize';
import { computeCommitmentBytes } from './commitment';
import { LIMITS } from './constants';
import { toResult, toResultAsync, type ProtocolResult } from './errors';
import { packageDigestBytes, sha256 } from './hashes';
import { readCommitmentOpening, readReceiptReference } from './parse';
import { uuidSchema } from './primitives';
import type { CommitmentOpeningV1, ReceiptReferenceV1 } from './schemas';

export const VERIFICATION_ISSUE_CODES = [
  'CONTEXT_MISMATCH',
  'COMMITMENT_MISMATCH',
  'ARTIFACTS_NOT_EVALUATED',
  'ARTIFACT_MISSING',
  'ARTIFACT_LENGTH_MISMATCH',
  'ARTIFACT_DIGEST_MISMATCH',
  'ARTIFACT_NOT_IN_MANIFEST',
] as const;

/**
 * Result of offline verification. The fields are deliberately separate and there is no combined
 * "valid" flag. Nothing here can establish signature authorization, receipt existence, lifecycle
 * state or professional identity, so chain status and signer acceptance are fixed at "unknown".
 */
export const packageVerificationV1Schema = z.strictObject({
  manifestIntegrity: packageIntegritySchema,
  artifactIntegrity: packageIntegritySchema,
  chainStatus: z.literal('unknown'),
  signerAcceptance: z.literal('unknown'),
  issues: z.array(
    z.strictObject({
      code: z.enum(VERIFICATION_ISSUE_CODES),
      /** Opaque artifact UUID, where an artifact is affected. */
      artifactId: uuidSchema.optional(),
    }),
  ),
});
export type PackageVerificationV1 = z.infer<typeof packageVerificationV1Schema>;
export type VerificationIssue = PackageVerificationV1['issues'][number];

function sameContext(opening: CommitmentOpeningV1, expected: ReceiptReferenceV1): boolean {
  const { context } = opening.manifest;
  return (
    context.chainId === expected.chainId &&
    context.registryAddress === expected.registryAddress &&
    context.reviewerAddress === expected.reviewerAddress
  );
}

/** Recomputes canonical bytes, package digest and commitment. Declared digests are never trusted. */
async function manifestIssues(
  opening: CommitmentOpeningV1,
  expected: ReceiptReferenceV1,
): Promise<VerificationIssue[]> {
  const issues: VerificationIssue[] = [];
  if (!sameContext(opening, expected)) issues.push({ code: 'CONTEXT_MISMATCH' });
  const digest = await packageDigestBytes(canonicalizeReviewPackage(opening.manifest));
  const commitment = bytesToHex(
    await computeCommitmentBytes(
      hexToBytes(opening.blindingNonce, LIMITS.blindingNonceBytes),
      digest,
    ),
  );
  if (commitment !== expected.commitment) issues.push({ code: 'COMMITMENT_MISMATCH' });
  return issues;
}

function result(
  manifestIntegrity: PackageVerificationV1['manifestIntegrity'],
  artifactIntegrity: PackageVerificationV1['artifactIntegrity'],
  issues: VerificationIssue[],
): PackageVerificationV1 {
  return {
    manifestIntegrity,
    artifactIntegrity,
    chainStatus: 'unknown',
    signerAcceptance: 'unknown',
    issues,
  };
}

/**
 * Manifest-only verification: checks that the opening is the one committed by the reference the
 * caller expects. The expected reference is required and is never replaced by anything the
 * opening declares. It says nothing about omitted artifacts, so artifact integrity is "unknown".
 */
export function verifyManifestOpening(
  openingInput: unknown,
  expectedReceiptReference: unknown,
): Promise<ProtocolResult<PackageVerificationV1>> {
  const parsed = toResult(() => ({
    expected: readReceiptReference(expectedReceiptReference),
    opening: readCommitmentOpening(openingInput),
  }));
  if (!parsed.ok) return Promise.resolve(parsed);
  return toResultAsync(async () => {
    const issues = await manifestIssues(parsed.data.opening, parsed.data.expected);
    return result(issues.length === 0 ? 'match' : 'mismatch', 'unknown', issues);
  });
}

/**
 * Full verification: the manifest check plus every referenced artifact's actual length and
 * digest. Missing files leave artifact integrity "unknown"; altered files, and files the manifest
 * never committed, make it "mismatch". When the manifest itself does not open the expected
 * commitment the supplied files are not bound to that receipt at all, so they are not evaluated.
 *
 * V1 is full-package disclosure: redacted bytes do not verify as the original artifact.
 * Performs no network access and evaluates no legal content.
 */
export function verifyReviewPackage(
  openingInput: unknown,
  artifactBytesById: ArtifactBytesInput,
  expectedReceiptReference: unknown,
): Promise<ProtocolResult<PackageVerificationV1>> {
  // Parsing and byte capture are synchronous, ahead of the first await.
  const parsed = toResult(() => {
    const expected = readReceiptReference(expectedReceiptReference);
    const opening = readCommitmentOpening(openingInput);
    return { expected, opening, artifacts: collectArtifacts(opening.manifest, artifactBytesById) };
  });
  if (!parsed.ok) return Promise.resolve(parsed);
  const { expected, opening, artifacts } = parsed.data;

  return toResultAsync(async () => {
    const issues = await manifestIssues(opening, expected);
    if (issues.length > 0) {
      return result('mismatch', 'unknown', [...issues, { code: 'ARTIFACTS_NOT_EVALUATED' }]);
    }

    let mismatch = false;
    for (const artifactId of artifacts.extra) {
      mismatch = true;
      issues.push({ code: 'ARTIFACT_NOT_IN_MANIFEST', ...(artifactId !== null && { artifactId }) });
    }
    for (const artifactId of artifacts.lengthMismatch) {
      mismatch = true;
      issues.push({ code: 'ARTIFACT_LENGTH_MISMATCH', artifactId });
    }
    for (const artifact of opening.manifest.artifacts) {
      const bytes = artifacts.captured.get(artifact.id);
      if (bytes !== undefined && bytesToHex(await sha256(bytes)) !== artifact.sha256) {
        mismatch = true;
        issues.push({ code: 'ARTIFACT_DIGEST_MISMATCH', artifactId: artifact.id });
      }
    }
    for (const artifactId of artifacts.missing)
      issues.push({ code: 'ARTIFACT_MISSING', artifactId });

    const artifactIntegrity = mismatch
      ? 'mismatch'
      : artifacts.missing.length > 0
        ? 'unknown'
        : 'match';
    return result('match', artifactIntegrity, issues);
  });
}
