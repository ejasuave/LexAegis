import { z } from 'zod';
import {
  commitmentOpeningV1Schema,
  receiptReferenceV1Schema,
  uuidSchema,
  type Bytes,
} from '@lexaegis/protocol/v1';
import { type VerifiedReview } from './frozen-review';
import { contextEntrySchema, matterRecordSchema, type MatterRecordV1 } from './matter';
import {
  ENCRYPTED_EXPORT_SCHEMA,
  CONTEXT_EXPORT_SCHEMA,
  REVIEW_EXPORT_SCHEMA,
  VAULT_LIMITS,
} from './v1/constants';
import { toBase64Url } from './v1/base64url';
import { decodeEnvelope, encodeJcs } from './v1/encoding';
import { err, type VaultResult } from './v1/errors';
import {
  vaultDescriptorSchema,
  vaultObjectEnvelopeSchema,
  vaultObjectRefSchema,
  type VaultDescriptorV1,
  type VaultObjectRefV1,
} from './v1/schemas';
import type { VerifiedFrozenReview } from './frozen-review';

/*
 * Three explicit, versioned JSON exports. Generated in the browser, never transmitted, and
 * never containing wallet keys, PRF output, signing sessions or vault key material.
 *
 * Readable review and context exports DISCLOSE private material to whoever holds the file: the
 * documents, notes and, for a review, the blinding nonce and the unsalted artifact hashes, so
 * the holder can copy them. A complete package is not "selectively disclosed" and nothing here
 * redacts it.
 */

export const encryptedReviewExportSchema = z.strictObject({
  schema: z.literal(ENCRYPTED_EXPORT_SCHEMA),
  descriptor: vaultDescriptorSchema,
  capture: vaultObjectRefSchema,
  objects: z.array(vaultObjectEnvelopeSchema).min(2).max(VAULT_LIMITS.maxEncryptedExportObjects),
});
export type EncryptedReviewExportV1 = z.infer<typeof encryptedReviewExportSchema>;

export const reviewExportSchema = z.strictObject({
  schema: z.literal(REVIEW_EXPORT_SCHEMA),
  receiptReference: receiptReferenceV1Schema,
  opening: commitmentOpeningV1Schema,
  artifacts: z
    .array(z.strictObject({ artifactId: uuidSchema, bytes: z.string().regex(/^[A-Za-z0-9_-]*$/) }))
    .max(VAULT_LIMITS.maxArtifacts),
});
export type ReviewExportV1 = z.infer<typeof reviewExportSchema>;

export const matterContextExportSchema = z.strictObject({
  schema: z.literal(CONTEXT_EXPORT_SCHEMA),
  matterId: uuidSchema,
  context: z.strictObject({
    entries: z.array(contextEntrySchema).max(VAULT_LIMITS.maxContextEntries),
  }),
});
export type MatterContextExportV1 = z.infer<typeof matterContextExportSchema>;

/** Encrypted backup of ONE review: the capture, its opening and its artifacts, sorted by object ID. */
export function buildEncryptedReviewExport(
  descriptor: VaultDescriptorV1,
  captureRef: VaultObjectRefV1,
  verified: VerifiedFrozenReview,
): VaultResult<Bytes> {
  const objects: z.infer<typeof vaultObjectEnvelopeSchema>[] = [];
  let total = 0;
  for (const [objectId, wire] of [...verified.envelopes].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const envelope = decodeEnvelope(wire);
    if (!envelope.ok || envelope.data.header.objectId !== objectId) return err('INTEGRITY');
    total += wire.byteLength;
    objects.push(envelope.data);
  }
  if (
    objects.length > VAULT_LIMITS.maxEncryptedExportObjects ||
    total > VAULT_LIMITS.maxEncryptedExportBytes
  ) {
    return err('TOO_LARGE');
  }
  const bundle = encryptedReviewExportSchema.safeParse({
    schema: ENCRYPTED_EXPORT_SCHEMA,
    descriptor,
    capture: captureRef,
    objects,
  });
  if (!bundle.success) return err('INVALID_INPUT');
  return encodeJcs(bundle.data, VAULT_LIMITS.maxEncryptedExportBytes);
}

/** Readable, disclosing export of a verified review: exact original bytes in manifest order. */
export function buildReadableReviewExport(review: VerifiedReview): VaultResult<Bytes> {
  const artifacts: { artifactId: string; bytes: string }[] = [];
  for (const id of review.artifactIds) {
    const bytes = review.artifactBytes(id);
    if (bytes === null) return err('CAPTURE_INCOMPLETE');
    artifacts.push({ artifactId: id, bytes: toBase64Url(bytes) });
    bytes.fill(0);
  }
  const bundle = reviewExportSchema.safeParse({
    schema: REVIEW_EXPORT_SCHEMA,
    receiptReference: review.reference,
    opening: review.opening,
    artifacts,
  });
  if (!bundle.success) return err('INVALID_INPUT');
  return encodeJcs(bundle.data, VAULT_LIMITS.maxReadableExportBytes);
}

/** Saved context and its source references only: no raw conversation and no document bytes. */
export function buildContextExport(record: MatterRecordV1): VaultResult<Bytes> {
  const bundle = matterContextExportSchema.safeParse({
    schema: CONTEXT_EXPORT_SCHEMA,
    matterId: matterRecordSchema.parse(record).matterId,
    context: record.context,
  });
  if (!bundle.success) return err('INVALID_INPUT');
  return encodeJcs(bundle.data, VAULT_LIMITS.maxContextExportBytes);
}

/** Safe generic download name: never a title, path or user-supplied text. */
export function exportFileName(
  kind: 'encrypted-review' | 'review' | 'context',
  id: string,
): string {
  const safe = /^[0-9a-f-]{36}$/.test(id) ? id : 'export';
  return `lexaegis-${kind}-${safe}.json`;
}
