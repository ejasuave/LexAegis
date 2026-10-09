import { z } from 'zod';
import { nonZeroAddressSchema } from '@lexaegis/protocol/v1';

/*
 * LexAegis account recovery profile v1. FROZEN: a change to any value here creates different
 * keys, so it must be a new profile with a new ID, never an edit.
 *
 *   account PRF output (32 bytes) -> BIP-32 master seed -> EVM_PATH -> secp256k1 key
 *
 * The PRF output is used directly as the master seed: no BIP-39 step, no address- or
 * credential-derived input, and nothing about a chain, registry, label or database ID. This is
 * LexAegis's own scheme, not a statement about Mera's default derivation.
 */
export const PROFILE_ID = 'lexaegis.evm.bip32-prf.v1';
export const EVM_PATH = "m/44'/60'/0'/0/0";

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

const ACCOUNT_SALT_HEX = '21a6805c5ca9301d9b57c493b1a7705b1eb16fa2c83a9d6b1972f3d449e960bf';
const VAULT_SALT_HEX = 'de6e035a511d2e546d46d0110ccb8f057ba77248c641a73c0c795d34c1622980';

/**
 * SHA256(UTF8("lexaegis:account:evm:v1")), as 32 raw bytes. Public, and precomputed so a click
 * starts the passkey ceremony without waiting on anything. A fresh copy each call, because
 * callers and libraries may zero what they are given.
 */
export const accountPrfSalt = (): Uint8Array<ArrayBuffer> => fromHex(ACCOUNT_SALT_HEX);

/**
 * SHA256(UTF8("lexaegis:vault:root:v1")). Reserved for Chapter 5's separate encryption
 * namespace; never evaluated during account-only onboarding.
 */
export const vaultPrfSalt = (): Uint8Array<ArrayBuffer> => fromHex(VAULT_SALT_HEX);

export const PRF_SALT_LABELS = {
  account: 'lexaegis:account:evm:v1',
  vault: 'lexaegis:vault:root:v1',
} as const;

export const ACCOUNT_PROFILE_SCHEMA = 'lexaegis.account-profile.v1';

/** Canonical unpadded base64url, as Mera returns credential IDs. */
export const credentialIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,1366}$/)
  .refine((value) => value.length % 4 !== 1, 'not canonical base64url');

/**
 * Public account metadata, and nothing else. It may be cached in the browser as a discovery
 * hint. It is never proof of account control and recovery never depends on it.
 */
export const publicAccountProfileSchema = z.strictObject({
  schema: z.literal(ACCOUNT_PROFILE_SCHEMA),
  profileId: z.literal(PROFILE_ID),
  rpId: z.string().regex(/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/),
  credentialId: credentialIdSchema,
  transports: z
    .array(z.string().regex(/^[a-z0-9-]{1,32}$/))
    .max(8)
    .optional(),
  address: nonZeroAddressSchema,
});
export type PublicAccountProfile = z.infer<typeof publicAccountProfileSchema>;

const HINT_KEY = 'lexaegis.account-profile.v1';

interface HintStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Reads the cached hint. Anything malformed, or made for another rpId, is ignored. */
export function loadProfileHint(storage: HintStorage, rpId: string): PublicAccountProfile | null {
  try {
    const raw = storage.getItem(HINT_KEY);
    if (raw === null || raw.length > 4096) return null;
    const parsed = publicAccountProfileSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.rpId === rpId ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Stores the public profile only. Passing it through the closed schema keeps anything else out. */
export function saveProfileHint(storage: HintStorage, profile: PublicAccountProfile): void {
  try {
    storage.setItem(HINT_KEY, JSON.stringify(publicAccountProfileSchema.parse(profile)));
  } catch {
    // A full or blocked store only means there is no hint next time.
  }
}

export function forgetProfileHint(storage: HintStorage): void {
  try {
    storage.removeItem(HINT_KEY);
  } catch {
    // Nothing to forget.
  }
}
