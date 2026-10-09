import { encodeFunctionData, type Hex } from 'viem';
import {
  decodeRegistryEvent,
  proofOfReviewRegistryAbi,
  REVIEW_ACTION_CODES,
  readChainCheckpoint,
  type ChainCheckpoint,
  type ChainPolicy,
  type LiveChainClient,
  type ObservedReceipt,
  type RegistryEvent,
  type ReviewActionV1,
} from '../registry';
import { monadChargedFeeWei } from './fees';

/*
 * Bounded transaction monitoring. A first receipt or one confirmation is not the application's
 * success condition: success requires matching transaction fields, a canonical block that is
 * covered by the execution checkpoint, and (for registry transactions) the exact expected events.
 * A missing receipt, an HTTP timeout or an expired action deadline never proves "not broadcast".
 */

export const MONITOR_INITIAL_POLL_MS = 2_000;
export const MONITOR_MAX_POLL_MS = 10_000;
export const MONITOR_DEADLINE_MS = 120_000;

export const TRANSACTION_OUTCOMES = [
  'submitted',
  'pending',
  'included',
  'confirmed',
  'reverted',
  'replaced',
  'unknown',
] as const;
export type TransactionOutcome = (typeof TRANSACTION_OUTCOMES)[number];

export interface ChainTransactionView {
  readonly hash: Hex;
  readonly from: Hex;
  readonly to: Hex | null;
  readonly nonce: bigint;
  readonly value: bigint;
  readonly input: Hex;
  readonly gas: bigint;
  readonly blockNumber: bigint | null;
}

