import { bytesToHex, concatBytes, hexToBytes, utf8, type Bytes } from './bytes';
import { COMMITMENT_DOMAIN, LIMITS } from './constants';
import { ProtocolError } from './errors';
import { sha256 } from './hashes';

const ZERO_BYTE = new Uint8Array([0x00]);

/**
 * commitment = SHA256(UTF8(COMMITMENT_DOMAIN) || BYTE(0x00) || blindingNonce32 || packageDigest32)
 *
 * A randomized hash commitment. It is not encryption, not a zero-knowledge proof and not a claim
 * of anonymous chain activity. Deterministic for explicit inputs, which is what opening
 * verification and fixed test vectors rely on.
 */
export async function computeCommitmentBytes(
  blindingNonce: Uint8Array,
  packageDigest: Uint8Array,
): Promise<Bytes> {
  if (
    blindingNonce.byteLength !== LIMITS.blindingNonceBytes ||
    packageDigest.byteLength !== LIMITS.digestBytes
  ) {
    throw new ProtocolError('INVALID_BYTE_LENGTH');
  }
  return sha256(concatBytes(utf8(COMMITMENT_DOMAIN), ZERO_BYTE, blindingNonce, packageDigest));
}

/** Hex in, hex out. Inputs are decoded to bytes first; hexadecimal text is never hashed. */
export async function computeCommitment(
  blindingNonceHex: string,
  packageDigestHex: string,
): Promise<string> {
  return bytesToHex(
    await computeCommitmentBytes(
      hexToBytes(blindingNonceHex, LIMITS.blindingNonceBytes),
      hexToBytes(packageDigestHex, LIMITS.digestBytes),
    ),
  );
}

/**
 * Fresh 32-byte blinding nonce from the platform CSPRNG. There is no fallback and no seed: if
 * secure randomness is unavailable this throws. The nonce blinds the commitment; it is not an
 * encryption key, a WebAuthn PRF namespace or a transaction replay nonce, and it must never be
 * derived from timestamps, document hashes, signatures, account keys or PRF outputs.
 */
export function generateBlindingNonce(): Bytes {
  const provider = (globalThis as { crypto?: Partial<Crypto> }).crypto;
  if (provider === undefined || typeof provider.getRandomValues !== 'function') {
    throw new ProtocolError('CRYPTO_UNAVAILABLE');
  }
  const nonce = new Uint8Array(LIMITS.blindingNonceBytes);
  provider.getRandomValues(nonce);
  return nonce;
}
