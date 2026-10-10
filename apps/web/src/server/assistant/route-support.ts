import 'server-only';
import { createApplicationError, type ApplicationError } from '@lexaegis/protocol';
import { z } from 'zod';
import { AUTH_BODY_LIMIT, readGuardedBytes } from '../auth/request-guard';
import { errorResponse, jsonResponse, type RouteContext } from '../http';
import { logger } from '../logger';
import { getAssistantRuntime, type AssistantRuntime } from './runtime';

/*
 * Shared guards for the assistant routes. Ownership comes from the session only. Errors are
 * closed and redacted, and the log receives event names, request IDs and codes: never a request
 * or response body, a header, a prompt or an answer.
 */

export interface Authed {
  readonly runtime: AssistantRuntime;
  /** Lowercase session address: the run owner. */
  readonly owner: string;
}

const rejected = (requestId: string) =>
  createApplicationError('INVALID_INPUT', 'The request was not accepted.', requestId);

export async function authed(request: Request, requestId: string): Promise<Authed | Response> {
  const runtime = getAssistantRuntime();
  const session = await runtime.session(request);
  if (!session.ok) return errorResponse({ ...session.error, requestId });
  return { runtime, owner: session.data.address.toLowerCase() };
}

/**
 * An authenticated, origin-checked, JSON-only write with a body limit enforced while the bytes
 * are read. Requires the configured Origin and X-LexAegis-Request: 1.
 */
export async function authedBody(
  request: Request,
  requestId: string,
  limit: number = AUTH_BODY_LIMIT,
): Promise<(Authed & { readonly body: unknown }) | Response> {
  const auth = await authed(request, requestId);
  if (auth instanceof Response) return auth;
  if (auth.runtime.origin === null) {
    return errorResponse(
      createApplicationError('NOT_CONFIGURED', 'Account sign-in is not configured.', requestId),
    );
  }
  const guarded = await readGuardedBytes(request, auth.runtime.origin, limit);
  if (!guarded.ok) {
    return errorResponse(
      createApplicationError(
        guarded.reason === 'ORIGIN' || guarded.reason === 'HEADER' ? 'FORBIDDEN' : 'INVALID_INPUT',
        'The request was not accepted.',
        requestId,
      ),
    );
  }
  try {
    const body: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(guarded.bytes),
    );
    return { ...auth, body };
  } catch {
    return errorResponse(rejected(requestId));
  }
}

const runIdSchema = z.uuid();

export async function runIdOf(context: RouteContext): Promise<string | null> {
  const { runId } = await context.params;
  const parsed = runIdSchema.safeParse(runId);
  return parsed.success ? parsed.data.toLowerCase() : null;
}

/** A closed failure with a typed reason. Nothing from the request is echoed. */
export function reasonResponse(error: ApplicationError, reason: string): Response {
  const response = errorResponse(error);
  return jsonResponse({ ok: false, error, reason }, response.status, error.requestId);
}

export const invalid = (requestId: string): Response => errorResponse(rejected(requestId));

/** Operational metadata only: an event name, the request ID and a code. */
export function logRun(event: string, requestId: string, code?: string): void {
  logger.info({ event, requestId, ...(code !== undefined && { code }) });
}
