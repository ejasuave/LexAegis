import { keccak256, toHex, type Hex } from 'viem';
import type { ChainPolicy } from '@lexaegis/sdk/registry';
import {
  calldataHash,
  checkFees,
  decodeSignedRegistryTransaction,
  observeTransaction,
  type MonitorTarget,
} from '@lexaegis/sdk/transactions';
import type { ServerChainClient } from './alchemy-client';
import {
  submissionRecordSchema,
  transactionQuoteSchema,
  type SubmissionRecord,
  type TransactionQuote,
} from './config';
import { quoteHash, quoteTransaction, type QuoteCode } from './fee-quotes';
import type { ChainStore, OperationRow } from './operation-store';
import { preflight, type PreflightCode, type PreflightRequest } from './preflight';
import { z } from 'zod';

/*
 * Operation workflows behind the /api/chain routes. Each takes the authenticated owner address
 * from the session; nothing here accepts a client-supplied sender, hash or recipient.
 */

export interface OperationDeps {
  readonly client: ServerChainClient;
  readonly policy: ChainPolicy;
  readonly store: ChainStore;
  readonly now: () => Date;
  readonly randomId: () => string;
  readonly registryMaxFeeWei: bigint;
}

export type OperationFailure =
  | PreflightCode
  | QuoteCode
  | 'IDEMPOTENCY_CONFLICT'
  | 'ACCOUNT_BUSY'
  | 'NOT_FOUND'
  | 'QUOTE_INVALID'
  | 'QUOTE_EXPIRED'
  | 'TRANSACTION_REJECTED'
  | 'SENDER_MISMATCH'
  | 'FIELDS_MISMATCH'
  | 'STATE_CHANGED'
  | 'HASH_MISMATCH'
  | 'SUBMISSION_UNKNOWN';

export type OperationResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly code: OperationFailure };

const fail = (code: OperationFailure): OperationResult<never> => ({ ok: false, code });

export const requestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('execute'),
    action: z.unknown(),
    packageReference: z.unknown(),
  }),
  z.strictObject({ kind: z.literal('invalidate_nonce'), expectedNonce: z.string() }),
]);

export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );

export const intentHash = (request: PreflightRequest): string =>
  keccak256(toHex(canonical(request)));

export function toRecord(row: OperationRow, policy: ChainPolicy): SubmissionRecord {
  return submissionRecordSchema.parse({
    operationId: row.id,
    kind: row.kind,
    phase: row.phase,
    chainId: policy.chainId,
    registryAddress: policy.registryAddress,
    account: row.owner,
    commitment: row.commitment,
    registryNonce: row.registryNonce,
    transactionNonce: row.transactionNonce,
    transactionHash: row.transactionHash,
    blockNumber: row.blockNumber,
    blockHash: row.blockHash,
    chargedFeeWei: row.chargedFeeWei,
    executedViaAnotherTransaction: row.executedViaOther,
    updatedAt: row.updatedAt.toISOString(),
  });
}

export async function createOperation(
  deps: OperationDeps,
  owner: string,
  idempotencyKey: string,
  request: PreflightRequest,
) {
  const checked = await preflight(deps, owner, request);
  if (!checked.ok) return fail(checked.code);
  const reserved = await deps.store.reserve({
    id: deps.randomId(),
    owner,
    kind: request.kind === 'execute' ? 'execute' : 'invalidate_nonce',
    idempotencyKey,
    intentHash: intentHash(request),
    chainId: deps.policy.chainId,
    registryAddress: deps.policy.registryAddress,
    commitment: checked.data.preflight.commitment,
    actionDigest: checked.data.preflight.actionDigest,
    registryNonce: checked.data.preflight.registryNonce,
    now: deps.now(),
  });
  if (reserved.kind === 'idempotency_conflict') return fail('IDEMPOTENCY_CONFLICT');
  if (reserved.kind === 'account_busy') return fail('ACCOUNT_BUSY');
  return {
    ok: true,
    data: {
      operation: toRecord(reserved.operation, deps.policy),
      preflight: { operationId: reserved.operation.id, ...checked.data.preflight },
    },
  } as const;
}

export async function quoteOperation(
  deps: OperationDeps,
  owner: string,
  operationId: string,
  request: PreflightRequest,
  signature: Hex | null,
): Promise<OperationResult<{ quote: TransactionQuote; operation: SubmissionRecord }>> {
  const row = await deps.store.get(operationId, owner);
  if (row === null) return fail('NOT_FOUND');
  if (row.intentHash !== intentHash(request)) return fail('STATE_CHANGED');
  const held = await deps.store.highestHeldTransactionNonce(owner);
  const quoted = await quoteTransaction(
    {
      client: deps.client,
      policy: deps.policy,
      now: deps.now,
      maxFeeWei: deps.registryMaxFeeWei,
      // This operation's own earlier quote is not a collision with itself.
      highestHeldNonce: row.phase === 'quoted' ? null : held,
    },
    operationId,
    owner,
    request,
    signature,
  );
  if (!quoted.ok) return fail(quoted.code === 'PREFLIGHT_REJECTED' ? 'STATE_CHANGED' : quoted.code);
  const saved = await deps.store.recordQuote(
    operationId,
    owner,
    {
      transactionNonce: quoted.quote.transactionNonce,
      calldataHash: quoted.quote.calldataHash,
      quoteHash: quoteHash(quoted.quote),
    },
    deps.now(),
  );
  if (saved === null) return fail('STATE_CHANGED');
  return { ok: true, data: { quote: quoted.quote, operation: toRecord(saved, deps.policy) } };
}

