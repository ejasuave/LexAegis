import type { Hex } from 'viem';
import type { PreparedReviewPackage, ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import type { VerificationReportV1 } from '@lexaegis/sdk/offline';
import {
  buildIssueAction,
  buildSupersedeAction,
  buildTypedData,
  defaultActionDeadline,
  toEip712ReviewAction,
  type BoundReviewAction,
  type Eip712ReviewAction,
} from '@lexaegis/sdk/registry';
import {
  DEFAULT_MAX_REGISTRY_FEE_WEI,
  checkFees,
  encodeExecuteCalldata,
  registryGasLimit,
} from '@lexaegis/sdk/transactions';
import { verifyReceipt, type LiveOptions } from '@lexaegis/sdk/verify';

/*
 * Issue and supersede through the SDK, with a signer YOU supply. Nothing here holds a key, unlocks
 * an account or approves anything on its own:
 *   - preparing is not approving: the snapshot is unapproved and immutable;
 *   - the opening is stored BEFORE anything is published, and reused for every retry;
 *   - signing is not confirmation, and sending needs an explicit `approve` answer;
 *   - success is never inferred from a transaction hash: it is read back from the registry through
 *     the SDK, and a Superseded predecessor is never reactivated.
 * Reading, signing and sending are injected so any wallet, hardware signer or node can be used.
 */

/** The caller's signer: a viem LocalAccount, a wallet client's account or any adapter with this shape. */
export interface ReviewSigner {
  readonly address: string;
  signTypedData(typedData: Eip712ReviewAction): Promise<Hex>;
}

/** Fee fields the caller's node quoted for one registry transaction. */
export interface FeeQuote {
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

/** Everything that touches the chain. Implement it with viem clients, another library or a test double. */
export interface ChainAccess {
  /** The reviewer's registry action counter (not an account transaction nonce). */
  readNonce(reviewer: string): Promise<string>;
  /** The chain's current time in Unix seconds, from the latest block. */
  chainTime(): Promise<string>;
  /** The node's own estimate and prices for sending this calldata to the registry. */
  quote(calldata: Hex): Promise<FeeQuote>;
  /** Broadcasts. The sender is an executor that pays the fee and has no authority over the receipt. */
  send(calldata: Hex, quote: FeeQuote): Promise<Hex>;
  /** Waits for inclusion and reports the transaction's own outcome. */
  waitForExecution(hash: Hex): Promise<'success' | 'reverted'>;
  /** The caller-trusted registry deployment and an RPC transport for verified reads. */
  readonly live: LiveOptions;
  /**
   * Waits between confirmation reads. Defaults to a real timer. A verified read lags the chain by
   * the finalization delay, so a freshly mined transaction is not visible at once; a local test
   * chain can mine blocks here instead of sleeping.
   */
  pause?(milliseconds: number): Promise<void>;
}

const CONFIRMATION_ATTEMPTS = 30;
const CONFIRMATION_PAUSE_MS = 2_000;

/**
 * Repeats a verified read, a bounded number of times, until it shows the expected state. Mining is
 * not confirming: success is only what the registry shows at a verified checkpoint.
 */
async function untilVerified<T>(
  chain: ChainAccess,
  read: () => Promise<T>,
  expected: (value: T) => boolean,
): Promise<T> {
  const pause = (ms: number): Promise<void> =>
    chain.pause === undefined
      ? new Promise<void>((resolve) => setTimeout(resolve, ms))
      : chain.pause(ms);
  let latest = await read();
  for (let attempt = 1; attempt < CONFIRMATION_ATTEMPTS && !expected(latest); attempt += 1) {
    await pause(CONFIRMATION_PAUSE_MS);
    latest = await read();
  }
  return latest;
}

/** Where the private opening is kept. It must succeed before anything is published. */
export interface OpeningStore {
  save(prepared: PreparedReviewPackage): Promise<void>;
}

/** What a human or policy is asked to approve. It names the exact action and the fee ceiling. */
export interface SubmissionSummary {
  readonly action: 'ISSUE' | 'SUPERSEDE';
  readonly chainId: string;
  readonly registryAddress: string;
  readonly reviewerAddress: string;
  readonly commitment: string;
  readonly replacementCommitment: string | null;
  readonly registryNonce: string;
  readonly deadline: string;
  readonly maxFeeWei: bigint;
}

export type LifecycleFailure =
  | 'OPENING_NOT_STORED'
  | 'CHAIN_NOT_VERIFIED'
  | 'PRECONDITION_NOT_MET'
  | 'ACTION_INVALID'
  | 'FEE_CHECK_FAILED'
  | 'SIGNER_MISMATCH'
  | 'SIGNING_FAILED'
  | 'SUBMISSION_FAILED';

export type LifecycleResult =
  /** The registry now shows the expected state, read back through the SDK. */
  | {
      readonly status: 'confirmed';
      readonly transactionHash: Hex;
      readonly reports: readonly VerificationReportV1[];
    }
  /** Approval was refused. Nothing was sent. */
  | { readonly status: 'declined' }
  /** The registry already shows this commitment: nothing was sent (a retry must not duplicate). */
  | {
      readonly status: 'already_recorded';
      readonly chainStatus: VerificationReportV1['chainStatus'];
    }
  | { readonly status: 'reverted'; readonly transactionHash: Hex }
  /** The transaction succeeded but the registry did not show the expected state. Not confirmed. */
  | {
      readonly status: 'unconfirmed';
      readonly transactionHash: Hex;
      readonly reports: readonly VerificationReportV1[];
    }
  | { readonly status: 'failed'; readonly code: LifecycleFailure };

export interface LifecycleInput {
  readonly signer: ReviewSigner;
  readonly chain: ChainAccess;
  readonly store: OpeningStore;
  /** Required and never defaulted: nothing is sent unless this resolves to true. */
  readonly approve: (summary: SubmissionSummary) => Promise<boolean>;
  readonly now?: () => Date;
}

async function read(
  chain: ChainAccess,
  prepared: PreparedReviewPackage,
  options: { inspectSuccessors?: boolean; now?: () => Date } = {},
): Promise<VerificationReportV1 | null> {
  const result = await verifyReceipt({
    mode: 'full-package',
    expectedReference: prepared.reference,
    referenceOrigin: 'independent',
    opening: prepared.opening,
    artifacts: prepared.artifacts(),
    live: { ...chain.live, ...(options.inspectSuccessors === true && { inspectSuccessors: true }) },
    ...(options.now !== undefined && { now: options.now }),
  });
  return result.ok ? result.data.report : null;
}

/** Reads a status by reference alone, for the predecessor (whose files the caller may not hold). */
async function readReference(
  chain: ChainAccess,
  reference: ReceiptReferenceV1,
  now?: () => Date,
): Promise<VerificationReportV1 | null> {
  const result = await verifyReceipt({
    mode: 'reference-only',
    expectedReference: reference,
    referenceOrigin: 'independent',
    live: chain.live,
    ...(now !== undefined && { now }),
  });
  return result.ok ? result.data.report : null;
}

async function submit(
  input: LifecycleInput,
  bound: BoundReviewAction,
  summaryBase: Pick<SubmissionSummary, 'action' | 'replacementCommitment'>,
): Promise<{ readonly hash: Hex } | LifecycleResult> {
  const { signer, chain } = input;
  const typedData = buildTypedData(bound, bound.chainId, bound.registryAddress);
  if (!typedData.ok) return { status: 'failed', code: 'ACTION_INVALID' };
  const eip712 = toEip712ReviewAction(typedData.data);
  if (!eip712.ok) return { status: 'failed', code: 'ACTION_INVALID' };
  // The signature is made now but nothing is broadcast until the approval below.
  let signature: Hex;
  try {
    signature = await signer.signTypedData(eip712.data);
  } catch {
    return { status: 'failed', code: 'SIGNING_FAILED' };
  }
  const calldata = encodeExecuteCalldata(bound.action, signature);
  if (calldata === null) return { status: 'failed', code: 'ACTION_INVALID' };

  const quote = await chain.quote(calldata);
  const limit = registryGasLimit(quote.gasLimit);
  if (!limit.ok) return { status: 'failed', code: 'FEE_CHECK_FAILED' };
  const fees = checkFees({ ...quote, gasLimit: limit.gasLimit }, DEFAULT_MAX_REGISTRY_FEE_WEI);
  if (!fees.ok) return { status: 'failed', code: 'FEE_CHECK_FAILED' };

  const approved = await input.approve({
    ...summaryBase,
    chainId: bound.chainId,
    registryAddress: bound.registryAddress,
    reviewerAddress: bound.action.reviewer,
    commitment: bound.action.commitment,
    registryNonce: bound.action.nonce,
    deadline: bound.action.deadline,
    maxFeeWei: fees.maxFeeWei,
  });
  if (!approved) return { status: 'declined' };
  try {
    return { hash: await chain.send(calldata, { ...quote, gasLimit: limit.gasLimit }) };
  } catch {
    return { status: 'failed', code: 'SUBMISSION_FAILED' };
  }
}

const isResult = (value: { readonly hash: Hex } | LifecycleResult): value is LifecycleResult =>
  'status' in value;

/**
 * ISSUE: stores the opening, confirms the registry has no record yet, signs, asks for approval,
 * sends, and reads the receipt back. Safe to call again after a lost response: an existing record
 * is reported as `already_recorded` and nothing is sent twice.
 */
export async function issueReview(
  prepared: PreparedReviewPackage,
  input: LifecycleInput,
): Promise<LifecycleResult> {
  const { signer, chain } = input;
  if (signer.address.toLowerCase() !== prepared.reference.reviewerAddress) {
    return { status: 'failed', code: 'SIGNER_MISMATCH' };
  }
  try {
    await input.store.save(prepared);
  } catch {
    return { status: 'failed', code: 'OPENING_NOT_STORED' };
  }

  // Reconcile first: a verified read, never a guess from a missing receipt or a transaction hash.
  const before = await read(chain, prepared, input);
  if (before === null || before.registryIdentity !== 'match') {
    return { status: 'failed', code: 'CHAIN_NOT_VERIFIED' };
  }
  if (before.chainStatus !== 'not_found') {
    return before.chainStatus === 'unknown'
      ? { status: 'failed', code: 'CHAIN_NOT_VERIFIED' }
      : { status: 'already_recorded', chainStatus: before.chainStatus };
  }

  const nonce = await chain.readNonce(prepared.reference.reviewerAddress);
  const deadline = defaultActionDeadline(await chain.chainTime());
  if (!deadline.ok) return { status: 'failed', code: 'ACTION_INVALID' };
  const bound = buildIssueAction(prepared, nonce, deadline.data);
  if (!bound.ok) return { status: 'failed', code: 'ACTION_INVALID' };

  const sent = await submit(input, bound.data, { action: 'ISSUE', replacementCommitment: null });
  if (isResult(sent)) return sent;
  if ((await chain.waitForExecution(sent.hash)) === 'reverted') {
    return { status: 'reverted', transactionHash: sent.hash };
  }
  const isActive = (report: VerificationReportV1 | null): boolean =>
    report !== null && report.chainStatus === 'active' && report.receiptBinding === 'match';
  const after = await untilVerified(chain, () => read(chain, prepared, input), isActive);
  return after !== null && isActive(after)
    ? { status: 'confirmed', transactionHash: sent.hash, reports: [after] }
    : { status: 'unconfirmed', transactionHash: sent.hash, reports: after === null ? [] : [after] };
}

/**
 * SUPERSEDE: `replacement` must have been prepared with `previous` as its predecessor and with
 * actual revised source bytes and a fresh opening. Confirms the predecessor is Active and the
 * replacement unknown to the registry, then signs, asks, sends and reads BOTH back: the predecessor
 * must be Superseded and the replacement Active. A revoked successor never reactivates the
 * predecessor, and nothing here ever tries to.
 */
export async function supersedeReview(
  previous: ReceiptReferenceV1,
  replacement: PreparedReviewPackage,
  input: LifecycleInput,
): Promise<LifecycleResult> {
  const { signer, chain } = input;
  if (signer.address.toLowerCase() !== previous.reviewerAddress) {
    return { status: 'failed', code: 'SIGNER_MISMATCH' };
  }
  try {
    await input.store.save(replacement);
  } catch {
    return { status: 'failed', code: 'OPENING_NOT_STORED' };
  }

  const priorState = await readReference(chain, previous, input.now);
  if (
    priorState === null ||
    priorState.registryIdentity !== 'match' ||
    priorState.chainStatus === 'unknown'
  ) {
    return { status: 'failed', code: 'CHAIN_NOT_VERIFIED' };
  }
  if (priorState.chainStatus !== 'active')
    return { status: 'failed', code: 'PRECONDITION_NOT_MET' };
  const replacementState = await read(chain, replacement, input);
  if (replacementState === null || replacementState.registryIdentity !== 'match') {
    return { status: 'failed', code: 'CHAIN_NOT_VERIFIED' };
  }
  if (replacementState.chainStatus !== 'not_found') {
    return replacementState.chainStatus === 'unknown'
      ? { status: 'failed', code: 'CHAIN_NOT_VERIFIED' }
      : { status: 'already_recorded', chainStatus: replacementState.chainStatus };
  }

  const nonce = await chain.readNonce(previous.reviewerAddress);
  const deadline = defaultActionDeadline(await chain.chainTime());
  if (!deadline.ok) return { status: 'failed', code: 'ACTION_INVALID' };
  const bound = buildSupersedeAction(previous, replacement, nonce, deadline.data);
  if (!bound.ok) return { status: 'failed', code: 'ACTION_INVALID' };

  const sent = await submit(input, bound.data, {
    action: 'SUPERSEDE',
    replacementCommitment: replacement.reference.commitment,
  });
  if (isResult(sent)) return sent;
  if ((await chain.waitForExecution(sent.hash)) === 'reverted') {
    return { status: 'reverted', transactionHash: sent.hash };
  }
  const state = await untilVerified(
    chain,
    async () => ({
      original: await readReference(chain, previous, input.now),
      revised: await read(chain, replacement, input),
    }),
    ({ original, revised }) =>
      original?.chainStatus === 'superseded' && revised?.chainStatus === 'active',
  );
  const { original, revised } = state;
  const reports = [original, revised].filter(
    (report): report is VerificationReportV1 => report !== null,
  );
  return original?.chainStatus === 'superseded' &&
    revised?.chainStatus === 'active' &&
    revised.receiptBinding === 'match'
    ? { status: 'confirmed', transactionHash: sent.hash, reports }
    : { status: 'unconfirmed', transactionHash: sent.hash, reports };
}
