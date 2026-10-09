import { z } from 'zod';
import {
  vaultDescriptorSchema,
  vaultHeadSchema,
  vaultObjectEnvelopeSchema,
  vaultObjectRefSchema,
  revisionSchema,
} from '@lexaegis/vault/v1';

/** Public request and response shapes of the vault routes, shared by the server and the browser. */
export const vaultViewSchema = z.strictObject({
  descriptor: vaultDescriptorSchema,
  head: vaultHeadSchema,
});
export type VaultView = z.infer<typeof vaultViewSchema>;

export const discoveryResponseSchema = z.strictObject({ vault: vaultViewSchema.nullable() });

export const createRequestSchema = z.strictObject({
  descriptor: vaultDescriptorSchema,
  catalog: vaultObjectEnvelopeSchema,
});

export const putHeadRequestSchema = z.strictObject({
  expectedRevision: revisionSchema,
  catalog: vaultObjectRefSchema,
});

export const putObjectResponseSchema = z.strictObject({ ref: vaultObjectRefSchema });

export const VAULT_API_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'QUOTA',
  'TOO_LARGE',
  'INVALID',
  'RATE_LIMITED',
  'NOT_CONFIGURED',
  'UNAVAILABLE',
  'UNCERTAIN',
  /** An owned, recorded object whose bytes storage no longer returns. Distinct from an unknown ID. */
  'MISSING',
  /** Storage returned bytes that no longer match the recorded digest. */
  'CORRUPT',
] as const;
export type VaultApiErrorCode = (typeof VAULT_API_ERROR_CODES)[number];

export const vaultErrorBodySchema = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({ code: z.enum(VAULT_API_ERROR_CODES), requestId: z.string().max(128) }),
  /** On a head conflict: the head that won, so the client can reload without guessing. */
  head: vaultHeadSchema.optional(),
});
export type VaultErrorBody = z.infer<typeof vaultErrorBodySchema>;
