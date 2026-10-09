/*
 * Fixed v1 registry values. They mirror contracts/src exactly; changing any of them requires a
 * new protocol version and a new registry deployment.
 */

/** Value returned by `protocolVersion()`. */
export const REGISTRY_PROTOCOL_VERSION = '1';

export const EIP712_DOMAIN_NAME = 'LexAegisProofOfReview';
export const EIP712_DOMAIN_VERSION = '1';

export const EIP712_DOMAIN_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const;

export const REVIEW_ACTION_PRIMARY_TYPE = 'ReviewAction';

/** Field order is part of the signed encoding. */
export const REVIEW_ACTION_FIELDS = [
  { name: 'reviewer', type: 'address' },
  { name: 'action', type: 'uint8' },
  { name: 'commitment', type: 'bytes32' },
  { name: 'replacementCommitment', type: 'bytes32' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
] as const;

export const REVIEW_ACTION_TYPE_STRING =
  'ReviewAction(address reviewer,uint8 action,bytes32 commitment,bytes32 replacementCommitment,uint256 nonce,uint256 deadline)';

export const REVIEW_ACTION_CODES = Object.freeze({ ISSUE: 0, REVOKE: 1, SUPERSEDE: 2 } as const);
export type ReviewActionCode = (typeof REVIEW_ACTION_CODES)[keyof typeof REVIEW_ACTION_CODES];

/** `ReceiptStatus` in contract order: the array index is the on-chain enum value. */
export const RECEIPT_STATUS_ORDER = ['not_found', 'active', 'revoked', 'superseded'] as const;
export type ObservedReceiptLifecycle = (typeof RECEIPT_STATUS_ORDER)[number];

/** Reserved value: an absent predecessor or successor, and an unused replacement field. */
export const ZERO_BYTES32 = `0x${'00'.repeat(32)}`;

export const UINT256_MAX = 2n ** 256n - 1n;

/**
 * Reference-application default: sign an action to expire this many seconds after the current
 * Unix time. It is only a default for later UI integration; the registry enforces whatever
 * deadline was actually signed.
 */
export const DEFAULT_ACTION_VALIDITY_SECONDS = 600n;

/**
 * One SUPERSEDE emits exactly these two logs, in this order, in one transaction and with the
 * same nonce. Together they describe a single atomic action: an indexer must record the
 * replacement receipt once, from ReceiptIssued, and use ReceiptSuperseded only to link the pair.
 */
export const SUPERSESSION_EVENT_ORDER = ['ReceiptIssued', 'ReceiptSuperseded'] as const;
