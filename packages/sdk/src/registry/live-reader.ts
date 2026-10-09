import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  type Hex,
  type PublicClient,
} from 'viem';
import { z } from 'zod';
import {
  chainIdSchema,
  digestSchema,
  nonZeroAddressSchema,
  type ReceiptReferenceV1,
} from '@lexaegis/protocol/v1';
import { REGISTRY_PROTOCOL_VERSION } from './constants';
import { decodeReceipt, type ObservedReceipt } from './decode';
import { proofOfReviewRegistryAbi } from './generated/registry-abi';
import { validateReceiptBinding, type ReceiptBinding } from './binding';
import { uint256DecimalSchema } from './typed-data';

/*
 * Framework-neutral live registry reads. The caller supplies the client, the chain, the registry
 * and the deployment policy; nothing here imports Next.js, credentials, Mera or the vault.
 *
 * Results rely on the selected RPC provider. They are not a light-client proof and say nothing
 * about legal correctness or professional identity of the reviewer.
 */

/** Monad executes a block's transactions this many blocks after consensus on it. */
export const MONAD_EXECUTION_DELAY_BLOCKS = 3;
/** Documentation revision the delay was validated against (https://docs.monad.xyz, testnet). */
export const MONAD_EXECUTION_DELAY_REVISION =
  'docs.monad.xyz/monad-arch/consensus/block-states@2026-10';

export const chainPolicySchema = z.strictObject({
  chainId: chainIdSchema,
  registryAddress: nonZeroAddressSchema,
  deploymentBlock: uint256DecimalSchema,
  /** keccak256 of the deployed runtime code, observed and recorded at deployment. */
  runtimeCodeKeccak256: digestSchema,
  executionDelayBlocks: z.number().int().min(0).max(64),
  executionDelayRevision: z.string().min(1).max(200),
});
export type ChainPolicy = z.infer<typeof chainPolicySchema>;

export const chainCheckpointSchema = z.strictObject({
  chainId: chainIdSchema,
  finalizedHeight: uint256DecimalSchema,
  blockNumber: uint256DecimalSchema,
  blockHash: digestSchema,
  blockTimestamp: uint256DecimalSchema,
  executionDelayBlocks: z.number().int().min(0).max(64),
  executionDelayRevision: z.string().min(1).max(200),
  /** How the state read was pinned. */
  pinning: z.enum(['block_number_with_hash_recheck']),
  observedAt: z.iso.datetime(),
});
export type ChainCheckpoint = z.infer<typeof chainCheckpointSchema>;

export const LIVE_UNKNOWN_REASONS = [
  'RPC_UNAVAILABLE',
  'WRONG_CHAIN',
  'FINALIZED_UNAVAILABLE',
  'BELOW_DEPLOYMENT',
  'CODE_MISMATCH',
  'PROTOCOL_MISMATCH',
  'BLOCK_CHANGED',
  'RESPONSE_INVALID',
  'POLICY_INVALID',
] as const;
export type LiveUnknownReason = (typeof LIVE_UNKNOWN_REASONS)[number];

export type LiveResult<T> =
  | { readonly status: 'ok'; readonly data: T }
  | { readonly status: 'unknown'; readonly reason: LiveUnknownReason };

const unknownResult = (reason: LiveUnknownReason): LiveResult<never> => ({
  status: 'unknown',
  reason,
});

export interface LiveBlock {
  readonly number: bigint;
  readonly hash: Hex;
  readonly timestamp: bigint;
}

/** The only reads the live reader needs. A viem client adapts through `liveClientFromViem`. */
export interface LiveChainClient {
  getChainId(): Promise<number>;
  getBlock(
    selector: { readonly blockTag: 'finalized' | 'latest' } | { readonly blockNumber: bigint },
  ): Promise<LiveBlock | null>;
  getCode(args: { readonly address: Hex; readonly blockNumber: bigint }): Promise<Hex | undefined>;
  call(args: {
    readonly to: Hex;
    readonly data: Hex;
    readonly blockNumber?: bigint;
  }): Promise<Hex | undefined>;
}

