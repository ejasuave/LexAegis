import { decodeReviewExport, type PortableFailure } from '@lexaegis/protocol/portable';
import type { LiveBudgetOptions } from '../registry/budget';
import type { SignerAcceptancePolicy } from './signer-policy';
import {
  verifyReceipt,
  type LiveOptions,
  type VerifyReceiptFailure,
  type VerifyReceiptResult,
} from './verify-receipt';
import type { VerificationReportV1 } from './report';

/** Why `verifyReviewExport` returned no report. The two sources have separate code spaces. */
export type VerifyReviewExportFailure =
  | { readonly source: 'export'; readonly failure: PortableFailure }
  | { readonly source: 'verification'; readonly failure: VerifyReceiptFailure };

export type VerifyReviewExportResult =
  | {
      readonly ok: true;
      readonly data: { readonly generation: number; readonly report: VerificationReportV1 };
    }
  | { readonly ok: false; readonly error: VerifyReviewExportFailure };

export interface VerifyReviewExportInput {
  /** The exact bytes of a readable review export (ReviewExportV1). */
  readonly file: Uint8Array;
  /**
   * The receipt reference the recipient expects, obtained outside the file. When omitted, the
   * file's own declaration is used and the report says so (`referenceOrigin: "file-declared"`): that
   * mode gives no protection against a bundle that was rewritten consistently.
   */
  readonly expectedReference?: unknown;
  /** Live registry check. Omit it for a purely local check: no request is then made. */
  readonly live?: LiveOptions;
  /** The caller's rule for which reviewer accounts it accepts. Absent means "unknown". */
  readonly signerPolicy?: SignerAcceptancePolicy;
  readonly signal?: AbortSignal;
  readonly generation?: number;
  readonly now?: () => Date;
  readonly budget?: LiveBudgetOptions;
}

/**
 * Verifies a readable review export: strict bounded decode, full-package integrity against the
 * expected reference, then (only if `live` is given) a read-only registry check.
 *
 * It needs no wallet, key, backend, model or account. Local integrity results are kept when the
 * network part fails. The report is an observation, not a certificate, and has no combined
 * `valid` field.
 *
 * @example
 * ```ts
 * import { verifyReviewExport } from '@lexaegis/sdk/verify';
 *
 * declare const file: Uint8Array; // the export's exact bytes
 * declare const expected: unknown; // a ReceiptReferenceV1 you obtained independently
 *
 * const result = await verifyReviewExport({ file, expectedReference: expected });
 * if (result.ok) console.log(result.data.report.artifactIntegrity); // "match" | "mismatch" | "unknown"
 * ```
 */
export async function verifyReviewExport(
  input: VerifyReviewExportInput,
): Promise<VerifyReviewExportResult> {
  // Decoding is synchronous and runs before any await, so later mutation of `file` cannot matter.
  const decoded = decodeReviewExport(input.file);
  if (!decoded.ok) return { ok: false, error: { source: 'export', failure: decoded.error } };
  const { declaredReference, opening, artifacts } = decoded.data;

  const independent = input.expectedReference !== undefined;
  const result: VerifyReceiptResult = await verifyReceipt({
    mode: 'full-package',
    expectedReference: independent ? input.expectedReference : declaredReference,
    referenceOrigin: independent ? 'independent' : 'file-declared',
    declaredReference,
    opening,
    artifacts,
    ...(input.live !== undefined && { live: input.live }),
    ...(input.signerPolicy !== undefined && { signerPolicy: input.signerPolicy }),
    ...(input.signal !== undefined && { signal: input.signal }),
    ...(input.generation !== undefined && { generation: input.generation }),
    ...(input.now !== undefined && { now: input.now }),
    ...(input.budget !== undefined && { budget: input.budget }),
  });
  return result.ok
    ? result
    : { ok: false, error: { source: 'verification', failure: result.error } };
}
