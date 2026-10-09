import { utf8, type Bytes } from '@lexaegis/protocol/v1';
import {
  AAD_DOMAIN,
  CRYPTO_PROFILE,
  KEY_INFO_DOMAIN,
  OBJECT_SCHEMA,
  VAULT_LIMITS,
} from '../v1/constants';
import {
  decodeEnvelope,
  encodeEnvelope,
  encodeJcs,
  matchesReference,
  referenceOf,
} from '../v1/encoding';
import { err, ok, type VaultResult } from '../v1/errors';
import { fromBase64Url, toBase64Url } from '../v1/base64url';
import {
  type VaultBinding,
  type VaultObjectEnvelopeV1,
  type VaultObjectHeaderV1,
  type VaultObjectRefV1,
} from '../v1/schemas';

/*
 * Production vault cryptography, exclusively through browser Web Crypto.
 *
 *   binding    = {cryptoProfileId, vaultId, objectId, ownerAddress, rpId}
 *   info       = UTF8("lexaegis:vault-object-key:v1") || 0x00 || UTF8(JCS(binding))
 *   aad        = UTF8("lexaegis:vault-object-aad:v1") || 0x00 || UTF8(JCS(header))
 *   key        = HKDF-SHA256(vaultPrfKey, salt = raw hkdfSalt, info) -> non-extractable AES-256-GCM
 *   ciphertext = AES-GCM(key, raw iv, plaintext, additionalData = aad, tagLength = 128)
 *
 * "||" is raw byte concatenation. The vault key is a non-extractable HKDF handle that never
 * leaves this class. Non-extractability and best-effort zeroing do not protect against
 * compromised same-origin JavaScript.
 */

/** Per-object randomness. Production code draws it from the CSPRNG; only tests inject it. */
export interface ObjectEntropy {
  readonly objectId: string;
  readonly hkdfSalt: Uint8Array;
  readonly iv: Uint8Array;
}

export function csprngEntropy(): ObjectEntropy {
  return {
    objectId: globalThis.crypto.randomUUID(),
    hkdfSalt: globalThis.crypto.getRandomValues(new Uint8Array(VAULT_LIMITS.hkdfSaltBytes)),
    iv: globalThis.crypto.getRandomValues(new Uint8Array(VAULT_LIMITS.ivBytes)),
  };
}

export type PlaintextKind = 'artifact' | 'structured';
const PLAINTEXT_LIMIT: Record<PlaintextKind, number> = {
  artifact: VAULT_LIMITS.maxArtifactBytes,
  structured: VAULT_LIMITS.maxStructuredBytes,
};

/** An immutable sealed object: resend `bytes` on every retry; never re-encrypt under the same ID. */
export interface SealedObject {
  readonly ref: VaultObjectRefV1;
  readonly bytes: Bytes;
}

function concat(domain: string, body: Uint8Array): Bytes {
  const prefix = utf8(domain);
  const out = new Uint8Array(prefix.length + 1 + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length + 1);
  return out;
}

function infoFor(header: VaultObjectHeaderV1): VaultResult<Bytes> {
  const binding = encodeJcs({
    cryptoProfileId: CRYPTO_PROFILE,
    vaultId: header.vaultId,
    objectId: header.objectId,
    ownerAddress: header.ownerAddress,
    rpId: header.rpId,
  });
  return binding.ok ? ok(concat(KEY_INFO_DOMAIN, binding.data)) : binding;
}

function aadFor(header: VaultObjectHeaderV1): VaultResult<Bytes> {
  const encoded = encodeJcs(header);
  return encoded.ok ? ok(concat(AAD_DOMAIN, encoded.data)) : encoded;
}

async function objectKey(
  base: CryptoKey,
  header: VaultObjectHeaderV1,
): Promise<VaultResult<CryptoKey>> {
  const salt = fromBase64Url(header.hkdfSalt);
  const info = infoFor(header);
  if (salt === null || !info.ok) return err('ENVELOPE_INVALID');
  const key = await globalThis.crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: info.data },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return ok(key);
}

