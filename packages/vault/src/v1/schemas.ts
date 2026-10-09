import { z } from 'zod';
import {
  decimalAtMost,
  digestSchema,
  nonZeroAddressSchema,
  unsignedDecimalSchema,
  uuidSchema,
} from '@lexaegis/protocol/v1';
import { fromBase64Url, toBase64Url } from './base64url';
import {
  ACCOUNT_PROFILE_ID,
  CRYPTO_PROFILE,
  DESCRIPTOR_SCHEMA,
  OBJECT_SCHEMA,
  UINT64_MAX,
  VAULT_LIMITS,
} from './constants';

/** Relying-party ID: the exact application hostname, as in Chapter 4. */
export const rpIdSchema = z.string().regex(/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/);

/** Canonical unsigned decimal no greater than the uint64 maximum. */
export const revisionSchema = unsignedDecimalSchema.refine(
  (value) => decimalAtMost(value, UINT64_MAX),
  'exceeds uint64',
);

/** Canonical unsigned decimal byte length. */
export const lengthSchema = unsignedDecimalSchema.refine(
  (value) => decimalAtMost(value, BigInt(VAULT_LIMITS.maxEnvelopeBytes)),
  'too large',
);

/** Canonical unpadded base64url whose decoding re-encodes to exactly the input. */
function base64UrlOf(minBytes: number, maxBytes: number, exact?: number) {
  return z
    .string()
    .max(Math.ceil((maxBytes * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9_-]*$/)
    .refine((value) => {
      const bytes = fromBase64Url(value);
      if (bytes === null) return false;
      if (exact !== undefined && bytes.length !== exact) return false;
      return bytes.length >= minBytes && bytes.length <= maxBytes && toBase64Url(bytes) === value;
    }, 'not canonical base64url');
}

export const hkdfSaltSchema = base64UrlOf(
  VAULT_LIMITS.hkdfSaltBytes,
  VAULT_LIMITS.hkdfSaltBytes,
  VAULT_LIMITS.hkdfSaltBytes,
);
export const ivSchema = base64UrlOf(
  VAULT_LIMITS.ivBytes,
  VAULT_LIMITS.ivBytes,
  VAULT_LIMITS.ivBytes,
);
/** Ciphertext includes the 16-byte tag. */
export const ciphertextSchema = base64UrlOf(VAULT_LIMITS.tagBytes, VAULT_LIMITS.maxEnvelopeBytes);

export const vaultDescriptorSchema = z.strictObject({
  schema: z.literal(DESCRIPTOR_SCHEMA),
  vaultId: uuidSchema,
  ownerAddress: nonZeroAddressSchema,
  rpId: rpIdSchema,
  accountProfileId: z.literal(ACCOUNT_PROFILE_ID),
  cryptoProfileId: z.literal(CRYPTO_PROFILE),
});
export type VaultDescriptorV1 = z.infer<typeof vaultDescriptorSchema>;

export const vaultObjectHeaderSchema = z.strictObject({
  schema: z.literal(OBJECT_SCHEMA),
  cryptoProfileId: z.literal(CRYPTO_PROFILE),
  vaultId: uuidSchema,
  objectId: uuidSchema,
  ownerAddress: nonZeroAddressSchema,
  rpId: rpIdSchema,
  hkdfSalt: hkdfSaltSchema,
  iv: ivSchema,
});
export type VaultObjectHeaderV1 = z.infer<typeof vaultObjectHeaderSchema>;

export const vaultObjectEnvelopeSchema = z.strictObject({
  header: vaultObjectHeaderSchema,
  ciphertext: ciphertextSchema,
});
export type VaultObjectEnvelopeV1 = z.infer<typeof vaultObjectEnvelopeSchema>;

export const vaultObjectRefSchema = z.strictObject({
  objectId: uuidSchema,
  envelopeSha256: digestSchema,
  envelopeByteLength: lengthSchema,
});
export type VaultObjectRefV1 = z.infer<typeof vaultObjectRefSchema>;

export const vaultHeadSchema = z.strictObject({
  revision: revisionSchema,
  catalog: vaultObjectRefSchema,
});
export type VaultHeadV1 = z.infer<typeof vaultHeadSchema>;

/** Who an object belongs to. Fixed per vault; every header must repeat it exactly. */
export interface VaultBinding {
  readonly vaultId: string;
  readonly ownerAddress: string;
  readonly rpId: string;
}
