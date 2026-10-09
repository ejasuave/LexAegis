import { z } from 'zod';
import { opaqueIdSchema } from './primitives';

export const errorCodeSchema = z.enum([
  'INVALID_INPUT',
  'NOT_IMPLEMENTED',
  'NOT_CONFIGURED',
  'UNAVAILABLE',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * Redaction-safe error: a stable code, a short fixed message and a request ID.
 * There is deliberately no free-form details field, so request payloads and secrets cannot leak.
 */
export const applicationErrorSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().min(1).max(240),
  requestId: opaqueIdSchema,
});
export type ApplicationError = z.infer<typeof applicationErrorSchema>;

export function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

export function createApplicationError(
  code: ErrorCode,
  message: string,
  requestId: string = newRequestId(),
): ApplicationError {
  return applicationErrorSchema.parse({ code, message: message.slice(0, 240), requestId });
}
