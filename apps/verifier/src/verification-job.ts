import { z } from 'zod';
import { decodeReviewExport, PORTABLE_LIMITS } from '@lexaegis/protocol/portable';
import {
  parseCommitmentOpening,
  parseReceiptReference,
  type CommitmentOpeningV1,
  type ReceiptReferenceV1,
} from '@lexaegis/protocol/v1';
import { verifyOffline, type OfflineVerification } from '@lexaegis/sdk';

/*
 * The local verification job: the only code that touches imported bytes. It runs inside the
 * dedicated worker (verification-worker.ts) and is also callable directly in tests. It uses the
 * portable decoder and the offline SDK verifier, makes no network request and persists nothing.
 */

export const JOB_FAILURE_CODES = [
  'INPUT_TOO_LARGE',
  'INPUT_MALFORMED',
  'WRONG_FORMAT_ENCRYPTED_BACKUP',
  'WRONG_FORMAT_CONTEXT_EXPORT',
  'UNRECOGNISED_FORMAT',
  'UNSUPPORTED_VERSION',
  'UNKNOWN_FIELD',
  'SCHEMA_INVALID',
  'OPENING_TOO_LARGE',
  'ARTIFACT_SET_MISMATCH',
  'ARTIFACT_ENCODING_INVALID',
  'ARTIFACT_TOO_LARGE',
  'ARTIFACTS_TOO_LARGE',
  /** The expected reference text is not a valid receipt reference. */
  'REFERENCE_INVALID',
  /** An opening file has no reference of its own: one must be supplied separately. */
  'REFERENCE_REQUIRED',
  'VERIFY_FAILED',
  // Added by the job runner, never by the worker's own logic.
  'DEADLINE',
  'CANCELLED',
  'WORKER_FAILED',
] as const;
export type JobFailureCode = (typeof JOB_FAILURE_CODES)[number];

export const ARTIFACT_CHECKS = [
  'match',
  'mismatch',
  'missing',
  'not_supplied',
  'not_evaluated',
] as const;
export type ArtifactCheck = (typeof ARTIFACT_CHECKS)[number];

export interface InventoryItem {
  readonly artifactId: string;
  readonly role: string;
  readonly mediaType: string;
  /** Untrusted text from the file. Render it escaped and inert, never as HTML or a link. */
  readonly label: string | null;
  readonly byteLength: string;
  /** Private digest from the manifest, shown only inside the local technical disclosure. */
  readonly sha256: string;
  readonly check: ArtifactCheck;
}

export interface LocalResult {
  readonly offline: OfflineVerification;
  /** The reference the file declares, or null for an opening-only input. */
  readonly declaredReference: ReceiptReferenceV1 | null;
  readonly inventory: InventoryItem[];
  readonly artifactCount: number;
  readonly totalBytes: number;
}

export type JobProgress =
  | { readonly stage: 'parsing'; readonly bytes: number }
  | { readonly stage: 'decoded'; readonly artifacts: number; readonly bytes: number }
  | { readonly stage: 'hashing'; readonly artifacts: number };

export type JobOutcome =
  | { readonly ok: true; readonly result: LocalResult }
  | { readonly ok: false; readonly code: JobFailureCode };

export const jobInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('file'),
    bytes: z.instanceof(ArrayBuffer),
    /** The independently supplied reference, or null to use the one the file declares. */
    expectedReference: z.unknown(),
    hasExpectedReference: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('opening'),
    bytes: z.instanceof(ArrayBuffer),
    expectedReference: z.unknown(),
    hasExpectedReference: z.boolean(),
  }),
]);
export type JobInput = z.infer<typeof jobInputSchema>;

const fail = (code: JobFailureCode): JobOutcome => ({ ok: false, code });