export function liveClientFromViem(client: PublicClient): LiveChainClient {
  return {
    getChainId: () => client.getChainId(),
    async getBlock(selector) {
      const block = await client.getBlock(
        'blockTag' in selector
          ? { blockTag: selector.blockTag, includeTransactions: false }
          : { blockNumber: selector.blockNumber, includeTransactions: false },
      );
      const { number, hash } = block as { number: bigint | null; hash: Hex | null };
      if (number === null || hash === null) return null;
      return { number, hash, timestamp: block.timestamp };
    },
    getCode: ({ address, blockNumber }) => client.getCode({ address, blockNumber }),
    async call({ to, data, blockNumber }) {
      const result = await client.call({
        to,
        data,
        ...(blockNumber !== undefined && { blockNumber }),
      });
      return result.data;
    },
  };
}

function parsePolicy(policy: unknown): ChainPolicy | null {
  const parsed = chainPolicySchema.safeParse(policy);
  return parsed.success ? parsed.data : null;
}

const toHex32 = (value: Hex): string => value.toLowerCase();

/**
 * Builds a ChainCheckpoint from the actual finalized block: the selected read height is
 * `finalized - executionDelayBlocks`, and never before the deployment block. A missing
 * finalized tag, wrong chain or unreadable block is "unknown"; it never falls back to latest.
 */
export async function readChainCheckpoint(
  client: LiveChainClient,
  policyInput: ChainPolicy,
  now: () => Date,
): Promise<LiveResult<ChainCheckpoint>> {
  const policy = parsePolicy(policyInput);
  if (policy === null) return unknownResult('POLICY_INVALID');
  try {
    if (String(await client.getChainId()) !== policy.chainId) return unknownResult('WRONG_CHAIN');
    const finalized = await client.getBlock({ blockTag: 'finalized' });
    if (finalized === null) return unknownResult('FINALIZED_UNAVAILABLE');
    const selected = finalized.number - BigInt(policy.executionDelayBlocks);
    if (selected < 0n || selected < BigInt(policy.deploymentBlock)) {
      return unknownResult('BELOW_DEPLOYMENT');
    }
    const block = await client.getBlock({ blockNumber: selected });
    if (block === null || block.number !== selected) return unknownResult('RESPONSE_INVALID');
    const checkpoint = chainCheckpointSchema.safeParse({
      chainId: policy.chainId,
      finalizedHeight: finalized.number.toString(),
      blockNumber: block.number.toString(),
      blockHash: toHex32(block.hash),
      blockTimestamp: block.timestamp.toString(),
      executionDelayBlocks: policy.executionDelayBlocks,
      executionDelayRevision: policy.executionDelayRevision,
      pinning: 'block_number_with_hash_recheck',
      observedAt: now().toISOString(),
    });
    return checkpoint.success
      ? { status: 'ok', data: checkpoint.data }
      : unknownResult('RESPONSE_INVALID');
  } catch {
    return unknownResult('RPC_UNAVAILABLE');
  }
}

export interface LiveReceiptRead {
  readonly checkpoint: ChainCheckpoint;
  readonly receipt: ObservedReceipt;
  /** The reviewer's registry action nonce at the checkpoint. Not an EOA transaction nonce. */
  readonly registryNonce: string;
  /** Present only when an independently verified opening was supplied. */
  readonly binding: ReceiptBinding | null;
}

const abi = proofOfReviewRegistryAbi;

/** Reads code, protocolVersion, nonceOf and getReceipt at one verified block. */
async function readRegistryGroup(
  client: LiveChainClient,
  policy: ChainPolicy,
  blockNumber: bigint,
  reviewer: Hex,
  commitment: Hex,
): Promise<LiveResult<{ receiptData: Hex; nonce: bigint }>> {
  const registry = policy.registryAddress as Hex;
  const code = await client.getCode({ address: registry, blockNumber });
  if (code === undefined || code === '0x') return unknownResult('CODE_MISMATCH');
  if (keccak256(code) !== policy.runtimeCodeKeccak256) return unknownResult('CODE_MISMATCH');

  const versionData = await client.call({
    to: registry,
    data: encodeFunctionData({ abi, functionName: 'protocolVersion' }),
    blockNumber,
  });
  if (versionData === undefined) return unknownResult('RESPONSE_INVALID');
  const version = decodeFunctionResult({ abi, functionName: 'protocolVersion', data: versionData });
  if (version.toString() !== REGISTRY_PROTOCOL_VERSION) return unknownResult('PROTOCOL_MISMATCH');

  const nonceData = await client.call({
    to: registry,
    data: encodeFunctionData({ abi, functionName: 'nonceOf', args: [reviewer] }),
    blockNumber,
  });
  const receiptData = await client.call({
    to: registry,
    data: encodeFunctionData({ abi, functionName: 'getReceipt', args: [reviewer, commitment] }),
    blockNumber,
  });
  if (nonceData === undefined || receiptData === undefined)
    return unknownResult('RESPONSE_INVALID');
  const nonce = decodeFunctionResult({ abi, functionName: 'nonceOf', data: nonceData });
  return { status: 'ok', data: { receiptData, nonce } };
}

