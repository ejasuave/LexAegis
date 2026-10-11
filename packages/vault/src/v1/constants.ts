/*
 * Vault format v1. FROZEN: changing any value below changes what existing ciphertext means, so
 * it requires a new crypto profile and schema versions, never an edit.
 */
export const CRYPTO_PROFILE = 'lexaegis.vault.hkdf-sha256.aes-256-gcm.v1';
export const ACCOUNT_PROFILE_ID = 'lexaegis.evm.bip32-prf.v1';

export const DESCRIPTOR_SCHEMA = 'lexaegis.vault-descriptor.v1';
export const OBJECT_SCHEMA = 'lexaegis.vault-object.v1';
export const CATALOG_SCHEMA = 'lexaegis.vault-catalog.v1';
export const MATTER_SCHEMA = 'lexaegis.matter.v1';
export const FROZEN_REVIEW_SCHEMA = 'lexaegis.frozen-review.v1';
// The readable-export and wrong-format identifiers are owned by the portable protocol module.
export {
  CONTEXT_EXPORT_SCHEMA,
  ENCRYPTED_EXPORT_SCHEMA,
  REVIEW_EXPORT_SCHEMA,
} from '@lexaegis/protocol/portable';

/** Domain separators, followed by one 0x00 byte and the JCS of the binding or header. */
export const KEY_INFO_DOMAIN = 'lexaegis:vault-object-key:v1';
export const AAD_DOMAIN = 'lexaegis:vault-object-aad:v1';

const MIB = 1024 * 1024;

export const VAULT_LIMITS = Object.freeze({
  hkdfSaltBytes: 32,
  ivBytes: 12,
  tagBytes: 16,
  /** One original artifact, and the receipt protocol's own artifact limits. */
  maxArtifactBytes: 10 * MIB,
  maxArtifacts: 128,
  maxTotalArtifactBytes: 32 * MIB,
  /** Catalog, matter record, opening and capture payloads. */
  maxStructuredBytes: 1 * MIB,
  /** One wire envelope. */
  maxEnvelopeBytes: 16 * MIB,
  maxJsonDepth: 32,
  /** Application quotas per account vault: storage limits, not receipt protocol limits. */
  maxMatters: 16,
  maxObjects: 2048,
  maxStoredBytes: 256 * MIB,
  /** Portable bundles. */
  maxEncryptedExportObjects: 130,
  maxEncryptedExportBytes: 64 * MIB,
  maxReadableExportBytes: 48 * MIB,
  maxContextExportBytes: 1 * MIB,
  /** Working context. */
  maxContextEntries: 256,
  maxContextEntryBytes: 4 * 1024,
  maxSelectedContextBytes: 32 * 1024,
  maxTitleChars: 200,
});

/** uint64 maximum, the largest revision. */
export const UINT64_MAX = 2n ** 64n - 1n;
