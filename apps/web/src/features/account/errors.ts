/** Redaction-safe account error codes. A code never carries key material, PRF bytes or a signature. */
export const ACCOUNT_ERROR_CODES = [
  'CONFIG_INVALID',
  'UNSUPPORTED',
  'PRF_UNAVAILABLE',
  /** Cancelled by this application (Cancel, lock, navigation) or reported as an abort. */
  'CANCELLED',
  /** The browser did not complete the prompt: dismissed, timed out or not allowed. The cause is not known more precisely. */
  'NOT_COMPLETED',
  'FAILED',
  'BUSY',
  /** A result arrived after the request it belonged to was superseded; it was discarded. */
  'STALE',
  'WRONG_CREDENTIAL',
  'ADDRESS_MISMATCH',
  'NO_ACCOUNT',
  'SESSION_LOCKED',
  'SESSION_EXPIRED',
  'SCOPE_REJECTED',
  'TICKET_INVALID',
  'BACKEND_UNAVAILABLE',
  'BACKEND_REJECTED',
  /** The capability exists in code but its prerequisites from later chapters do not. */
  'UNAVAILABLE',
] as const;
export type AccountErrorCode = (typeof ACCOUNT_ERROR_CODES)[number];

export type AccountResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly code: AccountErrorCode };

export const succeed = <T>(data: T): AccountResult<T> => ({ ok: true, data });
export const failWith = (code: AccountErrorCode): AccountResult<never> => ({ ok: false, code });

/** Zeroes caller-owned bytes. This reduces exposure; JavaScript cannot guarantee erasure of every copy. */
export function wipe(...buffers: (Uint8Array | null | undefined)[]): void {
  for (const buffer of buffers) buffer?.fill(0);
}
