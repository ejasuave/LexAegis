/**
 * Portable readable review bundles. Pure and offline: parsing a file performs no network request,
 * environment lookup, storage access or signing. Encrypted backups stay in @lexaegis/vault.
 */
import {
  decodeReviewExport,
  type DecodedReviewExport,
  type PortableResult,
} from '@lexaegis/protocol/portable';

export {
  PORTABLE_ERROR_CODES,
  PORTABLE_LIMITS,
  REVIEW_EXPORT_SCHEMA,
  reviewExportSchema,
  type DecodedReviewExport,
  type PortableErrorCode,
  type PortableFailure,
  type PortableResult,
  type ReviewExportV1,
} from '@lexaegis/protocol/portable';

/**
 * Strictly decodes a readable review export (ReviewExportV1) from raw bytes. The result keeps the
 * file's declared reference apart from any reference the caller supplies independently, and
 * retains the exact artifact bytes once. It does not verify anything: pass the result to
 * `verifyOffline` or `verifyReceipt` together with an expected reference.
 *
 * @example
 * ```ts
 * import { parseReviewExport } from '@lexaegis/sdk';
 *
 * declare const file: Uint8Array; // the exact bytes of a readable review export
 * const decoded = parseReviewExport(file);
 * if (!decoded.ok) console.error(decoded.error.code); // e.g. "ARTIFACT_SET_MISMATCH"
 * else console.log(decoded.data.declaredReference.commitment); // what the FILE claims
 * ```
 */
export function parseReviewExport(bytes: Uint8Array): PortableResult<DecodedReviewExport> {
  return decodeReviewExport(bytes);
}