const DEFINITIVE_REJECTIONS = new Set([
  'InsufficientFundsError',
  'NonceTooLowError',
  'NonceTooHighError',
  'FeeCapTooLowError',
  'IntrinsicGasTooLowError',
  'TipAboveFeeCapError',
  'ExecutionRevertedError',
]);
const ALREADY_KNOWN = /already known|known transaction|AlreadyKnown/i;

/**
 * Carries a user-signed transaction. The server decodes the raw bytes, recovers the signer,
 * enforces the scope independently of the browser, compares every field with the stored quote,
 * records the locally computed hash durably, then broadcasts once. It never signs.
 */
export async function submitOperation(
  deps: OperationDeps,
  owner: string,
  operationId: string,
  input: { quote: unknown; request: PreflightRequest; signedTransaction: string },
): Promise<OperationResult<{ operation: SubmissionRecord; transactionHash: Hex }>> {
  const row = await deps.store.get(operationId, owner);
  if (row === null) return fail('NOT_FOUND');
  const decoded = await decodeSignedRegistryTransaction(input.signedTransaction, {
    chainId: Number(deps.policy.chainId),
    registryAddress: deps.policy.registryAddress,
  });
  if (!decoded.ok) return fail('TRANSACTION_REJECTED');
  if (decoded.sender !== owner.toLowerCase()) return fail('SENDER_MISMATCH');
  const hash = decoded.hash;

  // An exact retry first reconciles the stored hash; it never needs a fresh quote.
  const isRetry = row.transactionHash !== null;
  if (isRetry && row.transactionHash !== hash) return fail('HASH_MISMATCH');

  const quote = transactionQuoteSchema.safeParse(input.quote);
  if (!quote.success) return fail('QUOTE_INVALID');
  const q = quote.data;
  if (row.quoteHash === null || quoteHash(q) !== row.quoteHash || q.operationId !== operationId) {
    return fail('QUOTE_INVALID');
  }
  if (!isRetry && deps.now().getTime() > new Date(q.expiresAt).getTime())
    return fail('QUOTE_EXPIRED');

  const tx = decoded.transaction;
  if (
    BigInt(tx.nonce ?? -1) !== BigInt(q.transactionNonce) ||
    tx.gas !== BigInt(q.gasLimit) ||
    tx.maxFeePerGas !== BigInt(q.maxFeePerGas) ||
    tx.maxPriorityFeePerGas !== BigInt(q.maxPriorityFeePerGas) ||
    calldataHash(tx.data as Hex) !== q.calldataHash ||
    q.account !== owner.toLowerCase()
  ) {
    return fail('FIELDS_MISMATCH');
  }
  const fees = checkFees(
    {
      gasLimit: tx.gas,
      maxFeePerGas: tx.maxFeePerGas ?? 0n,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 0n,
    },
    BigInt(q.maxFeeWei),
  );
  if (!fees.ok) return fail('FIELDS_MISMATCH');

  // The call must be this operation's: its action nonce and digest, or its exact invalidation.
  const call = decoded.call;
  if (call.kind === 'execute') {
    if (row.kind !== 'execute' || call.action.nonce !== row.registryNonce)
      return fail('FIELDS_MISMATCH');
    if (call.action.commitment.toLowerCase() !== row.commitment) return fail('FIELDS_MISMATCH');
  } else if (row.kind !== 'invalidate_nonce' || call.expectedNonce !== row.registryNonce) {
    return fail('FIELDS_MISMATCH');
  }

  if (!isRetry) {
    // Recheck live chain, lifecycle and nonce right before the first broadcast.
    if (row.intentHash !== intentHash(input.request)) return fail('STATE_CHANGED');
    const again = await preflight(deps, owner, input.request);
    if (!again.ok) return fail('STATE_CHANGED');
    const count = await deps.client.public
      .getTransactionCount({ address: owner.toLowerCase() as Hex })
      .catch(() => null);
    if (count === null || BigInt(count) !== BigInt(q.transactionNonce))
      return fail('STATE_CHANGED');
  }

  // Hash, nonce and public intent are durable before the network sees the bytes.
  const begun = await deps.store.beginSubmit(
    operationId,
    owner,
    { transactionHash: hash, transactionNonce: q.transactionNonce, calldataHash: q.calldataHash },
    deps.now(),
  );
  if (begun.kind === 'not_found') return fail('NOT_FOUND');
  if (begun.kind === 'conflict') return fail('STATE_CHANGED');

  const observed = await observeTransaction(
    { client: deps.client.monitor, policy: deps.policy, now: deps.now },
    monitorTarget(hash, owner, q.transactionNonce, row, input.request),
  );
  if (observed.outcome !== 'submitted') {
    const updated = await applyObservation(deps, owner, operationId, observed);
    return {
      ok: true,
      data: { operation: toRecord(updated ?? begun.operation, deps.policy), transactionHash: hash },
    };
  }

  try {
    const returned = await deps.client.sendRawTransaction(input.signedTransaction as Hex);
    if (returned.toLowerCase() !== hash) {
      await deps.store.setPhase(operationId, owner, 'unknown', {}, deps.now());
      return fail('HASH_MISMATCH');
    }
  } catch (error) {
    const err = error as { name?: string; message?: string; cause?: { name?: string } } | null;
    const name = err?.cause?.name ?? err?.name ?? '';
    if (!ALREADY_KNOWN.test(err?.message ?? '')) {
      if (DEFINITIVE_REJECTIONS.has(name)) {
        // The node refused the bytes outright; the operation can be cancelled and requoted.
        await deps.store.setPhase(operationId, owner, 'cancelled', {}, deps.now());
        return fail('TRANSACTION_REJECTED');
      }
      // A timeout or ambiguous failure may have reached the network: never failed, never confirmed.
      await deps.store.setPhase(operationId, owner, 'unknown', {}, deps.now());
      return fail('SUBMISSION_UNKNOWN');
    }
  }
  const submitted = await deps.store.setPhase(operationId, owner, 'submitted', {}, deps.now());
  return {
    ok: true,
    data: { operation: toRecord(submitted ?? begun.operation, deps.policy), transactionHash: hash },
  };
}

