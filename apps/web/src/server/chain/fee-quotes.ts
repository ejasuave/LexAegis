import { keccak256, toHex, verifyTypedData, type Hex } from 'viem';
import {
  buildTypedData,
  toEip712ReviewAction,
  type BoundReviewAction,
  type ChainPolicy,
} from '@lexaegis/sdk/registry';
import {
  calldataHash,
  checkFees,
  encodeExecuteCalldata,
  encodeInvalidateNonceCalldata,
  expectedFeeWei,
  registryGasLimit,
} from '@lexaegis/sdk/transactions';
import type { ServerChainClient } from './alchemy-client';
import { transactionQuoteSchema, type TransactionQuote } from './config';
import { preflight, type PreflightRequest, type PreflightResult } from './preflight';

export const QUOTE_TTL_MS = 30_000;

export const QUOTE_CODES = [
  'PREFLIGHT_FAILED',
  'SIGNATURE_INVALID',
  'SIMULATION_FAILED',
  'ESTIMATE_FAILED',
  'GAS_LIMIT_TOO_HIGH',
  'FEE_CEILING_EXCEEDED',
  'FEE_FIELDS_INVALID',
  'INSUFFICIENT_BALANCE',
  'NONCE_COLLISION',
  'CHAIN_UNAVAILABLE',
] as const;
export type QuoteCode = (typeof QUOTE_CODES)[number] | 'PREFLIGHT_REJECTED';

export interface QuoteDeps {
  readonly client: ServerChainClient;
  readonly policy: ChainPolicy;
  readonly now: () => Date;
  readonly maxFeeWei: bigint;
  /** Highest EOA nonce held by an unresolved operation of this account, from the shared store. */
  readonly highestHeldNonce: bigint | null;
}

export type QuoteResult =
  | { readonly ok: true; readonly quote: TransactionQuote; readonly calldata: Hex }
  | { readonly ok: false; readonly code: QuoteCode; readonly preflight?: PreflightResult<never> };

/** Field commitment of a quote. Stored and compared instead of any signed bytes. */
export function quoteHash(quote: TransactionQuote): Hex {
  return keccak256(
    toHex(
      JSON.stringify([
        quote.operationId,
        quote.account,
        quote.chainId,
        quote.registryAddress,
        quote.calldataHash,
        quote.actionDigest,
        quote.value,
        quote.type,
        quote.transactionNonce,
        quote.gasLimit,
        quote.maxFeePerGas,
        quote.maxPriorityFeePerGas,
      ]),
    ),
  );
}

/**
 * Exact-calldata quote. The EIP-712 signature is verified for the EOA, the call is simulated and
 * gas estimated from the actual sender: no fake signature, no state override. The gas limit is
 * the estimate plus 10%, rejected (never clipped) above 1,000,000.
 */
export async function quoteTransaction(
  deps: QuoteDeps,
  operationId: string,
  account: string,
  request: PreflightRequest,
  signature: Hex | null,
): Promise<QuoteResult> {
  const { client, policy } = deps;
  const accountHex = account.toLowerCase() as Hex;
  const checked = await preflight(deps, accountHex, request);
  if (!checked.ok) return { ok: false, code: 'PREFLIGHT_REJECTED' };

  let calldata: Hex | null;
  let actionDigest: string | null = null;
  if (request.kind === 'execute') {
    const bound: BoundReviewAction | null = checked.data.bound;
    if (bound === null || signature === null) return { ok: false, code: 'SIGNATURE_INVALID' };
    const typed = buildTypedData(bound, policy.chainId, policy.registryAddress);
    const eip712 = typed.ok ? toEip712ReviewAction(typed.data) : null;
    if (eip712 === null || !eip712.ok) return { ok: false, code: 'SIGNATURE_INVALID' };
    const valid = await verifyTypedData({
      address: accountHex,
      signature,
      domain: eip712.data.domain,
      types: eip712.data.types,
      primaryType: eip712.data.primaryType,
      message: eip712.data.message,
    } as never).catch(() => false);
    if (!valid) return { ok: false, code: 'SIGNATURE_INVALID' };
    calldata = encodeExecuteCalldata(bound.action, signature);
    actionDigest = checked.data.preflight.actionDigest;
  } else {
    calldata = encodeInvalidateNonceCalldata(checked.data.expectedNonce ?? '');
  }
  if (calldata === null) return { ok: false, code: 'SIGNATURE_INVALID' };

  try {
    const to = policy.registryAddress as Hex;
    await client.public.call({ account: accountHex, to, data: calldata, value: 0n }).catch(() => {
      throw new Error('simulation');
    });
  } catch {
    return { ok: false, code: 'SIMULATION_FAILED' };
  }

  let estimated: bigint;
  try {
    estimated = await client.public.estimateGas({
      account: accountHex,
      to: policy.registryAddress as Hex,
      data: calldata,
      value: 0n,
    });
  } catch {
    return { ok: false, code: 'ESTIMATE_FAILED' };
  }
  const limit = registryGasLimit(estimated);
  if (!limit.ok) {
    return { ok: false, code: limit.code === 'ESTIMATE_INVALID' ? 'ESTIMATE_FAILED' : limit.code };
  }

  let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  let transactionNonce: bigint;
  try {
    const estimate: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } =
      await client.public.estimateFeesPerGas();
    if (estimate.maxFeePerGas === undefined || estimate.maxPriorityFeePerGas === undefined) {
      return { ok: false, code: 'CHAIN_UNAVAILABLE' };
    }
    fees = {
      maxFeePerGas: estimate.maxFeePerGas,
      maxPriorityFeePerGas: estimate.maxPriorityFeePerGas,
    };
    // Monad's own pending semantics are not assumed: use the confirmed count and refuse any
    // collision with a nonce another unresolved operation already holds.
    transactionNonce = BigInt(await client.public.getTransactionCount({ address: accountHex }));
  } catch {
    return { ok: false, code: 'CHAIN_UNAVAILABLE' };
  }
  if (deps.highestHeldNonce !== null && deps.highestHeldNonce >= transactionNonce) {
    return { ok: false, code: 'NONCE_COLLISION' };
  }

  const feeCheck = checkFees(
    { gasLimit: limit.gasLimit, ...fees },
    deps.maxFeeWei,
    checked.data.balanceWei,
  );
  if (!feeCheck.ok) return { ok: false, code: feeCheck.code };

  const issued = deps.now();
  const quote = transactionQuoteSchema.parse({
    operationId,
    account: accountHex,
    chainId: policy.chainId,
    registryAddress: policy.registryAddress,
    calldataHash: calldataHash(calldata),
    actionDigest,
    value: '0',
    type: 'eip1559',
    transactionNonce: transactionNonce.toString(),
    gasLimit: limit.gasLimit.toString(),
    maxFeePerGas: fees.maxFeePerGas.toString(),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
    expectedFeeWei: expectedFeeWei(limit.gasLimit, fees.maxFeePerGas).toString(),
    maxFeeWei: feeCheck.maxFeeWei.toString(),
    issuedAt: issued.toISOString(),
    expiresAt: new Date(issued.getTime() + QUOTE_TTL_MS).toISOString(),
  });
  return { ok: true, quote, calldata };
}
