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
 *
 * @example
 * ```ts
 * import { buildIssueAction } from '@lexaegis/sdk/registry';
 * import type { PreparedReviewPackage } from '@lexaegis/sdk';
 *
 * declare const prepared: PreparedReviewPackage; // an unapproved, immutable snapshot
 * const action = buildIssueAction(prepared, '0', '1800000600'); // reviewer nonce, Unix-seconds deadline
 * if (!action.ok) console.error(action.error.code); // nothing is signed or sent
 * ```
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

/**
 * REVOKE for the receipt identified by a public reference.
 *
 * @example
 * ```ts
 * import { buildRevokeAction } from '@lexaegis/sdk/registry';
 * import type { ReceiptReferenceV1 } from '@lexaegis/sdk';
 *
 * declare const reference: ReceiptReferenceV1;
 * const action = buildRevokeAction(reference, '1', '1800000600');
 * ```
 */
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
 *
 * @example
 * ```ts
 * import { buildSupersedeAction } from '@lexaegis/sdk/registry';
 * import type { PreparedReviewPackage, ReceiptReferenceV1 } from '@lexaegis/sdk';
 *
 * declare const previous: ReceiptReferenceV1;
 * declare const replacement: PreparedReviewPackage; // its manifest names `previous` as its predecessor
 * const action = buildSupersedeAction(previous, replacement, '1', '1800000600');
 * ```
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
 *
 * @example
 * ```ts
 * import { defaultActionDeadline } from '@lexaegis/sdk/registry';
 *
 * const deadline = defaultActionDeadline('1800000000'); // current chain time in Unix seconds
 * console.log(deadline.ok ? deadline.data : deadline.error.code); // "1800000600"
 * ```
 */
export function defaultActionDeadline(nowUnixSeconds: unknown): RegistryResult<string> {
  const now = uint256DecimalSchema.safeParse(nowUnixSeconds);
  if (!now.success) return failWith('DEADLINE_INVALID');
  const deadline = positiveUint256DecimalSchema.safeParse(
    (BigInt(now.data) + DEFAULT_ACTION_VALIDITY_SECONDS).toString(),
  );
  return deadline.success ? succeed(deadline.data) : failWith('DEADLINE_INVALID');
}
