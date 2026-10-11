/*
 * Portable bundle identifiers and limits. FROZEN with the readable export format (Chapter 5): the
 * wire format, identifiers and limits are the ones the vault already writes. The encrypted-backup
 * and context-export identifiers are listed only so a wrong file can be named specifically.
 */
export const REVIEW_EXPORT_SCHEMA = 'lexaegis.review-export.v1';
export const ENCRYPTED_EXPORT_SCHEMA = 'lexaegis.encrypted-review-export.v1';
export const CONTEXT_EXPORT_SCHEMA = 'lexaegis.matter-context-export.v1';

const MIB = 1024 * 1024;

export const PORTABLE_LIMITS = Object.freeze({
  /** The whole encoded bundle, in bytes. Checked before anything is decoded. */
  maxEncodedBytes: 48 * MIB,
  /** The manifest and the opening, canonical JSON (the Chapter 2 limit, not raised). */
  maxStructuredBytes: 1 * MIB,
  maxDepth: 32,
  maxArtifacts: 128,
  maxArtifactBytes: 10 * MIB,
  maxTotalArtifactBytes: 32 * MIB,
});

/** Largest unpadded base64url text that can decode to `bytes` bytes. */
export const maxEncodedLength = (bytes: number): number => Math.ceil((bytes * 4) / 3);
