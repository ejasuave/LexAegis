import { PORTABLE_LIMITS } from '@lexaegis/protocol/portable';
import { verifyReviewExport } from '@lexaegis/sdk/verify';
import { EMBED_LIMITS, type ResolvedConfig } from './config';
import { checkPackageUrl, type InputSnapshot } from './inputs';

/*
 * Optional, explicitly requested retrieval of a deliberately published readable review export, then
 * the SDK's offline check against the expected reference taken from the host's attributes. The
 * file never supplies an endpoint, a trusted deployment or an alternative expectation, and a
 * download is not a match. The check is local: it makes no registry request, so a chain failure
 * cannot erase it and a package mismatch cannot rewrite an observed chain status.
 */

/**
 * Transport limit: the existing ReviewExportV1 encoded-size limit (48 MiB). It is not a new
 * definition of valid protocol data, and it is enforced on the bytes actually read.
 */
export const MAX_PACKAGE_BYTES = PORTABLE_LIMITS.maxEncodedBytes;

export const INTEGRITY_KINDS = [
  'match',
  'mismatch',
  'incomplete',
  'unsupported',
  'unavailable',
] as const;
export type IntegrityKind = (typeof INTEGRITY_KINDS)[number];

export interface IntegrityOutcome {
  readonly kind: IntegrityKind;
  /** A stable, content-free code. Never a hash, label or file content. */
  readonly reason: string;
}

export const PACKAGE_FETCH_FAILURES = [
  'NOT_CONFIGURED',
  'ORIGIN_NOT_ALLOWED',
  'FETCH_FAILED',
  'HTTP_STATUS',
  'TIMEOUT',
  'TOO_LARGE',
  'ABORTED',
] as const;
export type PackageFetchFailure = (typeof PACKAGE_FETCH_FAILURES)[number];

export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

export interface PackageCheckOptions {
  readonly fetch?: FetchFunction;
  readonly signal?: AbortSignal;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

type Downloaded =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: PackageFetchFailure };

/** Reads at most `maxBytes` of the decoded body, counting bytes as they arrive. */
export async function downloadBounded(
  url: string,
  options: PackageCheckOptions,
): Promise<Downloaded> {
  const maxBytes = options.maxBytes ?? MAX_PACKAGE_BYTES;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? EMBED_LIMITS.packageMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted === true) controller.abort();
  const failure = (reason: PackageFetchFailure): Downloaded => ({
    ok: false,
    reason: timedOut ? 'TIMEOUT' : options.signal?.aborted === true ? 'ABORTED' : reason,
  });
  const chunks: Uint8Array[] = [];
  try {
    const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    const response = await doFetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok || response.redirected || response.type === 'opaque')
      return failure('HTTP_STATUS');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      controller.abort();
      return failure('TOO_LARGE');
    }
    if (response.body === null) return failure('FETCH_FAILED');
    const reader = response.body.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.length = 0;
        await reader.cancel().catch(() => undefined);
        controller.abort();
        return { ok: false, reason: 'TOO_LARGE' };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, bytes };
  } catch {
    return failure('FETCH_FAILED');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    chunks.length = 0;
  }
}

const UNSUPPORTED = new Set([
  'WRONG_FORMAT_ENCRYPTED_BACKUP',
  'WRONG_FORMAT_CONTEXT_EXPORT',
  'UNRECOGNISED_FORMAT',
  'UNSUPPORTED_VERSION',
]);
const INCOMPLETE = new Set(['ARTIFACT_SET_MISMATCH', 'ARTIFACT_ENCODING_INVALID']);
const TOO_LARGE = new Set([
  'INPUT_TOO_LARGE',
  'ARTIFACT_TOO_LARGE',
  'ARTIFACTS_TOO_LARGE',
  'OPENING_TOO_LARGE',
]);
const MISSING_EVIDENCE = new Set([
  'ARTIFACT_MISSING',
  'ARTIFACTS_NOT_SUPPLIED',
  'MANIFEST_NOT_SUPPLIED',
]);

/** Verifies the bytes against the expected reference. Never replaces that expectation. */
export async function verifyPackageBytes(
  bytes: Uint8Array,
  input: InputSnapshot,
  signal?: AbortSignal,
): Promise<IntegrityOutcome> {
  const result = await verifyReviewExport({
    file: bytes,
    expectedReference: input.reference,
    ...(signal !== undefined && { signal }),
  });
  if (!result.ok) {
    if (result.error.source === 'export') {
      const code = result.error.failure.code;
      if (UNSUPPORTED.has(code)) return { kind: 'unsupported', reason: code };
      if (INCOMPLETE.has(code)) return { kind: 'incomplete', reason: code };
      if (TOO_LARGE.has(code)) return { kind: 'unavailable', reason: 'TOO_LARGE' };
      return { kind: 'unavailable', reason: 'MALFORMED_PACKAGE' };
    }
    return { kind: 'unavailable', reason: result.error.failure.code };
  }
  const { report } = result.data;
  const codes = new Set(report.issues.map((issue) => issue.code));
  if (report.artifactIntegrity === 'match' && report.manifestIntegrity === 'match') {
    // A file that declares a different reference than the one expected is a conflict, not a match.
    if (codes.has('DECLARED_REFERENCE_CONFLICT'))
      return { kind: 'mismatch', reason: 'DECLARED_REFERENCE_CONFLICT' };
    return { kind: 'match', reason: 'EXACT_MATCH' };
  }
  const reason = report.issues[0]?.code ?? 'NOT_EVALUATED';
  for (const code of codes)
    if (MISSING_EVIDENCE.has(code)) return { kind: 'incomplete', reason: code };
  if (report.artifactIntegrity === 'mismatch' || report.manifestIntegrity === 'mismatch')
    return { kind: 'mismatch', reason };
  return { kind: 'unavailable', reason };
}

/** Download then verify. The URL must pass the host's approved package origins again. */
export async function checkPackage(
  input: InputSnapshot,
  config: ResolvedConfig,
  options: PackageCheckOptions = {},
): Promise<IntegrityOutcome> {
  if (input.packageUrl === null) return { kind: 'unavailable', reason: 'NOT_CONFIGURED' };
  const url = checkPackageUrl(input.packageUrl, config);
  if (url === null) return { kind: 'unavailable', reason: 'ORIGIN_NOT_ALLOWED' };
  const downloaded = await downloadBounded(url, options);
  if (!downloaded.ok) return { kind: 'unavailable', reason: downloaded.reason };
  return verifyPackageBytes(downloaded.bytes, input, options.signal);
}
