import {
  PreparedReviewPackage,
  parseReceiptReference,
  type ReceiptReferenceV1,
} from '@lexaegis/protocol/v1';
import { DEFAULT_ACTION_VALIDITY_SECONDS, REVIEW_ACTION_CODES, ZERO_BYTES32 } from './constants';
import { failWith, succeed, type RegistryResult } from './errors';
import {
  freezeResult,
  positiveUint256DecimalSchema,
  uint256DecimalSchema,
  type BoundReviewAction,
} from './typed-data';

/*
 * Pure builders for the three registry actions. Reviewer, chain, registry and commitments are
 * taken only from an immutable PreparedReviewPackage or a validated receipt reference; package
 * contents are never rebuilt from mutable state and no blinding nonce is ever regenerated.
 *
 * The registry nonce and the deadline are always supplied by the caller. Nothing here reads
 * chain state, guesses or increments a nonce, re-signs, signs, broadcasts or approves.
 */

interface Authorization {
  readonly nonce: string;
  readonly deadline: string;
}

function readAuthorization(nonce: unknown, deadline: unknown): RegistryResult<Authorization> {
  const parsedNonce = uint256DecimalSchema.safeParse(nonce);
  if (!parsedNonce.success) return failWith('NONCE_INVALID');
  const parsedDeadline = positiveUint256DecimalSchema.safeParse(deadline);
  if (!parsedDeadline.success) return failWith('DEADLINE_INVALID');
  return succeed({ nonce: parsedNonce.data, deadline: parsedDeadline.data });
}

function readReference(input: unknown): RegistryResult<ReceiptReferenceV1> {
  const parsed = parseReceiptReference(input);
  if (parsed.ok) return succeed(parsed.data);
  return failWith(
    parsed.error.code === 'UNSUPPORTED_VERSION' ? 'UNSUPPORTED_VERSION' : 'REFERENCE_INVALID',
    parsed.error.path?.split('.'),
  );
}

/** Both arguments have already passed the v1 reference schema. */
function sameReceipt(a: ReceiptReferenceV1, b: ReceiptReferenceV1): boolean {
  return (
    a.chainId === b.chainId &&
    a.registryAddress === b.registryAddress &&
    a.reviewerAddress === b.reviewerAddress &&
    a.commitment === b.commitment
  );
}

function bind(
  reference: ReceiptReferenceV1,
  action: 0 | 1 | 2,
  commitment: string,
  replacementCommitment: string,
  authorization: Authorization,
): RegistryResult<BoundReviewAction> {
  return freezeResult({
    chainId: reference.chainId,
    registryAddress: reference.registryAddress,
    action: {
      reviewer: reference.reviewerAddress,
      action,
      commitment,
      replacementCommitment,
      nonce: authorization.nonce,
      deadline: authorization.deadline,
    },
  });
}

/**
 * ISSUE for a prepared snapshot that replaces nothing. A package whose manifest names a
 * predecessor must go through buildSupersedeAction instead.
 */
export function buildIssueAction(
  preparedSnapshot: unknown,
  nonce: unknown,
  deadline: unknown,
): RegistryResult<BoundReviewAction> {
  if (!PreparedReviewPackage.isPrepared(preparedSnapshot)) return failWith('SNAPSHOT_INVALID');
  const authorization = readAuthorization(nonce, deadline);
  if (!authorization.ok) return authorization;

  const { reference, opening } = preparedSnapshot;
  if (opening.manifest.supersedes !== null) return failWith('SUPERSEDES_UNEXPECTED');
  if (reference.commitment === ZERO_BYTES32) return failWith('ZERO_COMMITMENT');
  return bind(
    reference,
    REVIEW_ACTION_CODES.ISSUE,
    reference.commitment,
    ZERO_BYTES32,
    authorization.data,
  );
}

/** REVOKE for the receipt identified by a public reference. */
export function buildRevokeAction(
  receiptReference: unknown,
  nonce: unknown,
  deadline: unknown,
): RegistryResult<BoundReviewAction> {
  const reference = readReference(receiptReference);
  if (!reference.ok) return reference;
  const authorization = readAuthorization(nonce, deadline);
  if (!authorization.ok) return authorization;

  if (reference.data.commitment === ZERO_BYTES32) return failWith('ZERO_COMMITMENT');
  return bind(
    reference.data,
    REVIEW_ACTION_CODES.REVOKE,
    reference.data.commitment,
    ZERO_BYTES32,
    authorization.data,
  );
}

/**
 * SUPERSEDE: replaces `previousReference` with the prepared snapshot. The snapshot's manifest
 * must itself name exactly that predecessor, so the replacement was prepared as a replacement,
 * and both must share one reviewer, chain and registry.
 */
export function buildSupersedeAction(
  previousReference: unknown,
  preparedSnapshot: unknown,
  nonce: unknown,
  deadline: unknown,
): RegistryResult<BoundReviewAction> {
  const previous = readReference(previousReference);
  if (!previous.ok) return previous;
  if (!PreparedReviewPackage.isPrepared(preparedSnapshot)) return failWith('SNAPSHOT_INVALID');
  const authorization = readAuthorization(nonce, deadline);
  if (!authorization.ok) return authorization;

  const { reference, opening } = preparedSnapshot;
  const declared = opening.manifest.supersedes;
  if (declared === null) return failWith('SUPERSEDES_REQUIRED');
  if (!sameReceipt(declared, previous.data)) return failWith('SUPERSEDES_MISMATCH');
  if (
    reference.chainId !== previous.data.chainId ||
    reference.registryAddress !== previous.data.registryAddress ||
    reference.reviewerAddress !== previous.data.reviewerAddress
  ) {
    return failWith('CONTEXT_MISMATCH');
  }
  if (previous.data.commitment === ZERO_BYTES32 || reference.commitment === ZERO_BYTES32) {
    return failWith('ZERO_COMMITMENT');
  }
  if (reference.commitment === previous.data.commitment) {
    return failWith('REPLACEMENT_EQUALS_PREVIOUS');
  }
  return bind(
    reference,
    REVIEW_ACTION_CODES.SUPERSEDE,
    previous.data.commitment,
    reference.commitment,
    authorization.data,
  );
}

/**
 * The reference-application default deadline: the supplied current Unix time in seconds plus
 * 600. The current time is an explicit argument so this stays pure.
 */
export function defaultActionDeadline(nowUnixSeconds: unknown): RegistryResult<string> {
  const now = uint256DecimalSchema.safeParse(nowUnixSeconds);
  if (!now.success) return failWith('DEADLINE_INVALID');
  const deadline = positiveUint256DecimalSchema.safeParse(
    (BigInt(now.data) + DEFAULT_ACTION_VALIDITY_SECONDS).toString(),
  );
  return deadline.success ? succeed(deadline.data) : failWith('DEADLINE_INVALID');
}
