export * from './ports';

/*
 * Protocol v1 package preparation, hashing and offline verification, re-exported unchanged from
 * @lexaegis/protocol. The SDK adds no hashing logic of its own.
 *
 * Registry action data, the generated registry ABI and strict decoding live at the
 * `@lexaegis/sdk/registry` subpath, so this entry point stays free of chain libraries. Signing,
 * submission and live contract reads are not implemented anywhere in the SDK yet.
 */
export {
  PROTOCOL_DESCRIPTOR_V1,
  PreparedReviewPackage,
  artifactDigest,
  artifactRefV1Schema,
  canonicalizeReviewPackage,
  commitmentOpeningV1Schema,
  computeCommitment,
  describeArtifact,
  packageDigest,
  packageVerificationV1Schema,
  parseCommitmentOpening,
  parseReceiptReference,
  parseReviewPackage,
  prepareReviewPackage,
  receiptReferenceV1Schema,
  reviewPackageV1Schema,
  verifyManifestOpening,
  verifyReviewPackage,
  type ArtifactBytesInput,
  type ArtifactDescription,
  type ArtifactRefV1,
  type ArtifactRole,
  type CommitmentOpeningV1,
  type PackageVerificationV1,
  type ProtocolErrorCode,
  type ProtocolFailure,
  type ProtocolResult,
  type ReceiptReferenceV1,
  type ReviewPackageV1,
  type VerificationIssue,
} from '@lexaegis/protocol/v1';
