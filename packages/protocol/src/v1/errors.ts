/** Stable, redaction-safe error codes. A code never carries payload content. */
export const PROTOCOL_ERROR_CODES = [
  // Raw JSON and object-input import
  'INPUT_TOO_LARGE',
  'INVALID_UTF8',
  'BYTE_ORDER_MARK',
  'INVALID_JSON',
  'DUPLICATE_KEY',
  'NESTING_TOO_DEEP',
  'UNSAFE_NUMBER',
  'LONE_SURROGATE',
  'FORBIDDEN_KEY',
  'UNSUPPORTED_VALUE',
  // Schema validation
  'UNSUPPORTED_VERSION',
  'UNKNOWN_FIELD',
  'SCHEMA_INVALID',
  // Manifest structure
  'TOO_MANY_ARTIFACTS',
  'DUPLICATE_ARTIFACT_ID',
  'SOURCE_ARTIFACT_REQUIRED',
  'DECISION_LOG_ARTIFACT_INVALID',
  'DUPLICATE_SCOPE_ID',
  'UNRESOLVED_ARTIFACT_REFERENCE',
  'SCOPE_INCOMPLETE',
  'DECISION_LOG_REFERENCE_INVALID',
  'SUPERSEDES_CONTEXT_MISMATCH',
  'ARTIFACT_TOO_LARGE',
  'ARTIFACTS_TOO_LARGE',
  // Supplied artifact bytes
  'ARTIFACT_INPUT_INVALID',
  'ARTIFACT_MISSING',
  'ARTIFACT_DUPLICATE',
  'ARTIFACT_EXTRA',
  'ARTIFACT_LENGTH_MISMATCH',
  'ARTIFACT_DIGEST_MISMATCH',
  // Bytes and cryptography
  'INVALID_HEX',
  'INVALID_BYTE_LENGTH',
  'CRYPTO_UNAVAILABLE',
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set(PROTOCOL_ERROR_CODES);

export function isProtocolErrorCode(value: unknown): value is ProtocolErrorCode {
  return typeof value === 'string' && CODE_SET.has(value);
}

/** Plain, serializable failure. `path` holds schema field names and indexes only, never values. */
export interface ProtocolFailure {
  readonly code: ProtocolErrorCode;
  readonly path?: string;
  /** Opaque artifact UUID from the manifest, when an artifact is the cause. */
  readonly artifactId?: string;
}

export interface ProtocolErrorDetail {
  readonly path?: string;
  readonly artifactId?: string;
}

const SAFE_PATH = /^[A-Za-z0-9_.]{1,160}$/;

/** Thrown by low-level functions. Its message is the code alone, so it is safe to log. */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly path: string | undefined;
  readonly artifactId: string | undefined;

  constructor(code: ProtocolErrorCode, detail: ProtocolErrorDetail = {}) {
    super(code);
    this.name = 'ProtocolError';
    this.code = code;
    this.path = detail.path !== undefined && SAFE_PATH.test(detail.path) ? detail.path : undefined;
    this.artifactId = detail.artifactId;
  }

  toFailure(): ProtocolFailure {
    return {
      code: this.code,
      ...(this.path !== undefined && { path: this.path }),
      ...(this.artifactId !== undefined && { artifactId: this.artifactId }),
    };
  }
}

export type ProtocolResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: ProtocolFailure };

function failure(error: unknown): ProtocolResult<never> {
  // Anything that is not a ProtocolError is a defect, not malformed input: let it surface.
  if (error instanceof ProtocolError) return { ok: false, error: error.toFailure() };
  throw error;
}

/** Runs a throwing protocol function and returns a typed result. */
export function toResult<T>(run: () => T): ProtocolResult<T> {
  try {
    return { ok: true, data: run() };
  } catch (error) {
    return failure(error);
  }
}

export async function toResultAsync<T>(run: () => Promise<T>): Promise<ProtocolResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    return failure(error);
  }
}
