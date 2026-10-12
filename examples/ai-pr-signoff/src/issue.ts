import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from 'viem';
import type { ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import type { VerificationReportV1 } from '@lexaegis/sdk/offline';
import {
  REVIEW_ACTION_CODES,
  ZERO_BYTES32,
  boundReviewActionSchema,
  buildTypedData,
  defaultActionDeadline,
  toEip712ReviewAction,
  type BoundReviewAction,
  type Eip712ReviewAction,
} from '@lexaegis/sdk/registry';
import {
  DEFAULT_MAX_REGISTRY_FEE_WEI,
  REGISTRY_GAS_LIMIT_CEILING,
  checkFees,
  decodeSignedRegistryTransaction,
  encodeExecuteCalldata,
} from '@lexaegis/sdk/transactions';
import { verifyReceipt } from '@lexaegis/sdk/verify';
import type { ChainAccess, TransactionState } from './chain.js';
import type { EvidenceStore, SavedEvidence, StorageFailure } from './storage.js';

/*
 * The explicit issue workflow. Nothing here runs unless a caller invokes it, and it sends nothing
 * unless BOTH confirmations return true:
 *   1. the exact snapshot (files, reference, profile, reviewer, chain, registry, action, nonce,
 *      deadline, zero value) before anything is signed, and
 *   2. the fee ceiling and transaction before it is broadcast.
 * A decision file or a --broadcast flag is not human approval; the CLI's confirmations are typed by
 * a person at a terminal. Success is only what the registry shows at a verified checkpoint.
 */

export interface ReviewSigner {
  readonly address: string;
  signTypedData(typedData: Eip712ReviewAction): Promise<Hex>;
}

export interface SignoffPreview {
  readonly files: readonly {
    readonly label: string | null;
    readonly role: string;
    readonly mediaType: string;
    readonly byteLength: string;
  }[];
  readonly reference: ReceiptReferenceV1;
  readonly profile: { readonly id: string; readonly version: string };
  readonly reviewerAddress: string;
  readonly action: 'ISSUE';
  readonly registryNonce: string;
  readonly deadline: string;
  readonly valueWei: '0';
}

export interface SendSummary extends SignoffPreview {
  readonly maxFeeWei: bigint;
  readonly transactionHash: Hex;
}

export interface Confirmations {
  snapshot(preview: SignoffPreview): Promise<boolean>;
  send(summary: SendSummary): Promise<boolean>;
}

/** Public data only: no opening, no signature, no raw transaction. */
export interface PendingEntry {
  readonly schema: 'lexaegis.example.signoff-pending.v1';
  readonly commitment: string;
  readonly transactionHash: string;
  readonly chainId: string;
  readonly registryAddress: string;
  readonly deadline: string;
  readonly recordedAt: string;
}

export interface PendingLog {
  record(entry: PendingEntry): Promise<void>;
  find(commitment: string): Promise<PendingEntry | null>;
}

export function createFilePendingLog(directory: string): PendingLog {
  return {
    record(entry) {
      mkdirSync(directory, { recursive: true });
      const target = join(directory, `${entry.commitment.slice(2)}.json`);
      const temporary = `${target}.${String(process.pid)}.tmp`;
      writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600 });
      renameSync(temporary, target);
      return Promise.resolve();
    },
    find(commitment) {
      try {
        return Promise.resolve(
          JSON.parse(
            readFileSync(join(directory, `${commitment.slice(2)}.json`), 'utf8'),
          ) as PendingEntry,
        );
      } catch {
        return Promise.resolve(null);
      }
    },
  };
}

export type IssueFailure =
  | 'SIGNER_MISMATCH'
  | `EVIDENCE_NOT_PRESERVED:${StorageFailure}`
  | 'CHAIN_NOT_VERIFIED'
  | 'ACTION_INVALID'
  | 'SIGNING_FAILED'
  | 'TRANSACTION_SCOPE_REJECTED'
  | 'FEE_CHECK_FAILED'
  | 'PENDING_RECORD_FAILED';

export type IssueResult =
  | {
      readonly status: 'confirmed';
      readonly transactionHash: Hex;
      readonly report: VerificationReportV1;
    }
  | { readonly status: 'declined'; readonly stage: 'snapshot' | 'send' }
  | {
      readonly status: 'already_recorded';
      readonly chainStatus: VerificationReportV1['chainStatus'];
    }
  | { readonly status: 'reverted'; readonly transactionHash: Hex }
  | {
      readonly status: 'unconfirmed';
      readonly transactionHash: Hex;
      readonly report: VerificationReportV1 | null;
    }
  /** The transaction's fate is not established. Do not make a new action; reconcile this hash. */
  | { readonly status: 'unresolved'; readonly transactionHash: Hex }
  | { readonly status: 'failed'; readonly code: IssueFailure };

export interface IssueInput {
  /** The independently retained reference of the package saved by `prepare`. */
  readonly reference: ReceiptReferenceV1;
  readonly signer: ReviewSigner;
  readonly chain: ChainAccess;
  readonly store: EvidenceStore;
  readonly pending: PendingLog;
  readonly confirm: Confirmations;
  readonly now?: () => Date;
}

