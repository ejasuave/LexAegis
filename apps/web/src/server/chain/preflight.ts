import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem';
import {
  DEFAULT_ACTION_VALIDITY_SECONDS,
  REVIEW_ACTION_CODES,
  boundReviewActionSchema,
  buildTypedData,
  hashReviewAction,
  proofOfReviewRegistryAbi,
  readProvisionalState,
  toAbiReviewAction,
  uint256DecimalSchema,
  type BoundReviewAction,
  type ChainPolicy,
} from '@lexaegis/sdk/registry';
import { parseReceiptReference, type ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import type { ServerChainClient } from './alchemy-client';
import { actionPreflightSchema, isAllowedMutationChain, type ActionPreflight } from './config';

/*
 * Preflight for execute(ReviewAction, signature) and invalidateNonce(expectedNonce), built on the
 * generated ABI only. The server receives public action and reference data; it cannot certify
 * the human review from a caller-supplied flag. Private snapshot and opening checks stay in the
 * browser.
 */

export const MAX_OBSERVATION_AGE_MS = 15_000;
export const MAX_CLOCK_SKEW_SECONDS = 30n;

export const PREFLIGHT_CODES = [
  'CHAIN_UNAVAILABLE',
  'REGISTRY_MISMATCH',
  'ACCOUNT_REJECTED',
  'STATE_UNAVAILABLE',
  'LIFECYCLE_REJECTED',
  'NONCE_MISMATCH',
  'DEADLINE_REJECTED',
  'CLOCK_SKEW',
  'DOMAIN_MISMATCH',
  'ACTION_INVALID',
] as const;
export type PreflightCode = (typeof PREFLIGHT_CODES)[number];
export type PreflightResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly code: PreflightCode };

const fail = (code: PreflightCode): PreflightResult<never> => ({ ok: false, code });

export interface PreflightDeps {
  readonly client: ServerChainClient;
  readonly policy: ChainPolicy;
  readonly now: () => Date;
}

export type PreflightRequest =
  | { readonly kind: 'execute'; readonly action: unknown; readonly packageReference: unknown }
  | { readonly kind: 'invalidate_nonce'; readonly expectedNonce: unknown };

export interface PreflightOutcome {
  readonly preflight: Omit<ActionPreflight, 'operationId'>;
  readonly bound: BoundReviewAction | null;
  readonly expectedNonce: string | null;
  readonly balanceWei: bigint;
}

/** An undelegated EOA has no code. An EIP-7702 delegation or any contract code is refused. */
export async function checkAccountUndelegated(
  client: ServerChainClient,
  account: Hex,
): Promise<boolean> {
  const code = await client.public.getCode({ address: account });
  return code === undefined || code === '0x';
}

function referenceOf(
  policy: ChainPolicy,
  reviewer: string,
  commitment: string,
): ReceiptReferenceV1 {
  return {
    schema: 'lexaegis.receipt-ref.v1',
    chainId: policy.chainId,
    registryAddress: policy.registryAddress,
    reviewerAddress: reviewer,
    commitment,
  };
}

