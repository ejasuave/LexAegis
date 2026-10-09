import {
  decodeFunctionData,
  encodeFunctionData,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
  type TransactionSerializableEIP1559,
} from 'viem';
import { proofOfReviewRegistryAbi } from '../registry/generated/registry-abi';
import { toAbiReviewAction } from '../registry/typed-data';

/*
 * The only transactions the reference application signs or relays: type-2, to the verified
 * registry, value zero, empty access list, with exactly generated `execute` or `invalidateNonce`
 * calldata. Browser signing and server submission both call these checks independently.
 */

export const REGISTRY_TX_BYTE_LIMIT = 4 * 1024;

export type RegistryCall =
  | {
      readonly kind: 'execute';
      readonly action: {
        readonly reviewer: string;
        readonly action: number;
        readonly commitment: string;
        readonly replacementCommitment: string;
        readonly nonce: string;
        readonly deadline: string;
      };
      readonly signature: Hex;
    }
  | { readonly kind: 'invalidate_nonce'; readonly expectedNonce: string };

export function encodeExecuteCalldata(action: unknown, signature: Hex): Hex | null {
  const abiAction = toAbiReviewAction(action);
  if (!abiAction.ok || !/^0x(?:[0-9a-fA-F]{2}){65}$/.test(signature)) return null;
  return encodeFunctionData({
    abi: proofOfReviewRegistryAbi,
    functionName: 'execute',
    args: [abiAction.data as never, signature],
  });
}

export function encodeInvalidateNonceCalldata(expectedNonce: string): Hex | null {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(expectedNonce)) return null;
  return encodeFunctionData({
    abi: proofOfReviewRegistryAbi,
    functionName: 'invalidateNonce',
    args: [BigInt(expectedNonce)],
  });
}

/**
 * Decodes calldata as exactly one generated registry call. Anything else (another selector,
 * appended bytes, non-canonical padding) returns null: the decoded call is re-encoded and must
 * reproduce the input byte for byte.
 */
export function decodeRegistryCalldata(data: Hex): RegistryCall | null {
  try {
    const decoded = decodeFunctionData({ abi: proofOfReviewRegistryAbi, data });
    if (decoded.functionName === 'invalidateNonce') {
      const [expectedNonce] = decoded.args;
      const call: RegistryCall = {
        kind: 'invalidate_nonce',
        expectedNonce: expectedNonce.toString(),
      };
      return encodeInvalidateNonceCalldata(call.expectedNonce) === data.toLowerCase() ? call : null;
    }
    if (decoded.functionName === 'execute') {
      const [action, signature] = decoded.args;
      const plain = {
        reviewer: action.reviewer.toLowerCase(),
        action: action.action,
        commitment: action.commitment.toLowerCase(),
        replacementCommitment: action.replacementCommitment.toLowerCase(),
        nonce: action.nonce.toString(),
        deadline: action.deadline.toString(),
      };
      const again = encodeExecuteCalldata(plain, signature);
      return again !== null && again.toLowerCase() === data.toLowerCase()
        ? { kind: 'execute', action: plain, signature }
        : null;
    }
    return null;
  } catch {
    return null;
  }
}

export const calldataHash = (data: Hex): Hex => keccak256(data);

export const REGISTRY_TX_REJECTIONS = [
  'NOT_TYPE_2',
  'WRONG_CHAIN',
  'WRONG_DESTINATION',
  'NONZERO_VALUE',
  'ACCESS_LIST',
  'AUTHORIZATION_LIST',
  'CALLDATA',
  'FIELDS_MISSING',
  'SENDER_MISMATCH',
  'MALFORMED',
  'TOO_LARGE',
] as const;
export type RegistryTxRejection = (typeof REGISTRY_TX_REJECTIONS)[number];

export interface RegistryTxScope {
  readonly chainId: number;
  readonly registryAddress: string;
}

export type ScopeCheck =
  | { readonly ok: true; readonly call: RegistryCall }
  | { readonly ok: false; readonly reason: RegistryTxRejection };

const hasEntries = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

/** Scope check for an unsigned or decoded signed transaction. */
export function checkRegistryTransaction(
  tx: Record<string, unknown>,
  scope: RegistryTxScope,
): ScopeCheck {
  if (tx.type !== 'eip1559') return { ok: false, reason: 'NOT_TYPE_2' };
  if (tx.chainId !== scope.chainId) return { ok: false, reason: 'WRONG_CHAIN' };
  if (typeof tx.to !== 'string' || tx.to.toLowerCase() !== scope.registryAddress.toLowerCase()) {
    return { ok: false, reason: 'WRONG_DESTINATION' };
  }
  if (tx.value !== undefined && tx.value !== 0n) return { ok: false, reason: 'NONZERO_VALUE' };
  if (hasEntries(tx.accessList)) return { ok: false, reason: 'ACCESS_LIST' };
  if (tx.authorizationList !== undefined && tx.authorizationList !== null) {
    return { ok: false, reason: 'AUTHORIZATION_LIST' };
  }
  if (typeof tx.data !== 'string') return { ok: false, reason: 'CALLDATA' };
  const call = decodeRegistryCalldata(tx.data as Hex);
  if (call === null) return { ok: false, reason: 'CALLDATA' };
  if (
    typeof tx.nonce !== 'number' ||
    typeof tx.gas !== 'bigint' ||
    typeof tx.maxFeePerGas !== 'bigint' ||
    typeof tx.maxPriorityFeePerGas !== 'bigint'
  ) {
    return { ok: false, reason: 'FIELDS_MISSING' };
  }
  return { ok: true, call };
}

export interface DecodedSignedTransaction {
  readonly sender: Hex;
  readonly hash: Hex;
  readonly transaction: TransactionSerializableEIP1559;
  readonly call: RegistryCall;
}

/**
 * Decodes a complete raw signed transaction, recovers its signer and applies the scope check.
 * The hash is keccak256 of the raw bytes. Nothing here trusts a client-supplied sender or hash.
 */
export async function decodeSignedRegistryTransaction(
  raw: string,
  scope: RegistryTxScope,
): Promise<
  | ({ readonly ok: true } & DecodedSignedTransaction)
  | { readonly ok: false; readonly reason: RegistryTxRejection }
> {
  if (!/^0x(?:[0-9a-f]{2})+$/.test(raw)) return { ok: false, reason: 'MALFORMED' };
  if ((raw.length - 2) / 2 > REGISTRY_TX_BYTE_LIMIT) return { ok: false, reason: 'TOO_LARGE' };
  // Only type-2 envelopes: the first byte is 0x02, never a legacy RLP list or 0x04 (EIP-7702).
  if (!raw.startsWith('0x02')) return { ok: false, reason: 'NOT_TYPE_2' };
  try {
    const parsed = parseTransaction(raw as Hex);
    const scoped = checkRegistryTransaction(parsed, scope);
    if (!scoped.ok) return scoped;
    if (parsed.type !== 'eip1559' || parsed.r === undefined || parsed.s === undefined) {
      return { ok: false, reason: 'MALFORMED' };
    }
    const sender = await recoverTransactionAddress({
      serializedTransaction: raw as `0x02${string}`,
    });
    return {
      ok: true,
      sender: sender.toLowerCase() as Hex,
      hash: keccak256(raw as Hex),
      transaction: parsed,
      call: scoped.call,
    };
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
}
