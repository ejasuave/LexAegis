import 'server-only';
import {
  applicationErrorSchema,
  createApplicationError,
  newRequestId,
  type ApplicationError,
  type ErrorCode,
} from '@lexaegis/protocol';
import { logger } from './logger';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
  NOT_CONFIGURED: 503,
  UNAVAILABLE: 503,
};

/** Sensitive responses are never cached and never sniffed. */
export function jsonResponse(body: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-request-id': requestId,
    },
  });
}

export function errorResponse(error: ApplicationError): Response {
  return jsonResponse(
    { ok: false, error: applicationErrorSchema.parse(error) },
    STATUS_BY_CODE[error.code],
    error.requestId,
  );
}

/** Response for an unfinished operation. It can never be mistaken for success. */
export function notImplementedResponse(capability: string, requestId = newRequestId()): Response {
  return errorResponse(
    createApplicationError('NOT_IMPLEMENTED', `${capability} is not implemented yet.`, requestId),
  );
}

/**
 * Wraps a route handler with a request ID and the shared error mapper. Any thrown exception
 * becomes a fixed INTERNAL error: neither the message nor the stack reaches the client or logs.
 */
/** The dynamic-route context Next.js passes; absent for routes without parameters. */
export interface RouteContext {
  readonly params: Promise<Record<string, string | string[] | undefined>>;
}

export function handleRoute(
  handler: (
    requestId: string,
    request: Request,
    context: RouteContext,
  ) => Promise<Response> | Response,
): (request: Request, context?: RouteContext) => Promise<Response> {
  return async (request, context = { params: Promise.resolve({}) }) => {
    const requestId = newRequestId();
    try {
      return await handler(requestId, request, context);
    } catch {
      logger.error({ event: 'route.unhandled_exception', requestId, code: 'INTERNAL' });
      return errorResponse(
        createApplicationError('INTERNAL', 'Unexpected server error.', requestId),
      );
    }
  };
}
