import {
  parseCommitmentOpening,
  parseReceiptReference,
  verifyManifestOpening,
  verifyReviewPackage,
  type ArtifactBytesInput,
  type CommitmentOpeningV1,
  type ProtocolResult,
  type ReceiptReferenceV1,
} from '@lexaegis/protocol/v1';
import type { CheckResult, ReferenceOrigin, ReportIssue, VerificationMode } from './report';

/*
 * Offline verification composes the existing protocol verifiers into three explicit modes. It is
 * deterministic and pure: no clock, no network, no storage. It establishes byte and reference
 * consistency only. The expected reference is always the caller's; it is never replaced by the
 * bundle's own declaration.
 */

export interface OfflineInput {
  readonly mode: VerificationMode;
  /** The receipt the recipient intends to inspect. Required in every mode. */
  readonly expectedReference: unknown;
  /** `independent`: supplied by the recipient. `file-declared`: copied from the imported file. */
  readonly referenceOrigin: ReferenceOrigin;
  /** Required for manifest-only and full-package. */
  readonly opening?: unknown;
  /** Required for full-package; the exact committed artifact bytes by artifact ID. */
  readonly artifacts?: ArtifactBytesInput;
  /** The reference the imported file itself declares, if any, for a conflict check. */
  readonly declaredReference?: unknown;
}

export interface OfflineVerification {
  readonly mode: VerificationMode;
  readonly expectedReference: ReceiptReferenceV1;
  readonly referenceOrigin: ReferenceOrigin;
  readonly manifestIntegrity: CheckResult;
  readonly artifactIntegrity: CheckResult;
  readonly issues: ReportIssue[];
  /** The validated opening when the manifest matched; otherwise null. Private; never publish it. */
  readonly verifiedOpening: CommitmentOpeningV1 | null;
  readonly profile: { readonly id: string; readonly version: string } | null;
}

const sameReference = (a: ReceiptReferenceV1, b: ReceiptReferenceV1): boolean =>
  a.chainId === b.chainId &&
  a.registryAddress === b.registryAddress &&
  a.reviewerAddress === b.reviewerAddress &&
  a.commitment === b.commitment;

function failure<T>(
  code: 'SCHEMA_INVALID' | 'ARTIFACT_INPUT_INVALID',
  path: string,
): ProtocolResult<T> {
  return { ok: false, error: { code, path } };
}

/** Never throws for malformed input: it returns a typed failure instead of a partial success badge. */
export async function verifyOffline(
  input: OfflineInput,
): Promise<ProtocolResult<OfflineVerification>> {
  const expected = parseReceiptReference(input.expectedReference);
  if (!expected.ok) return expected;

  const issues: ReportIssue[] = [];
  if (input.referenceOrigin === 'file-declared') issues.push({ code: 'EXPECTATION_FROM_FILE' });

  let declaredConflict = false;
  if (input.declaredReference !== undefined) {
    const declared = parseReceiptReference(input.declaredReference);
    if (!declared.ok) return declared;
    declaredConflict = !sameReference(declared.data, expected.data);
  }

  const base = {
    mode: input.mode,
    expectedReference: expected.data,
    referenceOrigin: input.referenceOrigin,
  } as const;

  if (input.mode === 'reference-only') {
    issues.push({ code: 'MANIFEST_NOT_SUPPLIED' }, { code: 'ARTIFACTS_NOT_SUPPLIED' });
    if (declaredConflict) issues.push({ code: 'DECLARED_REFERENCE_CONFLICT' });
    return {
      ok: true,
      data: {
        ...base,
        manifestIntegrity: declaredConflict ? 'mismatch' : 'unknown',
        artifactIntegrity: 'unknown',
        issues,
        verifiedOpening: null,
        profile: null,
      },
    };
  }

  if (input.opening === undefined) return failure('SCHEMA_INVALID', 'opening');
  const opening = parseCommitmentOpening(input.opening);
  if (!opening.ok) return opening;

  let verification;
  if (input.mode === 'manifest-only') {
    verification = await verifyManifestOpening(opening.data, expected.data);
    issues.push({ code: 'ARTIFACTS_NOT_SUPPLIED' });
  } else {
    if (input.artifacts === undefined) return failure('ARTIFACT_INPUT_INVALID', 'artifacts');
    verification = await verifyReviewPackage(opening.data, input.artifacts, expected.data);
  }
  if (!verification.ok) return verification;

  for (const issue of verification.data.issues) {
    issues.push(
      issue.artifactId === undefined
        ? { code: issue.code }
        : { code: issue.code, artifactId: issue.artifactId },
    );
  }
  if (declaredConflict) issues.push({ code: 'DECLARED_REFERENCE_CONFLICT' });

  // A file whose own declared reference disagrees with the expectation is a conflict, not a match.
  const manifestIntegrity: CheckResult = declaredConflict
    ? 'mismatch'
    : verification.data.manifestIntegrity;
  const artifactIntegrity: CheckResult =
    input.mode === 'manifest-only' ? 'unknown' : verification.data.artifactIntegrity;
  const manifest = opening.data.manifest;
  return {
    ok: true,
    data: {
      ...base,
      manifestIntegrity,
      artifactIntegrity,
      issues,
      verifiedOpening: manifestIntegrity === 'match' ? opening.data : null,
      profile: { id: manifest.profile.id, version: manifest.profile.version },
    },
  };
}
