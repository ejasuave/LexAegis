import {
  artifactDigest,
  canonicalizeJson,
  parseStrictJson,
  type Bytes,
} from '@lexaegis/protocol/v1';
import { VAULT_LIMITS } from './constants';
import { err, ok, type VaultResult } from './errors';
import {
  vaultObjectEnvelopeSchema,
  type VaultObjectEnvelopeV1,
  type VaultObjectRefV1,
} from './schemas';

/** Exact wire bytes of any vault JSON value: UTF8(JCS(value)). */
export function encodeJcs(
  value: unknown,
  maxBytes = VAULT_LIMITS.maxEnvelopeBytes,
): VaultResult<Bytes> {
  try {
    return ok(canonicalizeJson(value, { maxBytes, maxDepth: VAULT_LIMITS.maxJsonDepth }));
  } catch {
    return err('TOO_LARGE');
  }
}

/** Strict, bounded JSON parse of untrusted bytes. Oversized input is rejected before decoding. */
export function parseJsonBytes(bytes: Uint8Array, maxBytes: number): VaultResult<unknown> {
  if (bytes.byteLength > maxBytes) return err('TOO_LARGE');
  try {
    return ok(parseStrictJson(bytes, { maxBytes, maxDepth: VAULT_LIMITS.maxJsonDepth }));
  } catch {
    return err('ENVELOPE_INVALID');
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Parses wire bytes into an envelope. The bytes must be exactly the canonical encoding of the
 * parsed value, so the digest of what was stored is the digest of what is understood.
 */
export function decodeEnvelope(bytes: Uint8Array): VaultResult<VaultObjectEnvelopeV1> {
  const parsed = parseJsonBytes(bytes, VAULT_LIMITS.maxEnvelopeBytes);
  if (!parsed.ok) return parsed;
  const value = vaultObjectEnvelopeSchema.safeParse(parsed.data);
  if (!value.success) {
    const header = (
      parsed.data as { header?: { schema?: unknown; cryptoProfileId?: unknown } } | null
    )?.header;
    const unsupported =
      header !== undefined &&
      typeof header === 'object' &&
      (typeof header.schema === 'string' || typeof header.cryptoProfileId === 'string') &&
      (header.schema !== 'lexaegis.vault-object.v1' ||
        header.cryptoProfileId !== 'lexaegis.vault.hkdf-sha256.aes-256-gcm.v1');
    return err(unsupported ? 'UNSUPPORTED_VERSION' : 'ENVELOPE_INVALID');
  }
  const canonical = encodeJcs(value.data);
  if (!canonical.ok || !sameBytes(canonical.data, bytes)) return err('ENVELOPE_INVALID');
  return ok(value.data);
}

export function encodeEnvelope(envelope: VaultObjectEnvelopeV1): VaultResult<Bytes> {
  return encodeJcs(vaultObjectEnvelopeSchema.parse(envelope));
}

/** Reference to complete wire bytes: their SHA-256 and length, not the plaintext's. */
export async function referenceOf(
  objectId: string,
  envelopeBytes: Uint8Array,
): Promise<VaultObjectRefV1> {
  return {
    objectId,
    envelopeSha256: await artifactDigest(envelopeBytes),
    envelopeByteLength: String(envelopeBytes.byteLength),
  };
}

/** True when `bytes` are exactly what `ref` promises. */
export async function matchesReference(ref: VaultObjectRefV1, bytes: Uint8Array): Promise<boolean> {
  return (
    String(bytes.byteLength) === ref.envelopeByteLength &&
    (await artifactDigest(bytes)) === ref.envelopeSha256
  );
}
