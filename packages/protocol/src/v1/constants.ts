/** Immutable v1 protocol identifiers. Changing any of these requires a new protocol version. */
export const PACKAGE_SCHEMA = 'lexaegis.review-package.v1';
export const REFERENCE_SCHEMA = 'lexaegis.receipt-ref.v1';
export const OPENING_SCHEMA = 'lexaegis.opening.v1';

/** Domain separators. They are hashed as UTF-8 bytes followed by one 0x00 byte. */
export const PACKAGE_DOMAIN = 'lexaegis:review-package:v1';
export const COMMITMENT_DOMAIN = 'lexaegis:review-commitment:v1';

export const APPROVAL_INTENT = 'approve-review-package';

export const ARTIFACT_ROLES = [
  'source',
  'extracted-text',
  'evidence',
  'analysis',
  'calculation',
  'rule-pack',
  'checklist',
  'agent-config',
  'decision-log',
] as const;

const MIB = 1024 * 1024;

/** Shared limits. Content is never truncated to fit; exceeding a limit is a typed error. */
export const LIMITS = Object.freeze({
  /** Manifest or opening JSON input, in bytes. */
  maxJsonBytes: MIB,
  /** Maximum container nesting depth (the root object is depth 1). */
  maxDepth: 32,
  maxArtifacts: 128,
  maxArtifactBytes: 10 * MIB,
  maxTotalArtifactBytes: 32 * MIB,
  /** Label length in Unicode code points. */
  maxLabelCodePoints: 256,
  maxMediaTypeLength: 127,
  maxProfileIdLength: 80,
  digestBytes: 32,
  blindingNonceBytes: 32,
});
