export * from './ports';

/*
 * Protocol v1 package preparation, hashing and offline verification, re-exported unchanged from
 * @lexaegis/protocol. The SDK adds no hashing logic of its own.
 *
 * This entry point is offline: importing it makes no network request, reads no environment or
 * storage, connects no wallet and signs nothing. Action builders return signing data only; the
 * caller supplies the approval interface, a supported signer and a transport. Network-enabled
 * checks are at `@lexaegis/sdk/verify`; action builders, typed data, the generated registry ABI and
 * binding are at `@lexaegis/sdk/registry`.
 */
export * from './portable';
export * from './verification';

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
