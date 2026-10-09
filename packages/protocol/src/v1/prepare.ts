import { collectArtifacts, type ArtifactBytesInput, type CollectedArtifacts } from './artifacts';
import { bytesToHex, deepFreeze } from './bytes';
import { canonicalizeReviewPackage } from './canonicalize';
import { computeCommitmentBytes, generateBlindingNonce } from './commitment';
import { OPENING_SCHEMA, REFERENCE_SCHEMA } from './constants';
import { ProtocolError, toResult, toResultAsync, type ProtocolResult } from './errors';
import { packageDigestBytes, sha256 } from './hashes';
import { readReviewPackage } from './parse';
import { createPrepared, type PreparedReviewPackage } from './prepared';
import {
  commitmentOpeningV1Schema,
  receiptReferenceV1Schema,
  type ReviewPackageV1,
} from './schemas';

interface Captured {
  readonly manifest: ReviewPackageV1;
  readonly artifacts: CollectedArtifacts;
}

/** Entirely synchronous: validates and takes independent copies of the metadata and the bytes. */
function capture(manifestInput: unknown, artifactBytesById: unknown): Captured {
  const manifest = readReviewPackage(manifestInput);
  const artifacts = collectArtifacts(manifest, artifactBytesById);
  // Exactly the referenced set: nothing extra, nothing missing, and every length as declared.
  const [extra] = artifacts.extra;
  if (extra !== undefined) {
    throw new ProtocolError('ARTIFACT_EXTRA', extra === null ? {} : { artifactId: extra });
  }
  const [missing] = artifacts.missing;
  if (missing !== undefined) throw new ProtocolError('ARTIFACT_MISSING', { artifactId: missing });
  const [wrongLength] = artifacts.lengthMismatch;
  if (wrongLength !== undefined) {
    throw new ProtocolError('ARTIFACT_LENGTH_MISMATCH', { artifactId: wrongLength });
  }
  return { manifest, artifacts };
}

async function finish({ manifest, artifacts }: Captured): Promise<PreparedReviewPackage> {
  // Every digest is recomputed. A discrepancy is rejected; the manifest is never rewritten to fit.
  for (const artifact of manifest.artifacts) {
    const bytes = artifacts.captured.get(artifact.id);
    if (bytes === undefined)
      throw new ProtocolError('ARTIFACT_MISSING', { artifactId: artifact.id });
    if (bytesToHex(await sha256(bytes)) !== artifact.sha256) {
      throw new ProtocolError('ARTIFACT_DIGEST_MISMATCH', { artifactId: artifact.id });
    }
  }

  const canonicalManifest = canonicalizeReviewPackage(manifest);
  const digest = await packageDigestBytes(canonicalManifest);
  const nonce = generateBlindingNonce();
  const commitment = bytesToHex(await computeCommitmentBytes(nonce, digest));

  // Explicit field allowlist: only these five values ever leave as the public reference.
  const reference = deepFreeze(
    receiptReferenceV1Schema.parse({
      schema: REFERENCE_SCHEMA,
      chainId: manifest.context.chainId,
      registryAddress: manifest.context.registryAddress,
      reviewerAddress: manifest.context.reviewerAddress,
      commitment,
    }),
  );
  const opening = deepFreeze(
    commitmentOpeningV1Schema.parse({
      schema: OPENING_SCHEMA,
      manifest,
      blindingNonce: bytesToHex(nonce),
    }),
  );
  nonce.fill(0);

  return createPrepared({
    opening,
    reference,
    packageDigest: bytesToHex(digest),
    canonicalManifest,
    artifacts: artifacts.captured,
  });
}

/**
 * Captures an immutable snapshot of a review package and derives its private opening and public
 * reference with a fresh blinding nonce.
 *
 * The manifest and every supplied byte are validated and copied before the first asynchronous
 * operation, so caller mutation during hashing cannot change the result. Any later edit to
 * source bytes, findings, decisions, rule data, model configuration, scope or context requires a
 * new preparation and a new human approval.
 *
 * This prepares; it does not sign, publish, persist or approve anything.
 */
export function prepareReviewPackage(
  manifestInput: unknown,
  artifactBytesById: ArtifactBytesInput,
): Promise<ProtocolResult<PreparedReviewPackage>> {
  const captured = toResult(() => capture(manifestInput, artifactBytesById));
  if (!captured.ok) return Promise.resolve(captured);
  return toResultAsync(() => finish(captured.data));
}
