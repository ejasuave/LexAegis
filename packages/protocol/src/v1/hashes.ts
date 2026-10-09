import { bytesToHex, captureBytes, concatBytes, utf8, type Bytes } from './bytes';
import { LIMITS, PACKAGE_DOMAIN } from './constants';
import { ProtocolError } from './errors';
import { artifactRefV1Schema, type ArtifactRefV1, type ArtifactRole } from './schemas';

function subtle(): SubtleCrypto {
  const provider = (globalThis as { crypto?: Partial<Crypto> }).crypto;
  const api = provider?.subtle;
  // Fail explicitly: there is no non-Web-Crypto fallback.
  if (api === undefined || typeof api.digest !== 'function') {
    throw new ProtocolError('CRYPTO_UNAVAILABLE');
  }
  return api;
}

/** SHA-256 through Web Crypto. `bytes` must be a buffer this module owns (see captureBytes). */
export async function sha256(bytes: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle().digest('SHA-256', bytes));
}

/** artifactDigest = SHA256(originalArtifactBytes). No extraction, line-ending or re-serialization. */
export async function artifactDigest(originalBytes: Uint8Array): Promise<string> {
  return bytesToHex(await sha256(captureBytes(originalBytes)));
}

const ZERO_BYTE = new Uint8Array([0x00]);

/** packageDigest = SHA256(UTF8(PACKAGE_DOMAIN) || BYTE(0x00) || canonicalBytes), as 32 raw bytes. */
export async function packageDigestBytes(canonicalBytes: Uint8Array): Promise<Bytes> {
  return sha256(concatBytes(utf8(PACKAGE_DOMAIN), ZERO_BYTE, canonicalBytes));
}

export async function packageDigest(canonicalBytes: Uint8Array): Promise<string> {
  return bytesToHex(await packageDigestBytes(canonicalBytes));
}

export interface ArtifactDescription {
  readonly id: string;
  readonly role: ArtifactRole;
  readonly mediaType: string;
  readonly label: string | null;
}

/**
 * Builds an ArtifactRefV1 whose byteLength and sha256 are computed from the actual bytes, never
 * taken from a caller claim. Throws ProtocolError for oversized bytes or invalid metadata.
 */
export async function describeArtifact(
  description: ArtifactDescription,
  originalBytes: Uint8Array,
): Promise<ArtifactRefV1> {
  if (!(originalBytes instanceof Uint8Array)) throw new ProtocolError('ARTIFACT_INPUT_INVALID');
  if (originalBytes.byteLength > LIMITS.maxArtifactBytes) {
    throw new ProtocolError('ARTIFACT_TOO_LARGE');
  }
  const owned = captureBytes(originalBytes);
  const parsed = artifactRefV1Schema.safeParse({
    id: description.id,
    role: description.role,
    mediaType: description.mediaType,
    label: description.label,
    byteLength: String(owned.byteLength),
    sha256: bytesToHex(await sha256(owned)),
  });
  if (!parsed.success) throw new ProtocolError('SCHEMA_INVALID');
  return Object.freeze(parsed.data);
}