/** @internal Seals with explicit entropy. Exported for the test-only vector module, never from the package. */
export async function sealWithEntropy(
  base: CryptoKey,
  binding: VaultBinding,
  plaintext: Uint8Array,
  kind: PlaintextKind,
  entropy: ObjectEntropy,
): Promise<VaultResult<SealedObject>> {
  if (plaintext.byteLength > PLAINTEXT_LIMIT[kind]) return err('TOO_LARGE');
  // An owned snapshot: later mutation by the caller cannot change what is encrypted.
  const snapshot = plaintext.slice();
  const header: VaultObjectHeaderV1 = {
    schema: OBJECT_SCHEMA,
    cryptoProfileId: CRYPTO_PROFILE,
    vaultId: binding.vaultId,
    objectId: entropy.objectId,
    ownerAddress: binding.ownerAddress,
    rpId: binding.rpId,
    hkdfSalt: toBase64Url(entropy.hkdfSalt),
    iv: toBase64Url(entropy.iv),
  };
  const aad = aadFor(header);
  const key = await objectKey(base, header);
  if (!aad.ok) return aad;
  if (!key.ok) return key;
  const ciphertext = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: entropy.iv.slice(), additionalData: aad.data, tagLength: 128 },
      key.data,
      snapshot,
    ),
  );
  snapshot.fill(0);
  const envelope: VaultObjectEnvelopeV1 = { header, ciphertext: toBase64Url(ciphertext) };
  const bytes = encodeEnvelope(envelope);
  if (!bytes.ok) return bytes;
  return ok({ ref: await referenceOf(header.objectId, bytes.data), bytes: bytes.data });
}

/**
 * The unlocked vault. Holds one non-extractable HKDF handle and nothing else secret. Dispose it
 * on every lock: after that, every operation fails closed with KEY_UNAVAILABLE.
 */
export class VaultKeys {
  #base: CryptoKey | null;

  private constructor(base: CryptoKey) {
    this.#base = base;
  }

  /**
   * Imports the trusted 32-byte vault PRF output as a non-extractable HKDF key. The input is
   * copied by Web Crypto; the caller still clears its own buffer.
   */
  static async fromPrf(prfOutput: Uint8Array): Promise<VaultResult<VaultKeys>> {
    if (prfOutput.byteLength !== 32) return err('INVALID_INPUT');
    try {
      const base = await globalThis.crypto.subtle.importKey(
        'raw',
        prfOutput.slice(),
        'HKDF',
        false,
        ['deriveKey'],
      );
      return ok(new VaultKeys(base));
    } catch {
      return err('KEY_UNAVAILABLE');
    }
  }

  get unlocked(): boolean {
    return this.#base !== null;
  }

  dispose(): void {
    this.#base = null;
  }

  /** Encrypts a new immutable object under a fresh ID, salt and IV from the CSPRNG. */
  encrypt(
    binding: VaultBinding,
    plaintext: Uint8Array,
    kind: PlaintextKind,
  ): Promise<VaultResult<SealedObject>> {
    const base = this.#base;
    if (base === null) return Promise.resolve(err('KEY_UNAVAILABLE'));
    return sealWithEntropy(base, binding, plaintext, kind, csprngEntropy());
  }

  /**
   * Verifies, then authenticates and decrypts. Order: size, expected digest and length,
   * envelope schema and canonical encoding, binding to the expected vault, owner, rpId and
   * object, and only then AES-GCM. No plaintext is returned unless every step passes, and every
   * key, tag and header failure is the same INTEGRITY error.
   */
  async decrypt(
    envelopeBytes: Uint8Array,
    expected: VaultBinding & { readonly ref?: VaultObjectRefV1; readonly objectId?: string },
    kind: PlaintextKind,
  ): Promise<VaultResult<Bytes>> {
    const base = this.#base;
    if (base === null) return err('KEY_UNAVAILABLE');
    if (envelopeBytes.byteLength > VAULT_LIMITS.maxEnvelopeBytes) return err('TOO_LARGE');
    if (expected.ref !== undefined && !(await matchesReference(expected.ref, envelopeBytes))) {
      return err('REFERENCE_MISMATCH');
    }
    const envelope = decodeEnvelope(envelopeBytes);
    if (!envelope.ok) return envelope;
    const { header } = envelope.data;
    const wantedObject = expected.objectId ?? expected.ref?.objectId;
    if (
      header.vaultId !== expected.vaultId ||
      header.ownerAddress !== expected.ownerAddress ||
      header.rpId !== expected.rpId ||
      (wantedObject !== undefined && header.objectId !== wantedObject)
    ) {
      return err('INTEGRITY');
    }
    const ciphertext = fromBase64Url(envelope.data.ciphertext);
    const iv = fromBase64Url(header.iv);
    const aad = aadFor(header);
    const key = await objectKey(base, header);
    if (ciphertext === null || iv === null || !aad.ok || !key.ok) return err('INTEGRITY');
    try {
      const plaintext = new Uint8Array(
        await globalThis.crypto.subtle.decrypt(
          { name: 'AES-GCM', iv, additionalData: aad.data, tagLength: 128 },
          key.data,
          ciphertext,
        ),
      );
      // The key may have been disposed while the browser worked: release nothing then.
      if (this.#base === null) {
        plaintext.fill(0);
        return err('KEY_UNAVAILABLE');
      }
      if (plaintext.byteLength > PLAINTEXT_LIMIT[kind]) {
        plaintext.fill(0);
        return err('TOO_LARGE');
      }
      return ok(plaintext);
    } catch {
      return err('INTEGRITY');
    }
  }
}
