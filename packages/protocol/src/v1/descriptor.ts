import { deepFreeze } from './bytes';
import {
  APPROVAL_INTENT,
  ARTIFACT_ROLES,
  COMMITMENT_DOMAIN,
  LIMITS,
  OPENING_SCHEMA,
  PACKAGE_DOMAIN,
  PACKAGE_SCHEMA,
  REFERENCE_SCHEMA,
} from './constants';
import { PROTOCOL_ERROR_CODES } from './errors';
import { VERIFICATION_ISSUE_CODES } from './verify';

/**
 * Compact machine-readable description of protocol v1. Every value is derived from the constants
 * the implementation actually uses, so the published descriptor cannot drift from the code.
 */
export const PROTOCOL_DESCRIPTOR_V1 = deepFreeze({
  descriptor: 'lexaegis.protocol-descriptor.v1',
  protocolVersion: '1',
  schemas: {
    reviewPackage: PACKAGE_SCHEMA,
    receiptReference: REFERENCE_SCHEMA,
    commitmentOpening: OPENING_SCHEMA,
  },
  domains: {
    package: PACKAGE_DOMAIN,
    commitment: COMMITMENT_DOMAIN,
    separatorByte: '0x00',
  },
  algorithms: {
    artifactDigest: 'SHA-256',
    packageDigest: 'SHA-256',
    commitment: 'SHA-256',
    canonicalization: 'RFC 8785 JSON Canonicalization Scheme (JCS)',
    blindingNonce: 'cryptographically secure random, 32 bytes',
  },
  formulas: {
    artifactDigest: 'SHA256(originalArtifactBytes)',
    canonicalBytes: 'UTF8(JCS(validatedManifest))',
    packageDigest: 'SHA256(UTF8(domains.package) || BYTE(0x00) || canonicalBytes)',
    commitment:
      'SHA256(UTF8(domains.commitment) || BYTE(0x00) || blindingNonceBytes32 || packageDigestBytes32)',
  },
  encodings: {
    concatenation: 'raw bytes; hexadecimal text is never hashed',
    text: 'UTF-8 without byte-order mark; no Unicode normalization',
    propertyOrder: 'recursive, by UTF-16 code unit; array order preserved',
    digest: 'lowercase 0x-prefixed hexadecimal, 32 bytes',
    blindingNonce: 'lowercase 0x-prefixed hexadecimal, 32 bytes',
    address: 'lowercase 0x-prefixed hexadecimal, 20 bytes; zero address rejected',
    integer: 'canonical unsigned decimal string; JSON numbers are not used',
    timestamp: 'YYYY-MM-DDTHH:mm:ss.sssZ, valid UTC, millisecond precision',
    identifier: 'lowercase UUIDv4',
    mediaType: 'lowercase type/subtype without parameters',
    labelLength: 'Unicode code points',
  },
  limits: { ...LIMITS },
  artifactRoles: [...ARTIFACT_ROLES],
  approvalIntent: APPROVAL_INTENT,
  disclosure: {
    public: ['ReceiptReferenceV1'],
    private: ['ReviewPackageV1', 'CommitmentOpeningV1', 'ArtifactRefV1', 'packageDigest'],
  },
  errorCodes: [...PROTOCOL_ERROR_CODES],
  verificationIssueCodes: [...VERIFICATION_ISSUE_CODES],
  compatibility: [
    'Storage location and ciphertext changes do not alter a commitment when the recovered plaintext bytes and the opening are identical.',
    'Any alteration of committed metadata or artifact bytes changes the committed package.',
    'A change to hashing or the wire format requires a new protocol version.',
    'Unknown versions and unknown fields are rejected, never stripped or reinterpreted.',
    'Chain authorization and replay protection are outside this hash construction.',
    'V1 verification discloses the full package; redacted bytes are a different package.',
  ],
});

export type ProtocolDescriptorV1 = typeof PROTOCOL_DESCRIPTOR_V1;