function monitorTarget(
  hash: Hex,
  owner: string,
  transactionNonce: string,
  row: OperationRow,
  request: PreflightRequest,
): MonitorTarget {
  return {
    hash,
    sender: owner.toLowerCase() as Hex,
    transactionNonce: BigInt(transactionNonce),
    intent:
      request.kind === 'execute'
        ? {
            kind: 'execute',
            chainId: row.chainId,
            action: (request.action as { action: never }).action,
          }
        : { kind: 'invalidate_nonce', reviewer: owner, expectedNonce: row.registryNonce },
  };
}

async function applyObservation(
  deps: OperationDeps,
  owner: string,
  operationId: string,
  observed: Awaited<ReturnType<typeof observeTransaction>>,
): Promise<OperationRow | null> {
  const phase = observed.outcome === 'submitted' ? 'submitted' : observed.outcome;
  return deps.store.setPhase(
    operationId,
    owner,
    phase,
    {
      ...(observed.blockNumber !== null && { blockNumber: observed.blockNumber }),
      ...(observed.blockHash !== null && { blockHash: observed.blockHash }),
      ...(observed.chargedFeeWei !== null && { chargedFeeWei: observed.chargedFeeWei }),
      executedViaOther: observed.executedViaAnotherTransaction,
    },
    deps.now(),
  );
}

/**
 * Owner-only reconciliation from chain state. It needs only the stored public identity and the
 * recomputable request, never a signing key; a lost browser cache does not lose the operation.
 */
export async function reconcileOperation(
  deps: OperationDeps,
  owner: string,
  operationId: string,
  request: PreflightRequest | null,
): Promise<
  OperationResult<{
    operation: SubmissionRecord;
    observation: Awaited<ReturnType<typeof observeTransaction>> | null;
  }>
> {
  const row = await deps.store.get(operationId, owner);
  if (row === null) return fail('NOT_FOUND');
  if (row.transactionHash === null || row.transactionNonce === null || request === null) {
    return { ok: true, data: { operation: toRecord(row, deps.policy), observation: null } };
  }
  const observation = await observeTransaction(
    {
      client: deps.client.monitor,
      policy: deps.policy,
      now: deps.now,
      // A confirmed block is remembered: a later reading that disagrees is a contradiction to show,
      // never a quiet second confirmation on another block.
      ...(row.phase === 'confirmed' &&
        row.blockHash !== null && { previouslyConfirmedBlockHash: row.blockHash.toLowerCase() }),
    },
    monitorTarget(row.transactionHash as Hex, owner, row.transactionNonce, row, request),
  );
  // A submitted-but-unseen transaction stays as it was; stronger phases are recorded.
  const updated =
    observation.outcome === 'submitted'
      ? row
      : ((await applyObservation(deps, owner, operationId, observation)) ?? row);
  return { ok: true, data: { operation: toRecord(updated, deps.policy), observation } };
}

export async function cancelOperation(deps: OperationDeps, owner: string, operationId: string) {
  return deps.store.cancelUnsigned(operationId, owner, deps.now());
}
