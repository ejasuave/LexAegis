/** Stable, redaction-safe vault error codes. A code never carries plaintext, keys or object contents. */
export const VAULT_ERROR_CODES = [
  'TOO_LARGE',
  'ENVELOPE_INVALID',
  'UNSUPPORTED_VERSION',
  /** The bytes do not match the digest or length a reference promised. */
  'REFERENCE_MISMATCH',
  /** Authentication failed: wrong key, altered header or ciphertext, or an object from elsewhere. One code, no guessing the cause. */
  'INTEGRITY',
  'KEY_UNAVAILABLE',
  'INVALID_INPUT',
  'QUOTA',
  'NOT_FOUND',
  'CONFLICT',
  'CYCLE',
  'MISSING_OBJECT',
  'CAPTURE_INCOMPLETE',
  'CAPTURE_MISMATCH',
  'BUNDLE_INVALID',
  'UNSAFE_CONTENT',
] as const;
export type VaultErrorCode = (typeof VAULT_ERROR_CODES)[number];

export type VaultResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly code: VaultErrorCode };

export const ok = <T>(data: T): VaultResult<T> => ({ ok: true, data });
export const err = (code: VaultErrorCode): VaultResult<never> => ({ ok: false, code });
