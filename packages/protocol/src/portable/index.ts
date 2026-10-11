/**
 * Portable review bundles: the dependency-free readable export envelope and its bounded strict
 * decoder. Pure functions for browsers and Node.js with no network, storage or key access.
 * Encrypted backups, vault keys and controllers stay in @lexaegis/vault.
 */
export {
  CONTEXT_EXPORT_SCHEMA,
  ENCRYPTED_EXPORT_SCHEMA,
  PORTABLE_LIMITS,
  REVIEW_EXPORT_SCHEMA,
  maxEncodedLength,
} from './constants';
export { fromBase64Url, toBase64Url } from './base64url';
export {
  PORTABLE_ERROR_CODES,
  decodeReviewExport,
  reviewExportSchema,
  type DecodedReviewExport,
  type PortableErrorCode,
  type PortableFailure,
  type PortableResult,
  type ReviewExportV1,
} from './review-export';
