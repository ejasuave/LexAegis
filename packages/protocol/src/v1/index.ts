/**
 * Proof of Review protocol v1: private review packages, reproducible hashing and
 * commitment-opening checks. Pure functions for browsers and Node.js: no network access, no
 * storage, no signing. Nothing here establishes signature authorization, receipt existence,
 * lifecycle state, legal correctness or professional identity.
 */
export * from './constants';
export {
  PROTOCOL_ERROR_CODES,
  ProtocolError,
  isProtocolErrorCode,
  type ProtocolErrorCode,
  type ProtocolFailure,
  type ProtocolResult,
} from './errors';
export { bytesToHex, hexToBytes, utf8, concatBytes, type Bytes } from './bytes';
export * from './primitives';
export {
  DEFAULT_JSON_LIMITS,
  assertPlainJson,
  parseStrictJson,
  type JsonLimits,
  type JsonObject,
  type JsonValue,
} from './parse-json';
export {
  artifactRefV1Schema,
  artifactRoleSchema,
  commitmentOpeningV1Schema,
  receiptReferenceV1Schema,
  reviewPackageV1Schema,
  type ArtifactRefV1,
  type ArtifactRole,
  type CommitmentOpeningV1,
  type ReceiptReferenceV1,
  type ReviewPackageV1,
} from './schemas';
export { parseCommitmentOpening, parseReceiptReference, parseReviewPackage } from './parse';
export { canonicalizeJson, canonicalizeReviewPackage } from './canonicalize';
export {
  artifactDigest,
  describeArtifact,
  packageDigest,
  type ArtifactDescription,
} from './hashes';
export { computeCommitment, generateBlindingNonce } from './commitment';
export type { ArtifactBytesInput } from './artifacts';
export { PreparedReviewPackage } from './prepared';
export { prepareReviewPackage } from './prepare';
export {
  VERIFICATION_ISSUE_CODES,
  packageVerificationV1Schema,
  verifyManifestOpening,
  verifyReviewPackage,
  type PackageVerificationV1,
  type VerificationIssue,
} from './verify';
export { PROTOCOL_DESCRIPTOR_V1, type ProtocolDescriptorV1 } from './descriptor';