const READ_ATTEMPTS = 30;
const READ_PAUSE_MS = 2_000;

const sleep = (chain: ChainAccess, ms: number): Promise<void> =>
  chain.pause === undefined ? new Promise((resolve) => setTimeout(resolve, ms)) : chain.pause(ms);

async function untilTrue<T>(
  chain: ChainAccess,
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  let value = await read();
  for (let attempt = 1; attempt < READ_ATTEMPTS && !done(value); attempt += 1) {
    await sleep(chain, READ_PAUSE_MS);
    value = await read();
  }
  return value;
}

/** A verified read of the preserved package: bytes from the encrypted copy, reference from the caller. */
export async function readPreserved(
  chain: ChainAccess,
  reference: ReceiptReferenceV1,
  evidence: SavedEvidence,
  now?: () => Date,
): Promise<VerificationReportV1 | null> {
  const result = await verifyReceipt({
    mode: 'full-package',
    expectedReference: reference,
    referenceOrigin: 'independent',
    opening: evidence.opening,
    artifacts: evidence.artifacts,
    live: chain.live,
    ...(now !== undefined && { now }),
  });
  return result.ok ? result.data.report : null;
}

const isActive = (report: VerificationReportV1 | null): report is VerificationReportV1 =>
  report !== null && report.chainStatus === 'active' && report.receiptBinding === 'match';

/**
 * The ISSUE action for a saved package, built from its verified reference. A PreparedReviewPackage
 * cannot be rebuilt from a stored opening (its nonce is generated once, at preparation), so the
 * action is bound through the SDK's own closed schema; a test proves it equals `buildIssueAction`.
 */
export function bindIssue(
  reference: ReceiptReferenceV1,
  nonce: string,
  deadline: string,
): BoundReviewAction | null {
  const parsed = boundReviewActionSchema.safeParse({
    chainId: reference.chainId,
    registryAddress: reference.registryAddress,
    action: {
      reviewer: reference.reviewerAddress,
      action: REVIEW_ACTION_CODES.ISSUE,
      commitment: reference.commitment,
      replacementCommitment: ZERO_BYTES32,
      nonce,
      deadline,
    },
  });
  return parsed.success && reference.commitment !== ZERO_BYTES32 ? parsed.data : null;
}

