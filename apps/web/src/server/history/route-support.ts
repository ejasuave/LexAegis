import 'server-only';
import { createApplicationError } from '@lexaegis/protocol';
import { errorResponse, jsonResponse } from '../http';
import { publicHeaders } from '../chain/route-support';
import { getChainRuntime } from '../chain/runtime';
import { ENVIO_LIMITS } from './envio-client';
import { getHistoryRuntime, type HistoryRuntime } from './runtime';
import type { HistoryHealth } from './schemas';

const LIMIT_PER_MINUTE = 60;

/** Same shared-store limiter as the chain routes, keyed by client address. */
export async function limitHistory(request: Request, requestId: string): Promise<Response | null> {
  const chain = getChainRuntime();
  if (chain.state !== 'ready' || chain.allow === null) return null;
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const window = new Date(Math.floor(chain.now().getTime() / 60_000) * 60_000);
  return (await chain.allow(`history:${forwarded.slice(0, 64)}`, window, LIMIT_PER_MINUTE))
    ? null
    : errorResponse(createApplicationError('RATE_LIMITED', 'Too many requests.', requestId));
}

export function historyJson(
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

export function invalid(requestId: string): Response {
  return errorResponse(
    createApplicationError('INVALID_INPUT', 'Invalid history request.', requestId),
  );
}

/** Rejects any query parameter that is not in the allowed set. */
export function onlyParams(request: Request, allowed: readonly string[]): URLSearchParams | null {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) if (!allowed.includes(key)) return null;
  for (const key of allowed) if (params.getAll(key).length > 1) return null;
  return params;
}

export function parseLimit(raw: string | null): number | null {
  if (raw === null) return ENVIO_LIMITS.defaultPageSize;
  if (!/^[1-9][0-9]{0,2}$/.test(raw)) return null;
  const value = Number(raw);
  return value <= ENVIO_LIMITS.maxPageSize ? value : null;
}

export function readyRuntime(): Extract<HistoryRuntime, { state: 'ready' }> | null {
  const runtime = getHistoryRuntime();
  return runtime.state === 'ready' ? runtime : null;
}

/** Index or deployment unavailable: a typed body with a non-success status, never an empty list. */
export function unavailableBody(health: HistoryHealth | null, reason: string): unknown {
  return { ok: false, status: 'unavailable', reason, health };
}
