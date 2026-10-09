import { verifyReviewPackage, type Bytes, type ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import type { VaultKeys } from './crypto/browser-crypto';
import {
  encryptedReviewExportSchema,
  matterContextExportSchema,
  reviewExportSchema,
  type MatterContextExportV1,
} from './export';
import { VerifiedReview, verifyFrozenReview, type RecoverableCapture } from './frozen-review';
import { addEntry, type MatterRecordV1 } from './matter';
import { VAULT_LIMITS } from './v1/constants';
import { fromBase64Url, toBase64Url } from './v1/base64url';
import { encodeEnvelope, parseJsonBytes } from './v1/encoding';
import { err, ok, type VaultResult } from './v1/errors';

/*
 * Imports are untrusted data. Parsing is strict and bounded, nothing is executed, unzipped or
 * fetched, and nothing persistent changes until the user confirms the preview. An import never
 * transfers a reviewer's signing authority, and it does not establish current on-chain status.
 */

const sameReference = (a: ReceiptReferenceV1, b: ReceiptReferenceV1) =>
  a.chainId === b.chainId &&
  a.registryAddress === b.registryAddress &&
  a.reviewerAddress === b.reviewerAddress &&
  a.commitment === b.commitment;

export interface ReviewImportPreview {
  readonly kind: 'readable' | 'encrypted';
  readonly packageId: string;
  /** The reviewer named in the imported manifest. Foreign unless it equals the importing account. */
  readonly reviewerAddress: string;
  readonly receiptReference: ReceiptReferenceV1;
  readonly artifactCount: number;
  readonly totalArtifactBytes: number;
  /** The files agree with the bundle's own claimed reference. Not an agreement with the chain. */
  readonly consistentWithClaimedReference: boolean;
  /** Agreement with a separately supplied expected reference, or null when none was supplied. */
  readonly matchesExpectedReference: boolean | null;
  /** Always unknown here: a bundle cannot establish current on-chain status. */
  readonly chainStatus: 'unknown';
  readonly foreignReviewer: boolean;
}

export interface ReviewImport {
  readonly preview: ReviewImportPreview;
  /** Present only when the files are consistent; a tampered bundle yields a preview and no review. */
  readonly review: VerifiedReview | null;
  /** Present for an encrypted bundle that was authenticated end to end. */
  readonly capture: RecoverableCapture | null;
}

export interface ImportContext {
  readonly ownerAddress: string;
  readonly rpId: string;
  /** A separately obtained expected receipt reference, if the user has one. */
  readonly expectedReference?: ReceiptReferenceV1;
}

/** Readable review bundle: reconstruct exact bytes and run the Chapter 2 verification. */
export async function parseReadableReviewExport(
  bytes: Uint8Array,
  context: ImportContext,
): Promise<VaultResult<ReviewImport>> {
  const json = parseJsonBytes(bytes, VAULT_LIMITS.maxReadableExportBytes);
  if (!json.ok) return err(json.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'BUNDLE_INVALID');
  const bundle = reviewExportSchema.safeParse(json.data);
  if (!bundle.success) return err('BUNDLE_INVALID');
  const { opening, receiptReference } = bundle.data;

  // Exactly the manifest's artifacts, once each, in manifest order.
  const wanted = opening.manifest.artifacts.map((artifact) => artifact.id);
  const given = bundle.data.artifacts.map((artifact) => artifact.artifactId);
  if (wanted.length !== given.length || !wanted.every((id, index) => given[index] === id))
    return err('BUNDLE_INVALID');

  const artifacts = new Map<string, Bytes>();
  let total = 0;
  for (const entry of bundle.data.artifacts) {
    const decoded = fromBase64Url(entry.bytes);
    if (decoded === null || toBase64Url(decoded) !== entry.bytes) return err('BUNDLE_INVALID');
    if (decoded.byteLength > VAULT_LIMITS.maxArtifactBytes) return err('TOO_LARGE');
    total += decoded.byteLength;
    if (total > VAULT_LIMITS.maxTotalArtifactBytes) return err('TOO_LARGE');
    artifacts.set(entry.artifactId, decoded);
  }

  const verification = await verifyReviewPackage(opening, artifacts, receiptReference);
  if (!verification.ok) return err('BUNDLE_INVALID');
  const consistent =
    verification.data.manifestIntegrity === 'match' &&
    verification.data.artifactIntegrity === 'match';
  return ok({
    preview: {
      kind: 'readable',
      packageId: opening.manifest.packageId,
      reviewerAddress: opening.manifest.context.reviewerAddress,
      receiptReference,
      artifactCount: artifacts.size,
      totalArtifactBytes: total,
      consistentWithClaimedReference: consistent,
      matchesExpectedReference:
        context.expectedReference === undefined
          ? null
          : sameReference(context.expectedReference, receiptReference),
      chainStatus: 'unknown',
      foreignReviewer: opening.manifest.context.reviewerAddress !== context.ownerAddress,
    },
    review: consistent ? VerifiedReview.create(opening, receiptReference, artifacts) : null,
    capture: null,
  });
}

/**
 * Encrypted review bundle: requires the descriptor and every header to name the verified owner
 * and rpId, authenticates the capture and all referenced objects with the unlocked vault key,
 * validates the whole graph, rejects unreferenced extras, and verifies the recovered review.
 */
export async function parseEncryptedReviewExport(
  bytes: Uint8Array,
  keys: VaultKeys,
  context: ImportContext,
  generation: number,
): Promise<VaultResult<ReviewImport>> {
  const json = parseJsonBytes(bytes, VAULT_LIMITS.maxEncryptedExportBytes);
  if (!json.ok) return err(json.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'BUNDLE_INVALID');
  const bundle = encryptedReviewExportSchema.safeParse(json.data);
  if (!bundle.success) return err('BUNDLE_INVALID');
  const { descriptor, capture, objects } = bundle.data;
  if (descriptor.ownerAddress !== context.ownerAddress || descriptor.rpId !== context.rpId)
    return err('INTEGRITY');

  const wire = new Map<string, Uint8Array>();
  for (const envelope of objects) {
    const { header } = envelope;
    if (
      header.vaultId !== descriptor.vaultId ||
      header.ownerAddress !== descriptor.ownerAddress ||
      header.rpId !== descriptor.rpId ||
      wire.has(header.objectId)
    ) {
      return err('BUNDLE_INVALID');
    }
    const encoded = encodeEnvelope(envelope);
    if (!encoded.ok) return encoded;
    wire.set(header.objectId, encoded.data);
  }

  const binding = {
    vaultId: descriptor.vaultId,
    ownerAddress: descriptor.ownerAddress,
    rpId: descriptor.rpId,
  };
  // Nothing is fetched from anywhere but the bundle itself.
  const verified = await verifyFrozenReview(
    keys,
    binding,
    capture,
    (ref) => Promise.resolve(wire.get(ref.objectId) ?? null),
    generation,
  );
  if (!verified.ok) return verified;
  if (verified.data.envelopes.size !== wire.size) return err('BUNDLE_INVALID');

  const { review } = verified.data;
  return ok({
    preview: {
      kind: 'encrypted',
      packageId: review.opening.manifest.packageId,
      reviewerAddress: review.opening.manifest.context.reviewerAddress,
      receiptReference: review.reference,
      artifactCount: review.artifactIds.length,
      totalArtifactBytes: review.artifactIds.reduce(
        (sum, id) => sum + (review.artifactBytes(id)?.byteLength ?? 0),
        0,
      ),
      consistentWithClaimedReference: true,
      matchesExpectedReference:
        context.expectedReference === undefined
          ? null
          : sameReference(context.expectedReference, review.reference),
      chainStatus: 'unknown',
      foreignReviewer: review.opening.manifest.context.reviewerAddress !== context.ownerAddress,
    },
    review,
    capture: verified.data.capture,
  });
}

export function parseContextExport(bytes: Uint8Array): VaultResult<MatterContextExportV1> {
  const json = parseJsonBytes(bytes, VAULT_LIMITS.maxContextExportBytes);
  if (!json.ok) return err(json.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'BUNDLE_INVALID');
  const bundle = matterContextExportSchema.safeParse(json.data);
  return bundle.success ? ok(bundle.data) : err('BUNDLE_INVALID');
}

/**
 * Adds only the selected imported entries to a matter, as UNCONFIRMED entries with imported
 * provenance and fresh IDs. Existing entries, sources and frozen reviews are never replaced or
 * merged. References to versions this matter lacks stay visibly unresolved.
 */
export function importContextEntries(
  record: MatterRecordV1,
  exported: MatterContextExportV1,
  selectedEntryIds: readonly string[],
  now: string,
  newId: () => string = () => globalThis.crypto.randomUUID(),
): VaultResult<MatterRecordV1> {
  let next = record;
  for (const id of new Set(selectedEntryIds)) {
    const entry = exported.context.entries.find((item) => item.entryId === id);
    if (entry === undefined) return err('NOT_FOUND');
    const added = addEntry(
      next,
      {
        entryId: newId(),
        kind: entry.kind,
        text: entry.text,
        sourceRefs: entry.sourceRefs,
        origin: 'imported',
        importedFrom: exported.matterId,
        confirmed: false,
      },
      now,
    );
    if (!added.ok) return added;
    next = added.data;
  }
  return ok(next);
}