export async function preflight(
  deps: PreflightDeps,
  account: string,
  request: PreflightRequest,
): Promise<PreflightResult<PreflightOutcome>> {
  const { client, policy } = deps;
  if (!isAllowedMutationChain(policy.chainId)) return fail('CHAIN_UNAVAILABLE');
  const accountHex = account.toLowerCase() as Hex;

  let bound: BoundReviewAction | null = null;
  let expectedNonce: string | null = null;
  if (request.kind === 'execute') {
    const parsed = boundReviewActionSchema.safeParse(request.action);
    const reference = parseReceiptReference(request.packageReference);
    if (!parsed.success || !reference.ok) return fail('ACTION_INVALID');
    bound = parsed.data;
    if (bound.chainId !== policy.chainId || bound.registryAddress !== policy.registryAddress) {
      return fail('REGISTRY_MISMATCH');
    }
    if (bound.action.reviewer !== accountHex) return fail('ACCOUNT_REJECTED');
    const subject =
      bound.action.action === REVIEW_ACTION_CODES.SUPERSEDE
        ? bound.action.replacementCommitment
        : bound.action.commitment;
    const ref = reference.data;
    if (
      ref.commitment !== subject ||
      ref.reviewerAddress !== accountHex ||
      ref.chainId !== policy.chainId ||
      ref.registryAddress !== policy.registryAddress
    ) {
      return fail('ACTION_INVALID');
    }
  } else {
    const parsed = uint256DecimalSchema.safeParse(request.expectedNonce);
    if (!parsed.success) return fail('ACTION_INVALID');
    expectedNonce = parsed.data;
  }

  try {
    if (!(await checkAccountUndelegated(client, accountHex))) return fail('ACCOUNT_REJECTED');

    // Nonce and the primary record come from one fresh, identified latest read.
    const primaryCommitment = bound?.action.commitment ?? `0x${'00'.repeat(32)}`;
    const primary = await readProvisionalState(
      client.live,
      policy,
      referenceOf(policy, accountHex, primaryCommitment),
      deps.now,
    );
    if (primary.status !== 'ok') return fail('STATE_UNAVAILABLE');
    const state = primary.data;
    const ageMs = deps.now().getTime() - new Date(state.observedAt).getTime();
    if (ageMs > MAX_OBSERVATION_AGE_MS) return fail('STATE_UNAVAILABLE');

    // The chain clock and this server's clock must agree closely enough to judge a deadline.
    const nowSeconds = BigInt(Math.floor(deps.now().getTime() / 1000));
    const chainSeconds = BigInt(state.blockTimestamp);
    const skew = nowSeconds > chainSeconds ? nowSeconds - chainSeconds : chainSeconds - nowSeconds;
    if (skew > MAX_CLOCK_SKEW_SECONDS) return fail('CLOCK_SKEW');

    const balanceWei = await client.public.getBalance({ address: accountHex });

    if (request.kind === 'invalidate_nonce') {
      if (state.registryNonce !== expectedNonce) return fail('NONCE_MISMATCH');
      return {
        ok: true,
        data: {
          bound: null,
          expectedNonce,
          balanceWei,
          preflight: {
            kind: 'invalidate_nonce',
            chainId: policy.chainId,
            registryAddress: policy.registryAddress,
            account: accountHex,
            registryNonce: state.registryNonce,
            commitment: null,
            actionDigest: null,
            lifecycleBefore: null,
            observedBlock: state.blockNumber,
            observedAt: state.observedAt,
          },
        },
      };
    }

    if (bound === null) return fail('ACTION_INVALID');
    const { action } = bound;
    if (action.nonce !== state.registryNonce) return fail('NONCE_MISMATCH');
    if (
      BigInt(action.deadline) <= chainSeconds ||
      BigInt(action.deadline) >
        chainSeconds + DEFAULT_ACTION_VALIDITY_SECONDS + MAX_CLOCK_SKEW_SECONDS
    ) {
      return fail('DEADLINE_REJECTED');
    }

    const target = state.receipt.receiptLifecycle;
    if (action.action === REVIEW_ACTION_CODES.ISSUE && target !== 'not_found') {
      return fail('LIFECYCLE_REJECTED');
    }
    if (action.action === REVIEW_ACTION_CODES.REVOKE && target !== 'active') {
      return fail('LIFECYCLE_REJECTED');
    }
    if (action.action === REVIEW_ACTION_CODES.SUPERSEDE) {
      if (target !== 'active') return fail('LIFECYCLE_REJECTED');
      const replacement = await readProvisionalState(
        client.live,
        policy,
        referenceOf(policy, accountHex, action.replacementCommitment),
        deps.now,
      );
      if (replacement.status !== 'ok') return fail('STATE_UNAVAILABLE');
      if (replacement.data.receipt.receiptLifecycle !== 'not_found')
        return fail('LIFECYCLE_REJECTED');
    }

    // The SDK digest must equal what the deployed registry computes for the same action.
    const typed = buildTypedData(bound, policy.chainId, policy.registryAddress);
    const sdkDigest = typed.ok ? hashReviewAction(typed.data) : null;
    const abiAction = toAbiReviewAction(action);
    if (sdkDigest === null || !sdkDigest.ok || !abiAction.ok) return fail('ACTION_INVALID');
    const onChain = await client.live.call({
      to: policy.registryAddress as Hex,
      data: encodeFunctionData({
        abi: proofOfReviewRegistryAbi,
        functionName: 'hashAction',
        args: [abiAction.data as never],
      }),
      blockNumber: BigInt(state.blockNumber),
    });
    if (
      onChain === undefined ||
      decodeFunctionResult({
        abi: proofOfReviewRegistryAbi,
        functionName: 'hashAction',
        data: onChain,
      }).toLowerCase() !== sdkDigest.data.toLowerCase()
    ) {
      return fail('DOMAIN_MISMATCH');
    }

    return {
      ok: true,
      data: {
        bound,
        expectedNonce: null,
        balanceWei,
        preflight: {
          kind: 'execute',
          chainId: policy.chainId,
          registryAddress: policy.registryAddress,
          account: accountHex,
          registryNonce: state.registryNonce,
          commitment: action.commitment,
          actionDigest: sdkDigest.data.toLowerCase(),
          lifecycleBefore: target,
          observedBlock: state.blockNumber,
          observedAt: state.observedAt,
        },
      },
    };
  } catch {
    return fail('CHAIN_UNAVAILABLE');
  }
}

export { actionPreflightSchema };
