import 'server-only';
import { createApplicationError, type ErrorCode } from '@lexaegis/protocol';
import { loadPublicConfig, readPublicEnv } from '@/config/public';
import { authorizedWrite } from '../vault/session';
import { requireAccountSession } from '../auth/session';
import { errorResponse, jsonResponse } from '../http';
import { getChainRuntime, type ChainRuntime } from './runtime';
import type { OperationFailure } from './operations';

type Ready = Extract<ChainRuntime, { state: 'ready' }>;

const CONFLICT = new Set<OperationFailure>([
  'IDEMPOTENCY_CONFLICT',
  'ACCOUNT_BUSY',
  'STATE_CHANGED',
  'NONCE_MISMATCH',
  'LIFECYCLE_REJECTED',
  'NONCE_COLLISION',
  'QUOTE_EXPIRED',
  'DEADLINE_REJECTED',
  'HASH_MISMATCH',
]);
const UNAVAILABLE = new Set<OperationFailure>([
  'CHAIN_UNAVAILABLE',
  'STATE_UNAVAILABLE',
  'SUBMISSION_UNKNOWN',
  'CLOCK_SKEW',
]);

function errorCodeFor(failure: OperationFailure): ErrorCode {
  if (failure === 'NOT_FOUND') return 'NOT_FOUND';
  if (failure === 'SENDER_MISMATCH' || failure === 'ACCOUNT_REJECTED') return 'FORBIDDEN';
  if (CONFLICT.has(failure)) return 'CONFLICT';
  if (UNAVAILABLE.has(failure)) return 'UNAVAILABLE';
  return 'INVALID_INPUT';
}

/** Closed failure body: a fixed message plus the typed reason. No payload, hash or signature is echoed. */
export function failureResponse(failure: OperationFailure, requestId: string): Response {
  const error = createApplicationError(
    errorCodeFor(failure),
    'The chain operation was not accepted.',
    requestId,
  );
  const response = errorResponse(error);
  return jsonResponse(
    { ok: false, error: { code: error.code, message: error.message, requestId }, reason: failure },
    response.status,
    requestId,
  );
}

export function notReady(requestId: string): Response {
  return errorResponse(
    createApplicationError('NOT_CONFIGURED', 'Monad testnet access is not configured.', requestId),
  );
}

export function ready(requestId: string): Ready | Response {
  const runtime = getChainRuntime();
  return runtime.state === 'ready' ? runtime : notReady(requestId);
}

/** Public read routes: only the configured verifier origin may read cross-origin, never with credentials. */
export function publicHeaders(request: Request): Record<string, string> {
  const config = loadPublicConfig(readPublicEnv());
  const verifier = config.ok ? config.config.verifierOrigin : undefined;
  return verifier !== undefined && request.headers.get('origin') === verifier
    ? { 'access-control-allow-origin': verifier, vary: 'origin' }
    : { vary: 'origin' };
}

export function publicJson(
  request: Request,
  body: unknown,
  status: number,
  requestId: string,
): Response {
  const response = jsonResponse(body, status, requestId);
  for (const [key, value] of Object.entries(publicHeaders(request)))
    response.headers.set(key, value);
  return response;
}

function windowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000);
}

export async function limited(
  runtime: Ready,
  bucket: string,
  limit: number,
  requestId: string,
): Promise<Response | null> {
  if (runtime.allow === null) return notReady(requestId);
  return (await runtime.allow(bucket, windowStart(runtime.now()), limit))
    ? null
    : errorResponse(createApplicationError('RATE_LIMITED', 'Too many requests.', requestId));
}

/** Authenticated, origin-checked, JSON-only, 16 KiB-bounded write. The owner is the session address. */
export async function authedJson(
  request: Request,
  requestId: string,
): Promise<{ address: string; body: unknown } | Response> {
  const auth = await authorizedWrite(request, requestId);
  if (auth instanceof Response) return auth;
  try {
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(auth.bytes));
    return { address: auth.address.toLowerCase(), body };
  } catch {
    return errorResponse(
      createApplicationError('INVALID_INPUT', 'The request was not accepted.', requestId),
    );
  }
}

export async function authedRead(
  request: Request,
  requestId: string,
): Promise<{ address: string } | Response> {
  const session = await requireAccountSession(request);
  if (!session.ok) return errorResponse({ ...session.error, requestId });
  return { address: session.data.address.toLowerCase() };
}