/**
 * Confirmed live verification of one receipt at the execution checkpoint. The block's hash is
 * rechecked after the read group; any change returns unknown. `not_found` is returned only for a
 * successful, validated NotFound record at the verified deployment.
 */
export async function readLiveReceipt(
  client: LiveChainClient,
  policyInput: ChainPolicy,
  input: {
    readonly reference: ReceiptReferenceV1;
    /** An independently verified opening. It is used locally and never sent to RPC. */
    readonly opening?: unknown;
  },
  now: () => Date = () => new Date(),
): Promise<LiveResult<LiveReceiptRead>> {
  const policy = parsePolicy(policyInput);
  if (policy === null) return unknownResult('POLICY_INVALID');
  if (
    input.reference.chainId !== policy.chainId ||
    input.reference.registryAddress !== policy.registryAddress
  ) {
    return unknownResult('POLICY_INVALID');
  }
  const checkpoint = await readChainCheckpoint(client, policy, now);
  if (checkpoint.status !== 'ok') return checkpoint;
  const blockNumber = BigInt(checkpoint.data.blockNumber);
  try {
    const group = await readRegistryGroup(
      client,
      policy,
      blockNumber,
      input.reference.reviewerAddress as Hex,
      input.reference.commitment as Hex,
    );
    if (group.status !== 'ok') return group;
    const after = await client.getBlock({ blockNumber });
    if (after === null || toHex32(after.hash) !== checkpoint.data.blockHash) {
      return unknownResult('BLOCK_CHANGED');
    }
    const receipt = decodeReceipt(input.reference, group.data.receiptData);
    if (!receipt.ok) return unknownResult('RESPONSE_INVALID');
    let binding: ReceiptBinding | null = null;
    if (input.opening !== undefined) {
      const bound = validateReceiptBinding({
        opening: input.opening,
        reference: input.reference,
        observed: receipt.data,
      });
      if (!bound.ok) return unknownResult('RESPONSE_INVALID');
      binding = bound.data;
    }
    return {
      status: 'ok',
      data: {
        checkpoint: checkpoint.data,
        receipt: receipt.data,
        registryNonce: group.data.nonce.toString(),
        binding,
      },
    };
  } catch {
    return unknownResult('RPC_UNAVAILABLE');
  }
}

export interface ProvisionalState {
  /** Never merge this with a confirmed result. It exists for transaction preparation only. */
  readonly label: 'provisional_latest';
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly blockTimestamp: string;
  readonly registryNonce: string;
  readonly receipt: ObservedReceipt;
  readonly observedAt: string;
}

/** Latest-state read for preparing a transaction. Refresh it before every important action. */
export async function readProvisionalState(
  client: LiveChainClient,
  policyInput: ChainPolicy,
  reference: ReceiptReferenceV1,
  now: () => Date = () => new Date(),
): Promise<LiveResult<ProvisionalState>> {
  const policy = parsePolicy(policyInput);
  if (policy === null) return unknownResult('POLICY_INVALID');
  try {
    if (String(await client.getChainId()) !== policy.chainId) return unknownResult('WRONG_CHAIN');
    const head = await client.getBlock({ blockTag: 'latest' });
    if (head === null) return unknownResult('RESPONSE_INVALID');
    if (head.number < BigInt(policy.deploymentBlock)) return unknownResult('BELOW_DEPLOYMENT');
    const group = await readRegistryGroup(
      client,
      policy,
      head.number,
      reference.reviewerAddress as Hex,
      reference.commitment as Hex,
    );
    if (group.status !== 'ok') return group;
    const receipt = decodeReceipt(reference, group.data.receiptData);
    if (!receipt.ok) return unknownResult('RESPONSE_INVALID');
    return {
      status: 'ok',
      data: {
        label: 'provisional_latest',
        blockNumber: head.number.toString(),
        blockHash: toHex32(head.hash),
        blockTimestamp: head.timestamp.toString(),
        registryNonce: group.data.nonce.toString(),
        receipt: receipt.data,
        observedAt: now().toISOString(),
      },
    };
  } catch {
    return unknownResult('RPC_UNAVAILABLE');
  }
}
