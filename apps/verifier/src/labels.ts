import type { VerificationReportV1 } from '@lexaegis/sdk';
import type { ArtifactCheck } from './verification-job';

/** Precise, plain labels. No label here says "valid", and none speaks for legal correctness. */

export function manifestLabel(report: VerificationReportV1): string {
  if (report.mode === 'reference-only') return 'Files not supplied';
  if (report.manifestIntegrity === 'mismatch') return 'Files do not match the expected reference';
  if (report.manifestIntegrity === 'unknown') return 'Manifest not checked';
  return report.referenceOrigin === 'independent'
    ? 'Files match the reference you supplied'
    : 'Files match the reference declared inside the file';
}

export function artifactLabel(report: VerificationReportV1): string {
  if (report.artifactIntegrity === 'match') return 'Every committed artifact matches';
  if (report.artifactIntegrity === 'mismatch') return 'An artifact differs from what was committed';
  return report.mode === 'full-package'
    ? 'Some committed artifacts are missing or were not evaluated'
    : 'Artifacts not supplied';
}

export function registryLabel(report: VerificationReportV1): string {
  if (report.registryIdentity === 'match')
    return 'Registry identity matches the configured deployment';
  if (report.registryIdentity === 'mismatch')
    return 'Registry does not match the configured deployment';
  return 'Registry identity unverified';
}

export function lifecycleLabel(report: VerificationReportV1): string {
  const block = report.checkpoint?.blockNumber;
  const at = block === undefined ? '' : ` at block ${block}`;
  switch (report.chainStatus) {
    case 'active':
      return `Active${at}`;
    case 'revoked':
      return `Revoked${at}`;
    case 'superseded':
      return `Superseded${at}`;
    case 'not_found':
      return `Receipt not found${at}`;
    case 'unknown':
      return 'Registry status unknown';
  }
}

export function bindingLabel(report: VerificationReportV1): string {
  if (report.receiptBinding === 'match') return 'Receipt binds to the verified files';
  if (report.receiptBinding === 'mismatch') return 'Receipt does not bind to the files';
  return 'Receipt binding not evaluated';
}

export function signerLabel(report: VerificationReportV1): string {
  if (report.signerAcceptance === 'accepted') return 'Signer meets your selected rule';
  if (report.signerAcceptance === 'rejected') return 'Signer does not meet your selected rule';
  return report.signerPolicyId === null
    ? 'Signer not evaluated'
    : 'Signer rule could not be applied';
}

export const CHECK_LABEL: Record<ArtifactCheck, string> = {
  match: 'Matches',
  mismatch: 'Changed',
  missing: 'Missing',
  not_supplied: 'Not supplied',
  not_evaluated: 'Not evaluated',
};

