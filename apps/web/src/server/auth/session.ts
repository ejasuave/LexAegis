import 'server-only';
import { createApplicationError, fail, ok, type Result } from '@lexaegis/protocol';
import type { SessionView } from '@/lib/auth-schema';
import { getPool } from '../db/pool';
import { errorResponse, jsonResponse } from '../http';
import { readGuardedJson } from './request-guard';
import {
  createAuthService,
  loadAuthConfig,
  systemRandomBytes,
  type AuthReply,
  type AuthService,
} from './service';
import { createPostgresAuthStore } from './store';

let service: AuthService | undefined;
let origin: string | null | undefined;

/** The process-wide auth service. Without a database or origin it answers NOT_CONFIGURED; there is no bypass. */
export function getAuthService(): { service: AuthService; origin: string | null } {
  if (service === undefined) {
    const pool = getPool();
    const config = loadAuthConfig(process.env);
    origin = config?.origin ?? null;
    service = createAuthService({
      store: pool === null ? null : createPostgresAuthStore(pool),
      config,
      now: () => new Date(),
      randomBytes: systemRandomBytes,
    });
  }
  return { service, origin: origin ?? null };
}

export function replyResponse(reply: AuthReply, requestId: string): Response {
  const response = jsonResponse(reply.body, reply.status, requestId);
  for (const cookie of reply.cookies) response.headers.append('set-cookie', cookie);
  return response;
}

/** Runs the POST guard and returns the parsed body, or the uniform rejection response. */
export async function guardedBody(
  request: Request,
  requestId: string,
): Promise<{ body: unknown } | Response> {
  const { origin: configured } = getAuthService();
  if (configured === null) {
    return errorResponse(
      createApplicationError('NOT_CONFIGURED', 'Account sign-in is not configured.', requestId),
    );
  }
  const guarded = await readGuardedJson(request, configured);
  if (!guarded.ok) {
    return errorResponse(
      createApplicationError(
        guarded.reason === 'ORIGIN' || guarded.reason === 'HEADER' ? 'FORBIDDEN' : 'INVALID_INPUT',
        'The request was not accepted.',
        requestId,
      ),
    );
  }
  return { body: guarded.body };
}

/**
 * The only source of account ownership for server operations. The address comes from the session
 * cookie; an address supplied in a request body, query or header is never trusted.
 */
export async function requireAccountSession(request: Request): Promise<Result<SessionView>> {
  const session = await getAuthService().service.session(request.headers.get('cookie'));
  if (session === 'unavailable') {
    return fail(createApplicationError('NOT_CONFIGURED', 'Account sign-in is not configured.'));
  }
  if (session === 'unauthenticated')
    return fail(createApplicationError('UNAUTHENTICATED', 'Not signed in.'));
  return ok(session);
}