export async function issueSignoff(input: IssueInput): Promise<IssueResult> {
  const { reference, signer, chain } = input;
  if (signer.address.toLowerCase() !== reference.reviewerAddress)
    return { status: 'failed', code: 'SIGNER_MISMATCH' };

  // 1. The encrypted opening and files were preserved by `prepare`; read them back and check the
  //    ORIGINAL reference before anything is signed or published.
  const saved = await input.store.load(reference);
  if (!saved.ok) return { status: 'failed', code: `EVIDENCE_NOT_PRESERVED:${saved.code}` };
  const evidence = saved.data;

  // 2. Reconcile first: a verified registry read and any earlier transaction of THIS commitment.
  const before = await readPreserved(chain, reference, evidence, input.now);
  if (before === null || before.registryIdentity !== 'match')
    return { status: 'failed', code: 'CHAIN_NOT_VERIFIED' };
  if (before.chainStatus === 'unknown') return { status: 'failed', code: 'CHAIN_NOT_VERIFIED' };
  if (before.chainStatus !== 'not_found')
    return { status: 'already_recorded', chainStatus: before.chainStatus };
  const earlier = await input.pending.find(reference.commitment);
  if (earlier !== null) {
    const hash = earlier.transactionHash as Hex;
    const state = await chain.transactionState(hash);
    if (state === 'pending') return { status: 'unresolved', transactionHash: hash };
    if (state === 'success') return confirm(input, evidence, hash);
    if (state === 'reverted') return { status: 'reverted', transactionHash: hash };
    // Unknown: only an expired action can no longer execute. Until then it may still be in flight.
    if (BigInt(await chain.chainTime()) <= BigInt(earlier.deadline))
      return { status: 'unresolved', transactionHash: hash };
  }

  // 3. Build the exact action, from the registry's own counter and chain time.
  const nonce = await chain.readNonce(reference.reviewerAddress);
  const deadline = defaultActionDeadline(await chain.chainTime());
  if (!deadline.ok) return { status: 'failed', code: 'ACTION_INVALID' };
  const manifest = evidence.opening.manifest;
  const boundAction =
    manifest.supersedes === null ? bindIssue(reference, nonce, deadline.data) : null;
  if (boundAction === null) return { status: 'failed', code: 'ACTION_INVALID' };
  const bound = { data: boundAction };

  // 4. First confirmation: the exact snapshot, before anything is signed.
  const preview: SignoffPreview = {
    files: manifest.artifacts.map((artifact) => ({
      label: artifact.label,
      role: artifact.role,
      mediaType: artifact.mediaType,
      byteLength: artifact.byteLength,
    })),
    reference,
    profile: manifest.profile,
    reviewerAddress: reference.reviewerAddress,
    action: 'ISSUE',
    registryNonce: nonce,
    deadline: deadline.data,
    valueWei: '0',
  };
  if (!(await input.confirm.snapshot(preview))) return { status: 'declined', stage: 'snapshot' };

  // 5. Sign the typed data and the transaction locally. Nothing is broadcast yet.
  const typedData = buildTypedData(bound.data, bound.data.chainId, bound.data.registryAddress);
  if (!typedData.ok) return { status: 'failed', code: 'ACTION_INVALID' };
  const eip712 = toEip712ReviewAction(typedData.data);
  if (!eip712.ok) return { status: 'failed', code: 'ACTION_INVALID' };
  let signature: Hex;
  try {
    signature = await signer.signTypedData(eip712.data);
  } catch {
    return { status: 'failed', code: 'SIGNING_FAILED' };
  }
  const calldata = encodeExecuteCalldata(bound.data.action, signature);
  if (calldata === null) return { status: 'failed', code: 'ACTION_INVALID' };
  let signed;
  try {
    signed = await chain.signTransaction(calldata);
  } catch {
    return { status: 'failed', code: 'SIGNING_FAILED' };
  }
  // Parse the transaction we are about to send: destination, selector, action fields and chain.
  const decoded = await decodeSignedRegistryTransaction(signed.raw, {
    chainId: Number(bound.data.chainId),
    registryAddress: bound.data.registryAddress,
  });
  const action = bound.data.action;
  if (
    !decoded.ok ||
    decoded.hash !== signed.hash ||
    decoded.call.kind !== 'execute' ||
    decoded.call.action.reviewer !== action.reviewer ||
    decoded.call.action.action !== 0 ||
    decoded.call.action.commitment !== action.commitment ||
    decoded.call.action.replacementCommitment !== action.replacementCommitment ||
    decoded.call.action.nonce !== action.nonce ||
    decoded.call.action.deadline !== action.deadline ||
    (decoded.transaction.value !== undefined && decoded.transaction.value !== 0n)
  )
    return { status: 'failed', code: 'TRANSACTION_SCOPE_REJECTED' };
  if (decoded.transaction.gas === undefined || decoded.transaction.gas > REGISTRY_GAS_LIMIT_CEILING)
    return { status: 'failed', code: 'FEE_CHECK_FAILED' };
  const fees = checkFees(
    {
      gasLimit: decoded.transaction.gas,
      maxFeePerGas: decoded.transaction.maxFeePerGas ?? 0n,
      maxPriorityFeePerGas: decoded.transaction.maxPriorityFeePerGas ?? 0n,
    },
    DEFAULT_MAX_REGISTRY_FEE_WEI,
  );
  if (!fees.ok) return { status: 'failed', code: 'FEE_CHECK_FAILED' };

  // 6. Second, separate confirmation: the fee ceiling and the exact transaction.
  if (
    !(await input.confirm.send({
      ...preview,
      maxFeeWei: fees.maxFeeWei,
      transactionHash: signed.hash,
    }))
  )
    return { status: 'declined', stage: 'send' };

  // 7. Record the PUBLIC pending identity, then broadcast. The raw transaction stays in memory.
  try {
    await input.pending.record({
      schema: 'lexaegis.example.signoff-pending.v1',
      commitment: reference.commitment,
      transactionHash: signed.hash,
      chainId: bound.data.chainId,
      registryAddress: bound.data.registryAddress,
      deadline: action.deadline,
      recordedAt: (input.now ?? (() => new Date()))().toISOString(),
    });
  } catch {
    return { status: 'failed', code: 'PENDING_RECORD_FAILED' };
  }
  let broadcastError = false;
  try {
    await chain.broadcast(signed.raw);
  } catch {
    broadcastError = true;
  }

  // 8. Reconcile the EXACT transaction before anything else. A lost response is not a failure.
  let state = await untilState(chain, signed.hash);
  if (state === 'unknown' && broadcastError) {
    // The same signed transaction, once more: same action, same nonce, same hash.
    try {
      await chain.broadcast(signed.raw);
    } catch {
      // keep reconciling
    }
    state = await untilState(chain, signed.hash);
  }
  if (state === 'reverted') return { status: 'reverted', transactionHash: signed.hash };
  if (state !== 'success') return { status: 'unresolved', transactionHash: signed.hash };
  return confirm(input, evidence, signed.hash);
}

async function untilState(chain: ChainAccess, hash: Hex): Promise<TransactionState> {
  return untilTrue(
    chain,
    () => chain.transactionState(hash),
    (state) => state === 'success' || state === 'reverted',
  );
}

async function confirm(
  input: IssueInput,
  evidence: SavedEvidence,
  hash: Hex,
): Promise<IssueResult> {
  const after = await untilTrue(
    input.chain,
    () => readPreserved(input.chain, input.reference, evidence, input.now),
    isActive,
  );
  return isActive(after)
    ? { status: 'confirmed', transactionHash: hash, report: after }
    : { status: 'unconfirmed', transactionHash: hash, report: after };
}