/** Plain wording for typed issue codes (content-free). */
export const ISSUE_TEXT: Readonly<Record<string, string>> = {
  EXPECTATION_FROM_FILE:
    'The reference was taken from the file itself, so it is not an independent check.',
  MANIFEST_NOT_SUPPLIED: 'No manifest was supplied.',
  ARTIFACTS_NOT_SUPPLIED: 'Artifacts were not supplied.',
  ARTIFACTS_NOT_EVALUATED: 'Artifacts were not evaluated because the manifest did not match.',
  DECLARED_REFERENCE_CONFLICT: 'The file declares a different reference from the one expected.',
  CONTEXT_MISMATCH: 'The manifest names a different chain, registry or reviewer.',
  COMMITMENT_MISMATCH: 'The manifest does not open the expected commitment.',
  ARTIFACT_MISSING: 'A committed artifact was not supplied.',
  ARTIFACT_LENGTH_MISMATCH: 'An artifact has a different length from the one committed.',
  ARTIFACT_DIGEST_MISMATCH: 'An artifact differs from the one committed.',
  ARTIFACT_NOT_IN_MANIFEST: 'A supplied artifact is not in the manifest.',
  NETWORK_NOT_REQUESTED: 'The registry was not checked.',
  REGISTRY_POLICY_MISSING: 'No registry deployment is configured.',
  REGISTRY_POLICY_INVALID: 'The registry configuration or endpoint is not valid.',
  REGISTRY_POLICY_MISMATCH:
    'The receipt names a registry other than the configured one. Nothing was read.',
  LIVE_RPC_UNAVAILABLE:
    'The RPC endpoint could not be reached or refused the request (network, CORS or method).',
  LIVE_WRONG_CHAIN: 'The endpoint reports a different chain.',
  LIVE_GENESIS_MISMATCH: 'The endpoint’s genesis block is not the pinned one.',
  LIVE_FINALIZED_UNAVAILABLE: 'The endpoint did not provide a finalized block.',
  LIVE_BELOW_DEPLOYMENT: 'The finalized height is before the registry deployment.',
  LIVE_CODE_MISMATCH: 'The code at the registry address is not the configured deployment.',
  LIVE_PROTOCOL_MISMATCH: 'The registry reports a different protocol version.',
  LIVE_BLOCK_CHANGED: 'The block changed during the read, so nothing was accepted.',
  LIVE_RESPONSE_INVALID: 'The endpoint returned a response that could not be accepted.',
  LIVE_DEADLINE: 'The registry check ran out of time (20 seconds).',
  LIVE_ATTEMPTS_EXHAUSTED: 'The registry check used its request allowance.',
  LIVE_TIMEOUT: 'A registry read timed out.',
  LIVE_ABORTED: 'The registry check was cancelled.',
  BINDING_NOT_EVALUATED:
    'The receipt was not bound to the files because the manifest was not verified.',
  OPENING_CONTEXT_MISMATCH: 'The files were prepared for a different chain, registry or reviewer.',
  RECEIPT_TUPLE_MISMATCH: 'The registry record is for a different receipt.',
  PREDECESSOR_MISMATCH: 'The registry’s predecessor is not the one the manifest declares.',
  IMPOSSIBLE_RECORD: 'The registry returned a record the registry cannot produce.',
  SUCCESSOR_LIMIT_EXHAUSTED: 'More than eight replacements follow. Later history was not read.',
  SUCCESSOR_CYCLE: 'The replacement chain loops back on itself.',
  SUCCESSOR_LINK_INVALID: 'A replacement link is not reciprocal or does not exist.',
  SUCCESSOR_UNREADABLE: 'A replacement could not be read.',
  SIGNER_POLICY_ABSENT: 'No signer rule was selected.',
  SIGNER_POLICY_ERROR: 'The signer rule failed to run.',
};

export const FAILURE_TEXT: Readonly<Record<string, string>> = {
  INPUT_TOO_LARGE: 'This file is larger than the 48 MiB limit.',
  INPUT_MALFORMED:
    'This is not a valid readable review export. It must be strict JSON with no duplicate keys, byte-order mark or trailing text.',
  WRONG_FORMAT_ENCRYPTED_BACKUP:
    'This is an encrypted backup. It needs its owner’s vault. Export the readable version from LexAegis to verify it here.',
  WRONG_FORMAT_CONTEXT_EXPORT:
    'This is saved matter context, not a review package. There is nothing here to verify.',
  UNRECOGNISED_FORMAT: 'This file is not a readable review export.',
  UNSUPPORTED_VERSION: 'This export uses a version this verifier does not support.',
  UNKNOWN_FIELD: 'This file contains fields this verifier does not accept.',
  SCHEMA_INVALID: 'This file does not match the review export format.',
  OPENING_TOO_LARGE: 'The manifest or opening is larger than the 1 MiB limit.',
  ARTIFACT_SET_MISMATCH:
    'The artifacts in the file are not exactly the ones the manifest lists, once each, in order.',
  ARTIFACT_ENCODING_INVALID: 'An artifact is not canonical base64url.',
  ARTIFACT_TOO_LARGE: 'An artifact is larger than the 10 MiB limit.',
  ARTIFACTS_TOO_LARGE: 'The artifacts together are larger than the 32 MiB limit.',
  REFERENCE_INVALID: 'The expected receipt reference is not valid.',
  REFERENCE_REQUIRED:
    'This file has no reference of its own. Paste the receipt reference you expect, then check again.',
  VERIFY_FAILED: 'The files could not be checked.',
  DEADLINE: 'The local check took longer than 30 seconds and was stopped.',
  CANCELLED: 'The check was cancelled.',
  WORKER_FAILED: 'The local check stopped unexpectedly.',
  FILE_TOO_LARGE: 'This file is larger than the limit and was not read.',
  FILE_UNREADABLE: 'This file could not be read.',
};
