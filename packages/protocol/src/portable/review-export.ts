import { z } from 'zod';
import { toBase64Url, fromBase64Url } from './base64url';
import { PORTABLE_LIMITS, REVIEW_EXPORT_SCHEMA, maxEncodedLength } from './constants';
import { canonicalizeJson } from '../v1/canonicalize';
import { LIMITS } from '../v1/constants';
import { ProtocolError, type ProtocolErrorCode } from '../v1/errors';
import { parseStrictJson } from '../v1/parse-json';
import { readCommitmentOpening, readReceiptReference } from '../v1/parse';
import { uuidSchema } from '../v1/primitives';
import {
  commitmentOpeningV1Schema,
  receiptReferenceV1Schema,
  type CommitmentOpeningV1,
  type ReceiptReferenceV1,
} from '../v1/schemas';
import type { Bytes } from '../v1/bytes';
import { ENCRYPTED_EXPORT_SCHEMA, CONTEXT_EXPORT_SCHEMA } from './constants';

/**
 * The readable review export envelope (Chapter 5, unchanged). `bytes` is canonical unpadded
 * base64url of the original artifact bytes, in manifest artifact order. The envelope carries no
 * signature, claimed status, provider URL or trust policy, and never will.
 */
export const reviewExportSchema = z.strictObject({
  schema: z.literal(REVIEW_EXPORT_SCHEMA),
  receiptReference: receiptReferenceV1Schema,
  opening: commitmentOpeningV1Schema,
  artifacts: z
    .array(
      z.strictObject({
        artifactId: uuidSchema,
        bytes: z
          .string()
          .max(maxEncodedLength(PORTABLE_LIMITS.maxArtifactBytes))
          .regex(/^[A-Za-z0-9_-]*$/),
      }),
    )
    .max(PORTABLE_LIMITS.maxArtifacts),
});
export type ReviewExportV1 = z.infer<typeof reviewExportSchema>;

export const PORTABLE_ERROR_CODES = [
  'INPUT_TOO_LARGE',
  /** Not strict JSON: malformed UTF-8, BOM, duplicate or escaped-equivalent keys, trailing content, unsafe numbers, depth. */
  'INPUT_MALFORMED',
  /** A different LexAegis file: an encrypted backup needs the owner's vault. */
  'WRONG_FORMAT_ENCRYPTED_BACKUP',
  /** A different LexAegis file: saved context holds no review package. */
  'WRONG_FORMAT_CONTEXT_EXPORT',
  'UNRECOGNISED_FORMAT',
  'UNSUPPORTED_VERSION',
  'UNKNOWN_FIELD',
  'SCHEMA_INVALID',
  /** The opening or manifest is larger than the Chapter 2 limit. */
  'OPENING_TOO_LARGE',
  /** The artifact entries are not exactly the manifest's artifacts, once each, in manifest order. */
  'ARTIFACT_SET_MISMATCH',
  'ARTIFACT_ENCODING_INVALID',
  'ARTIFACT_TOO_LARGE',
  'ARTIFACTS_TOO_LARGE',
] as const;
export type PortableErrorCode = (typeof PORTABLE_ERROR_CODES)[number];

/** Redaction-safe failure: a code, the schema field path where one applies, and no content. */
export interface PortableFailure {
  readonly code: PortableErrorCode;
  readonly path?: string;
  /** The underlying strict-parser code for INPUT_MALFORMED, never a value from the input. */
  readonly cause?: ProtocolErrorCode;
}

export type PortableResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: PortableFailure };

const fail = (
  code: PortableErrorCode,
  extra: { path?: string; cause?: ProtocolErrorCode } = {},
): PortableResult<never> => ({ ok: false, error: { code, ...extra } });

/** What a successful decode retains: the declared reference, the opening and the exact bytes. */
export interface DecodedReviewExport {
  /** The reference the FILE claims. It is not an independently supplied expectation. */
  readonly declaredReference: ReceiptReferenceV1;
  readonly opening: CommitmentOpeningV1;
  /** Exact decoded bytes by artifact ID, in manifest order. Each artifact was decoded once. */
  readonly artifacts: ReadonlyMap<string, Bytes>;
  readonly totalArtifactBytes: number;
}

function safePath(path: readonly PropertyKey[]): string | undefined {
  const joined = path.map(String).join('.');
  return /^[A-Za-z0-9_.]{1,160}$/.test(joined) ? joined : undefined;
}

function schemaOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const schema = (value as { schema?: unknown }).schema;
  return typeof schema === 'string' ? schema : null;
}

function classify(value: unknown): PortableResult<never> | null {
  const schema = schemaOf(value);
  if (schema === ENCRYPTED_EXPORT_SCHEMA) return fail('WRONG_FORMAT_ENCRYPTED_BACKUP');
  if (schema === CONTEXT_EXPORT_SCHEMA) return fail('WRONG_FORMAT_CONTEXT_EXPORT');
  if (schema === null) return fail('UNRECOGNISED_FORMAT', { path: 'schema' });
  if (schema !== REVIEW_EXPORT_SCHEMA) {
    return /^lexaegis\.review-export\./.test(schema)
      ? fail('UNSUPPORTED_VERSION', { path: 'schema' })
      : fail('UNRECOGNISED_FORMAT', { path: 'schema' });
  }
  return null;
}

/**
 * Strict, bounded decode of a readable review export from raw bytes. It performs no network
 * access, normalises nothing and repairs nothing: the artifact bytes are exactly the committed
 * ones or the decode fails. It establishes the format only; use the offline verifier to learn
 * whether the files match a receipt reference.
 */