function inventoryOf(
  opening: CommitmentOpeningV1,
  offline: OfflineVerification,
  supplied: boolean,
): InventoryItem[] {
  const missing = new Set(
    offline.issues.flatMap((issue) =>
      issue.code === 'ARTIFACT_MISSING' && issue.artifactId !== undefined ? [issue.artifactId] : [],
    ),
  );
  const changed = new Set(
    offline.issues.flatMap((issue) =>
      (issue.code === 'ARTIFACT_LENGTH_MISMATCH' || issue.code === 'ARTIFACT_DIGEST_MISMATCH') &&
      issue.artifactId !== undefined
        ? [issue.artifactId]
        : [],
    ),
  );
  return opening.manifest.artifacts.map((artifact) => {
    let check: ArtifactCheck;
    if (!supplied) check = 'not_supplied';
    else if (offline.manifestIntegrity !== 'match') check = 'not_evaluated';
    else if (missing.has(artifact.id)) check = 'missing';
    else if (changed.has(artifact.id)) check = 'mismatch';
    else check = offline.artifactIntegrity === 'match' ? 'match' : 'not_evaluated';
    return {
      artifactId: artifact.id,
      role: artifact.role,
      mediaType: artifact.mediaType,
      label: artifact.label,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
      check,
    };
  });
}

/** Runs one local job. Never throws for malformed input; never retains the bytes it was given. */
export async function runVerificationJob(
  rawInput: JobInput,
  progress: (update: JobProgress) => void = () => undefined,
): Promise<JobOutcome> {
  const input = jobInputSchema.safeParse(rawInput);
  if (!input.success) return fail('SCHEMA_INVALID');
  const { bytes: buffer, hasExpectedReference } = input.data;
  const bytes = new Uint8Array(buffer);
  progress({ stage: 'parsing', bytes: bytes.byteLength });

  let independent: ReceiptReferenceV1 | null = null;
  if (hasExpectedReference) {
    const parsed = parseReceiptReference(input.data.expectedReference);
    if (!parsed.ok) return fail('REFERENCE_INVALID');
    independent = parsed.data;
  }

  try {
    if (input.data.kind === 'opening') {
      if (independent === null) return fail('REFERENCE_REQUIRED');
      const opening = parseCommitmentOpening(bytes);
      if (!opening.ok) {
        return fail(
          opening.error.code === 'INPUT_TOO_LARGE' ? 'OPENING_TOO_LARGE' : 'SCHEMA_INVALID',
        );
      }
      progress({
        stage: 'decoded',
        artifacts: opening.data.manifest.artifacts.length,
        bytes: bytes.byteLength,
      });
      progress({ stage: 'hashing', artifacts: 0 });
      const verified = await verifyOffline({
        mode: 'manifest-only',
        expectedReference: independent,
        referenceOrigin: 'independent',
        opening: opening.data,
      });
      if (!verified.ok) return fail('VERIFY_FAILED');
      return {
        ok: true,
        result: {
          offline: verified.data,
          declaredReference: null,
          inventory: inventoryOf(opening.data, verified.data, false),
          artifactCount: 0,
          totalBytes: bytes.byteLength,
        },
      };
    }

    const decoded = decodeReviewExport(bytes);
    if (!decoded.ok) {
      // A small standalone opening is not a readable bundle: say what it is and what it needs.
      if (
        decoded.error.code === 'UNRECOGNISED_FORMAT' &&
        bytes.byteLength <= PORTABLE_LIMITS.maxStructuredBytes &&
        parseCommitmentOpening(bytes).ok
      ) {
        return fail('REFERENCE_REQUIRED');
      }
      return fail(decoded.error.code);
    }
    const { opening, artifacts, declaredReference, totalArtifactBytes } = decoded.data;
    progress({ stage: 'decoded', artifacts: artifacts.size, bytes: totalArtifactBytes });
    progress({ stage: 'hashing', artifacts: artifacts.size });
    const verified = await verifyOffline({
      mode: 'full-package',
      expectedReference: independent ?? declaredReference,
      referenceOrigin: independent === null ? 'file-declared' : 'independent',
      declaredReference,
      opening,
      artifacts,
    });
    // Best effort: the decoded copies are no longer needed once hashing is done.
    for (const value of artifacts.values()) value.fill(0);
    if (!verified.ok) return fail('VERIFY_FAILED');
    return {
      ok: true,
      result: {
        offline: verified.data,
        declaredReference,
        inventory: inventoryOf(opening, verified.data, true),
        artifactCount: artifacts.size,
        totalBytes: totalArtifactBytes,
      },
    };
  } finally {
    // Best effort only: the engine may keep other copies.
    bytes.fill(0);
  }
}
