/** Stable, redaction-safe codes for registry helpers. A code never carries payload content. */
export const REGISTRY_ERROR_CODES = [
  // Action building
  'SNAPSHOT_INVALID',
  'REFERENCE_INVALID',
  'UNSUPPORTED_VERSION',
  'NONCE_INVALID',
  'DEADLINE_INVALID',
  'ZERO_COMMITMENT',
  'SUPERSEDES_UNEXPECTED',
  'SUPERSEDES_REQUIRED',
  'SUPERSEDES_MISMATCH',
  'CONTEXT_MISMATCH',
  'REPLACEMENT_EQUALS_PREVIOUS',
  // Typed data
  'ACTION_INVALID',
  'CHAIN_ID_INVALID',
  'REGISTRY_ADDRESS_INVALID',
  'DOMAIN_MISMATCH',
  'TYPED_DATA_INVALID',
  // Decoding observed chain data
  'CONTEXT_INVALID',
  'EMPTY_RESPONSE',
  'RESPONSE_MALFORMED',
  'STATUS_UNKNOWN',
  'LOG_MALFORMED',
  'LOG_ADDRESS_MISMATCH',
  'EVENT_UNKNOWN',
  'ERROR_UNKNOWN',
  // Binding
  'OPENING_INVALID',
  'OBSERVATION_INVALID',
] as const;

export type RegistryErrorCode = (typeof REGISTRY_ERROR_CODES)[number];

/** Plain, serializable failure. `path` holds field names and indexes only, never values. */
export interface RegistryFailure {
  readonly code: RegistryErrorCode;
  readonly path?: string;
}

export type RegistryResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: RegistryFailure };

export function succeed<T>(data: T): RegistryResult<T> {
  return { ok: true, data };
}

const SAFE_PATH = /^[A-Za-z0-9_.]{1,160}$/;

export function failWith(
  code: RegistryErrorCode,
  path?: readonly PropertyKey[],
): RegistryResult<never> {
  const joined = path?.map(String).join('.');
  return {
    ok: false,
    error: { code, ...(joined !== undefined && SAFE_PATH.test(joined) && { path: joined }) },
  };
}