export function decodeReviewExport(input: unknown): PortableResult<DecodedReviewExport> {
  if (!(input instanceof Uint8Array)) return fail('INPUT_MALFORMED');
  // Bound the input before any decoding or parsing.
  if (input.byteLength > PORTABLE_LIMITS.maxEncodedBytes) return fail('INPUT_TOO_LARGE');

  let json: unknown;
  try {
    json = parseStrictJson(input, {
      maxBytes: PORTABLE_LIMITS.maxEncodedBytes,
      maxDepth: PORTABLE_LIMITS.maxDepth,
    });
  } catch (error) {
    if (error instanceof ProtocolError) {
      return error.code === 'INPUT_TOO_LARGE'
        ? fail('INPUT_TOO_LARGE')
        : fail('INPUT_MALFORMED', { cause: error.code });
    }
    throw error;
  }

  const wrong = classify(json);
  if (wrong !== null) return wrong;

  const envelope = reviewExportSchema.safeParse(json);
  if (!envelope.success) {
    const issue = envelope.error.issues[0];
    const path = issue === undefined ? undefined : safePath(issue.path);
    const extra = path === undefined ? {} : { path };
    if (issue?.code === 'unrecognized_keys') return fail('UNKNOWN_FIELD', extra);
    if (issue?.code === 'too_big' && path?.startsWith('artifacts.') && path.endsWith('.bytes')) {
      return fail('ARTIFACT_TOO_LARGE', extra);
    }
    return fail('SCHEMA_INVALID', extra);
  }
  const { opening: openingValue, receiptReference, artifacts: entries } = envelope.data;

  // The Chapter 2 structured-input limit is not raised for a larger outer bundle.
  try {
    const manifestBytes = canonicalizeJson(openingValue.manifest, {
      maxBytes: LIMITS.maxJsonBytes,
      maxDepth: LIMITS.maxDepth,
    });
    const openingBytes = canonicalizeJson(openingValue, {
      maxBytes: LIMITS.maxJsonBytes,
      maxDepth: LIMITS.maxDepth,
    });
    if (manifestBytes.byteLength > PORTABLE_LIMITS.maxStructuredBytes) {
      return fail('OPENING_TOO_LARGE', { path: 'opening.manifest' });
    }
    if (openingBytes.byteLength > PORTABLE_LIMITS.maxStructuredBytes) {
      return fail('OPENING_TOO_LARGE', { path: 'opening' });
    }
  } catch (error) {
    if (error instanceof ProtocolError) return fail('OPENING_TOO_LARGE', { path: 'opening' });
    throw error;
  }

  // Re-read through the Chapter 2 readers so the frozen, validated protocol objects are returned.
  let opening: CommitmentOpeningV1;
  let declaredReference: ReceiptReferenceV1;
  try {
    opening = readCommitmentOpening(openingValue);
    declaredReference = readReceiptReference(receiptReference);
  } catch (error) {
    if (error instanceof ProtocolError) {
      return error.code === 'INPUT_TOO_LARGE'
        ? fail('OPENING_TOO_LARGE', { path: 'opening' })
        : fail('SCHEMA_INVALID', error.path === undefined ? {} : { path: error.path });
    }
    throw error;
  }

  // Exactly the manifest's artifacts, once each, in manifest order. Reject before decoding bytes.
  const wanted = opening.manifest.artifacts.map((artifact) => artifact.id);
  if (
    wanted.length !== entries.length ||
    !wanted.every((id, index) => entries[index]?.artifactId === id)
  ) {
    return fail('ARTIFACT_SET_MISMATCH', { path: 'artifacts' });
  }

  // Declared lengths are known from the manifest, so bound the decoded total first.
  const declaredTotal = opening.manifest.artifacts.reduce(
    (sum, artifact) => sum + BigInt(artifact.byteLength),
    0n,
  );
  if (declaredTotal > BigInt(PORTABLE_LIMITS.maxTotalArtifactBytes)) {
    return fail('ARTIFACTS_TOO_LARGE', { path: 'artifacts' });
  }

  const artifacts = new Map<string, Bytes>();
  let total = 0;
  for (const [index, entry] of entries.entries()) {
    const path = `artifacts.${index}.bytes`;
    // Compute the decoded length from the text length before allocating anything.
    const tail = entry.bytes.length % 4;
    if (tail === 1) return fail('ARTIFACT_ENCODING_INVALID', { path });
    const decodedLength = Math.floor(entry.bytes.length / 4) * 3 + (tail === 0 ? 0 : tail - 1);
    if (decodedLength > PORTABLE_LIMITS.maxArtifactBytes) {
      return fail('ARTIFACT_TOO_LARGE', { path });
    }
    total += decodedLength;
    if (total > PORTABLE_LIMITS.maxTotalArtifactBytes) {
      return fail('ARTIFACTS_TOO_LARGE', { path: 'artifacts' });
    }
    const decoded = fromBase64Url(entry.bytes);
    // Noncanonical text (nonzero trailing bits) re-encodes differently and is rejected.
    if (decoded === null || toBase64Url(decoded) !== entry.bytes) {
      return fail('ARTIFACT_ENCODING_INVALID', { path });
    }
    artifacts.set(entry.artifactId, decoded);
  }
  return { ok: true, data: { declaredReference, opening, artifacts, totalArtifactBytes: total } };
}
