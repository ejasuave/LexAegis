import { z } from 'zod';
import {
  applicationErrorSchema,
  createApplicationError,
  newRequestId,
  type ApplicationError,
} from './errors';

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApplicationError };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function fail<T = never>(error: ApplicationError): Result<T> {
  return { ok: false, error };
}

/** Closed discriminated result schema: success carries ok=true and data; failure carries ok=false and a validated error. */
export function resultSchema<T extends z.ZodType>(dataSchema: T) {
  return z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), data: dataSchema }),
    z.strictObject({ ok: z.literal(false), error: applicationErrorSchema }),
  ]);
}

/**
 * Typed failure for a capability that is not built or not configured yet.
 * `capability` must be a fixed, non-sensitive label.
 */
export function unavailable<T = never>(
  code: 'NOT_IMPLEMENTED' | 'NOT_CONFIGURED',
  capability: string,
  requestId: string = newRequestId(),
): Result<T> {
  const message =
    code === 'NOT_IMPLEMENTED'
      ? `${capability} is not implemented yet.`
      : `${capability} is not configured.`;
  return fail(createApplicationError(code, message, requestId));
}
