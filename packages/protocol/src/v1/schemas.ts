import { z } from 'zod';
import {
  APPROVAL_INTENT,
  ARTIFACT_ROLES,
  LIMITS,
  OPENING_SCHEMA,
  PACKAGE_SCHEMA,
  REFERENCE_SCHEMA,
} from './constants';
import type { ProtocolErrorCode } from './errors';
import {
  artifactByteLengthSchema,
  blindingNonceSchema,
  chainIdSchema,
  digestSchema,
  labelSchema,
  mediaTypeSchema,
  nonZeroAddressSchema,
  profileIdSchema,
  profileVersionSchema,
  timestampSchema,
  uuidSchema,
} from './primitives';

export const artifactRoleSchema = z.enum(ARTIFACT_ROLES);
export type ArtifactRole = z.infer<typeof artifactRoleSchema>;

/**
 * Reference to one artifact. `sha256` is the digest of the exact original bytes. Labels and
 * plain content hashes are private: they belong to the opening, never to a public projection.
 */
export const artifactRefV1Schema = z.strictObject({
  id: uuidSchema,
  role: artifactRoleSchema,
  mediaType: mediaTypeSchema,
  label: labelSchema.nullable(),
  byteLength: artifactByteLengthSchema,
  sha256: digestSchema,
});
export type ArtifactRefV1 = z.infer<typeof artifactRefV1Schema>;

/**
 * The only projection suitable for public use. The chain/registry/reviewer/commitment tuple
 * identifies the intended receipt; it does not establish that a receipt exists or is active.
 */
export const receiptReferenceV1Schema = z.strictObject({
  schema: z.literal(REFERENCE_SCHEMA),
  chainId: chainIdSchema,
  registryAddress: nonZeroAddressSchema,
  reviewerAddress: nonZeroAddressSchema,
  commitment: digestSchema,
});
export type ReceiptReferenceV1 = z.infer<typeof receiptReferenceV1Schema>;

const packageShape = z.strictObject({
  schema: z.literal(PACKAGE_SCHEMA),
  packageId: uuidSchema,
  /** Supplied application timestamp, not proof of when a review occurred. */
  preparedAt: timestampSchema,
  profile: z.strictObject({ id: profileIdSchema, version: profileVersionSchema }),
  context: z.strictObject({
    chainId: chainIdSchema,
    registryAddress: nonZeroAddressSchema,
    reviewerAddress: nonZeroAddressSchema,
  }),
  /** Declared intended predecessor. It does not establish that predecessor's existence or status. */
  supersedes: receiptReferenceV1Schema.nullable(),
  /** Array order is committed data. */
  artifacts: z.array(artifactRefV1Schema).max(LIMITS.maxArtifacts),
  approval: z.strictObject({
    intent: z.literal(APPROVAL_INTENT),
    scopeArtifactIds: z.array(uuidSchema).max(LIMITS.maxArtifacts),
    decisionLogArtifactId: uuidSchema,
  }),
});

type PackageShape = z.infer<typeof packageShape>;

interface StructureIssue {
  readonly code: ProtocolErrorCode;
  readonly path: readonly (string | number)[];
}

/** Cross-field rules that JSON Schema cannot express. Returns the first violated rule, if any. */
export function findStructureIssue(manifest: PackageShape): StructureIssue | null {
  const { artifacts, approval, context, supersedes } = manifest;
  const roleById = new Map<string, ArtifactRole>();
  for (const [index, artifact] of artifacts.entries()) {
    if (roleById.has(artifact.id)) {
      return { code: 'DUPLICATE_ARTIFACT_ID', path: ['artifacts', index, 'id'] };
    }
    roleById.set(artifact.id, artifact.role);
  }
  if (!artifacts.some((artifact) => artifact.role === 'source')) {
    return { code: 'SOURCE_ARTIFACT_REQUIRED', path: ['artifacts'] };
  }
  if (artifacts.filter((artifact) => artifact.role === 'decision-log').length !== 1) {
    return { code: 'DECISION_LOG_ARTIFACT_INVALID', path: ['artifacts'] };
  }

  const scope = new Set<string>();
  for (const [index, id] of approval.scopeArtifactIds.entries()) {
    const path = ['approval', 'scopeArtifactIds', index];
    if (scope.has(id)) return { code: 'DUPLICATE_SCOPE_ID', path };
    if (!roleById.has(id)) return { code: 'UNRESOLVED_ARTIFACT_REFERENCE', path };
    scope.add(id);
  }
  // Every artifact must be in scope exactly once.
  if (scope.size !== roleById.size) {
    return { code: 'SCOPE_INCOMPLETE', path: ['approval', 'scopeArtifactIds'] };
  }

  const decisionLogRole = roleById.get(approval.decisionLogArtifactId);
  if (decisionLogRole === undefined) {
    return { code: 'UNRESOLVED_ARTIFACT_REFERENCE', path: ['approval', 'decisionLogArtifactId'] };
  }
  if (decisionLogRole !== 'decision-log') {
    return { code: 'DECISION_LOG_REFERENCE_INVALID', path: ['approval', 'decisionLogArtifactId'] };
  }

  const total = artifacts.reduce((sum, artifact) => sum + BigInt(artifact.byteLength), 0n);
  if (total > BigInt(LIMITS.maxTotalArtifactBytes)) {
    return { code: 'ARTIFACTS_TOO_LARGE', path: ['artifacts'] };
  }

  if (
    supersedes !== null &&
    (supersedes.chainId !== context.chainId ||
      supersedes.registryAddress !== context.registryAddress ||
      supersedes.reviewerAddress !== context.reviewerAddress)
  ) {
    return { code: 'SUPERSEDES_CONTEXT_MISMATCH', path: ['supersedes'] };
  }
  return null;
}

/**
 * The private review-package manifest. It binds artifact hashes, profile, reviewer, chain,
 * registry and intended predecessor. It never carries storage URLs, keys, signatures or
 * transaction data, and unknown fields are rejected rather than stripped.
 */
export const reviewPackageV1Schema = packageShape.check((ctx) => {
  // Cross-field rules assume every field is already well-formed.
  if (ctx.issues.length > 0) return;
  const issue = findStructureIssue(ctx.value);
  if (issue !== null) {
    ctx.issues.push({
      code: 'custom',
      message: issue.code,
      input: ctx.value,
      path: [...issue.path],
      params: { protocolCode: issue.code },
    });
  }
});
export type ReviewPackageV1 = z.infer<typeof reviewPackageV1Schema>;

/**
 * Private opening material: the manifest, its unsalted artifact hashes and the blinding nonce.
 * Keep it encrypted with the evidence; never log it or place it in a public projection.
 */
export const commitmentOpeningV1Schema = z.strictObject({
  schema: z.literal(OPENING_SCHEMA),
  manifest: reviewPackageV1Schema,
  blindingNonce: blindingNonceSchema,
});
export type CommitmentOpeningV1 = z.infer<typeof commitmentOpeningV1Schema>;