export interface ChainLogView {
  readonly address: Hex;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

export interface ChainReceiptView {
  readonly transactionHash: Hex;
  readonly from: Hex;
  readonly to: Hex | null;
  readonly status: 'success' | 'reverted';
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly effectiveGasPrice: bigint;
  readonly gasUsed: bigint;
  readonly logs: readonly ChainLogView[];
}

export interface MonitorClient extends LiveChainClient {
  getTransaction(hash: Hex): Promise<ChainTransactionView | null>;
  getTransactionReceipt(hash: Hex): Promise<ChainReceiptView | null>;
  /** Confirmed-or-latest transaction count of the sender (the EOA nonce). */
  getTransactionCount(address: Hex): Promise<bigint>;
  getBalance(address: Hex, blockNumber?: bigint): Promise<bigint>;
}

export type ExpectedIntent =
  | { readonly kind: 'execute'; readonly action: ReviewActionV1; readonly chainId: string }
  | { readonly kind: 'invalidate_nonce'; readonly reviewer: string; readonly expectedNonce: string }
  | { readonly kind: 'transfer'; readonly recipient: string; readonly valueWei: bigint };

export interface MonitorTarget {
  readonly hash: Hex;
  readonly sender: Hex;
  /** The EOA transaction nonce. Never the registry action nonce or a login nonce. */
  readonly transactionNonce: bigint;
  readonly intent: ExpectedIntent;
}

export type Mismatch =
  | 'TRANSACTION_FIELDS'
  | 'RECEIPT_FIELDS'
  | 'EVENTS'
  | 'NOT_CANONICAL'
  | 'CHECKPOINT_UNAVAILABLE'
  | 'REPLACEMENT_UNESTABLISHED'
  | 'RPC_UNAVAILABLE'
  | 'CONTRADICTS_CONFIRMED';

export interface TransactionObservation {
  readonly outcome: TransactionOutcome;
  readonly hash: Hex;
  readonly mismatch: Mismatch | null;
  readonly blockNumber: string | null;
  readonly blockHash: string | null;
  readonly checkpoint: ChainCheckpoint | null;
  /** Wei charged: gas limit times effective price. Present once an execution receipt exists. */
  readonly chargedFeeWei: string | null;
  /** True when a reverted or unmatched transaction left the action nonce consumed by another transaction. */
  readonly executedViaAnotherTransaction: boolean;
  readonly events: readonly RegistryEvent[];
}

export interface MonitorContext {
  readonly client: MonitorClient;
  readonly policy: ChainPolicy;
  readonly now?: () => Date;
  /** A previously confirmed observation for the same hash, to detect contradictions. */
  readonly previouslyConfirmedBlockHash?: string;
}

const lower = (value: string): string => value.toLowerCase();

function result(
  hash: Hex,
  outcome: TransactionOutcome,
  extra: Partial<Omit<TransactionObservation, 'outcome' | 'hash'>> = {},
): TransactionObservation {
  return {
    outcome,
    hash,
    mismatch: null,
    blockNumber: null,
    blockHash: null,
    checkpoint: null,
    chargedFeeWei: null,
    executedViaAnotherTransaction: false,
    events: [],
    ...extra,
  };
}

/** Events expected from a successful registry transaction, in order. */
export function expectedRegistryEvents(
  intent: Extract<ExpectedIntent, { kind: 'execute' | 'invalidate_nonce' }>,
): readonly Partial<RegistryEvent>[] {
  if (intent.kind === 'invalidate_nonce') {
    return [
      {
        eventKind: 'nonce_invalidated',
        reviewerAddress: lower(intent.reviewer),
        previousNonce: intent.expectedNonce,
        newNonce: (BigInt(intent.expectedNonce) + 1n).toString(),
      },
    ];
  }
  const { action } = intent;
  const reviewerAddress = lower(action.reviewer);
  if (action.action === REVIEW_ACTION_CODES.ISSUE) {
    return [
      {
        eventKind: 'issued',
        reviewerAddress,
        commitment: action.commitment,
        predecessor: null,
        nonce: action.nonce,
      },
    ];
  }
  if (action.action === REVIEW_ACTION_CODES.REVOKE) {
    return [
      { eventKind: 'revoked', reviewerAddress, commitment: action.commitment, nonce: action.nonce },
    ];
  }
  // SUPERSEDE is one atomic action: the new ReceiptIssued, then ReceiptSuperseded.
  return [
    {
      eventKind: 'issued',
      reviewerAddress,
      commitment: action.replacementCommitment,
      predecessor: action.commitment,
      nonce: action.nonce,
    },
    {
      eventKind: 'superseded',
      reviewerAddress,
      previousCommitment: action.commitment,
      replacementCommitment: action.replacementCommitment,
      nonce: action.nonce,
    },
  ];
}

function eventsMatch(
  actual: readonly RegistryEvent[],
  expected: readonly Partial<RegistryEvent>[],
): boolean {
  if (actual.length !== expected.length) return false;
  return expected.every((want, index) => {
    const got = actual[index] as unknown as Record<string, unknown> | undefined;
    if (got === undefined) return false;
    return Object.entries(want).every(([key, value]) => got[key] === value);
  });
}

/** Decodes only logs from the configured registry address; others are ignored. */
export function decodeRegistryLogs(
  policy: ChainPolicy,
  logs: readonly ChainLogView[],
): RegistryEvent[] | null {
  const events: RegistryEvent[] = [];
  for (const log of logs) {
    if (lower(log.address) !== policy.registryAddress) continue;
    const decoded = decodeRegistryEvent(
      { chainId: policy.chainId, registryAddress: policy.registryAddress },
      { address: log.address, topics: [...log.topics], data: log.data },
    );
    if (!decoded.ok) return null;
    events.push(decoded.data);
  }
  return events;
}

function transactionMatches(
  tx: ChainTransactionView,
  target: MonitorTarget,
  policy: ChainPolicy,
): boolean {
  if (lower(tx.hash) !== lower(target.hash)) return false;
  if (lower(tx.from) !== lower(target.sender)) return false;
  if (tx.nonce !== target.transactionNonce) return false;
  const { intent } = target;
  if (intent.kind === 'transfer') {
    return (
      tx.to !== null &&
      lower(tx.to) === lower(intent.recipient) &&
      tx.value === intent.valueWei &&
      tx.input === '0x'
    );
  }
  return tx.to !== null && lower(tx.to) === policy.registryAddress && tx.value === 0n;
}

/**
 * One bounded observation of a transaction. It performs a fixed number of reads and never scans
 * the chain. Replaced is reported only when the transaction itself is gone and a different
 * transaction is established; an advanced nonce without that evidence is `unknown`.
 */
export async function observeTransaction(
  ctx: MonitorContext,
  target: MonitorTarget,
): Promise<TransactionObservation> {
  const { client, policy } = ctx;
  const { hash } = target;
  try {
    const [tx, receipt] = await Promise.all([
      client.getTransaction(hash),
      client.getTransactionReceipt(hash),
    ]);

    if (receipt === null) {
      if (tx !== null) {
        if (!transactionMatches(tx, target, policy)) {
          return result(hash, 'unknown', { mismatch: 'TRANSACTION_FIELDS' });
        }
        return result(hash, 'pending');
      }
      const count = await client.getTransactionCount(target.sender);
      if (count > target.transactionNonce) {
        return result(hash, 'unknown', { mismatch: 'REPLACEMENT_UNESTABLISHED' });
      }
      return result(hash, 'submitted');
    }

    if (
      lower(receipt.transactionHash) !== lower(hash) ||
      lower(receipt.from) !== lower(target.sender) ||
      (tx !== null && !transactionMatches(tx, target, policy))
    ) {
      return result(hash, 'unknown', { mismatch: 'RECEIPT_FIELDS' });
    }
    const intentTarget =
      target.intent.kind === 'transfer' ? target.intent.recipient : policy.registryAddress;
    if (receipt.to === null || lower(receipt.to) !== lower(intentTarget)) {
      return result(hash, 'unknown', { mismatch: 'RECEIPT_FIELDS' });
    }

    const common = {
      blockNumber: receipt.blockNumber.toString(),
      blockHash: lower(receipt.blockHash),
      chargedFeeWei: monadChargedFeeWei(
        tx?.gas ?? receipt.gasUsed,
        receipt.effectiveGasPrice,
      ).toString(),
    };

    // Canonical check: the block at that height must still carry the receipt's hash.
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (block === null || lower(block.hash) !== lower(receipt.blockHash)) {
      return result(hash, 'pending', {
        mismatch:
          ctx.previouslyConfirmedBlockHash === undefined
            ? 'NOT_CANONICAL'
            : 'CONTRADICTS_CONFIRMED',
      });
    }
    if (
      ctx.previouslyConfirmedBlockHash !== undefined &&
      ctx.previouslyConfirmedBlockHash !== lower(receipt.blockHash)
    ) {
      return result(hash, 'unknown', { ...common, mismatch: 'CONTRADICTS_CONFIRMED' });
    }

    if (receipt.status === 'reverted') {
      // The EOA nonce and the fee are consumed; the registry action nonce is not.
      const elsewhere = await executedElsewhere(ctx, target);
      return result(hash, 'reverted', { ...common, executedViaAnotherTransaction: elsewhere });
    }

    const checkpoint = await readChainCheckpoint(client, policy, ctx.now ?? (() => new Date()));
    if (checkpoint.status !== 'ok') {
      return result(hash, 'included', { ...common, mismatch: 'CHECKPOINT_UNAVAILABLE' });
    }
    let events: RegistryEvent[] = [];
    if (target.intent.kind !== 'transfer') {
      const decoded = decodeRegistryLogs(policy, receipt.logs);
      if (decoded === null || !eventsMatch(decoded, expectedRegistryEvents(target.intent))) {
        return result(hash, 'unknown', {
          ...common,
          mismatch: 'EVENTS',
          checkpoint: checkpoint.data,
        });
      }
      events = decoded;
    }
    const covered = receipt.blockNumber <= BigInt(checkpoint.data.blockNumber);
    return result(hash, covered ? 'confirmed' : 'included', {
      ...common,
      checkpoint: checkpoint.data,
      events,
    });
  } catch {
    return result(hash, 'unknown', { mismatch: 'RPC_UNAVAILABLE' });
  }
}

/**
 * A third party may have executed the disclosed action first. True only when the registry's
 * action nonce has advanced past this action's nonce at the checkpoint.
 */
async function executedElsewhere(ctx: MonitorContext, target: MonitorTarget): Promise<boolean> {
  if (target.intent.kind !== 'execute') return false;
  try {
    const checkpoint = await readChainCheckpoint(
      ctx.client,
      ctx.policy,
      ctx.now ?? (() => new Date()),
    );
    if (checkpoint.status !== 'ok') return false;
    const data = await ctx.client.call({
      to: ctx.policy.registryAddress as Hex,
      data: nonceOfCalldata(target.intent.action.reviewer as Hex),
      blockNumber: BigInt(checkpoint.data.blockNumber),
    });
    return data !== undefined && BigInt(data) > BigInt(target.intent.action.nonce);
  } catch {
    return false;
  }
}

function nonceOfCalldata(reviewer: Hex): Hex {
  return encodeFunctionData({
    abi: proofOfReviewRegistryAbi,
    functionName: 'nonceOf',
    args: [reviewer],
  });
}

export type Sleep = (ms: number) => Promise<void>;

/** Observation of an `ObservedReceipt` kept for callers that want current lifecycle with the outcome. */
export type CurrentLifecycle = ObservedReceipt['receiptLifecycle'];

/**
 * Polls every 2 seconds with bounded backoff for at most 120 seconds, then returns the last
 * observation as an unresolved state. The caller may refresh explicitly; no request is held open
 * indefinitely and nothing is re-broadcast.
 */
export async function monitorTransaction(
  ctx: MonitorContext,
  target: MonitorTarget,
  options: {
    readonly sleep?: Sleep;
    readonly clock?: () => number;
    readonly deadlineMs?: number;
  } = {},
): Promise<{ readonly observation: TransactionObservation; readonly resolved: boolean }> {
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const clock = options.clock ?? (() => Date.now());
  const deadline = clock() + (options.deadlineMs ?? MONITOR_DEADLINE_MS);
  let delay = MONITOR_INITIAL_POLL_MS;
  for (;;) {
    const observation = await observeTransaction(ctx, target);
    const final =
      observation.outcome === 'confirmed' ||
      observation.outcome === 'reverted' ||
      observation.outcome === 'replaced';
    if (final) return { observation, resolved: true };
    if (clock() + delay >= deadline) return { observation, resolved: false };
    await sleep(delay);
    delay = Math.min(Math.floor(delay * 1.5), MONITOR_MAX_POLL_MS);
  }
}
