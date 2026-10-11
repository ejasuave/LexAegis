/** Test-only. A scripted registry behind LiveChainClient: deterministic RPC simulation, not a chain. */
import { decodeFunctionData, encodeAbiParameters, keccak256, type Hex } from 'viem';
import type { ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import { proofOfReviewRegistryAbi } from '../registry/generated/registry-abi';
import type { LiveBlock, LiveChainClient } from '../registry/live-reader';
import { protocolCase } from '../registry/test-helpers';
import type { RegistryPolicy } from './report';

export const SCRIPT_CODE = '0x6001600155' as Hex;
export const hashOf = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;
export const block = (n: bigint): LiveBlock => ({
  number: n,
  hash: hashOf(n),
  timestamp: 1_800_000_000n + n,
});

export interface ScriptedRecord {
  readonly status: 0 | 1 | 2 | 3;
  readonly predecessor?: string;
  readonly successor?: string;
  readonly issuedAt?: bigint;
  readonly updatedAt?: bigint;
}

const ZERO = hashOf(0n);

export interface Scripted {
  readonly client: LiveChainClient;
  /** Every JSON-RPC-level call the verifier made, by kind. */
  readonly calls: string[];
}

export function scriptedRegistry(
  records: Readonly<Record<string, ScriptedRecord>>,
  options: {
    readonly chainId?: number;
    readonly genesis?: Hex;
    readonly code?: Hex;
    readonly finalized?: bigint | null;
    readonly fail?: boolean;
    readonly delayMs?: number;
    /** What protocolVersion() reports. */
    readonly protocolVersion?: bigint;
    /** The block at a given number answers with a different hash on its second read (reorganisation). */
    readonly reorganise?: boolean;
    /** Historical state reads (getCode / call at an explicit block) are refused, as on a pruned node. */
    readonly refuseHistorical?: boolean;
    /** A raw status word the registry returns instead of a valid enum value. */
    readonly rawStatus?: bigint;
  } = {},
): Scripted {
  const calls: string[] = [];
  const reads = new Map<bigint, number>();
  const finalized = options.finalized === undefined ? 100n : options.finalized;
  const wait = <T>(value: T): Promise<T> =>
    options.fail === true
      ? Promise.reject(new Error('down'))
      : options.delayMs === undefined
        ? Promise.resolve(value)
        : new Promise((resolve) => setTimeout(() => resolve(value), options.delayMs));
  const client: LiveChainClient = {
    getChainId: () => {
      calls.push('chainId');
      return wait(options.chainId ?? 31337);
    },
    getBlock: (selector) => {
      if ('blockTag' in selector) {
        calls.push(`tag:${selector.blockTag}`);
        return wait(finalized === null ? null : block(finalized));
      }
      calls.push(`block:${selector.blockNumber}`);
      const seen = (reads.get(selector.blockNumber) ?? 0) + 1;
      reads.set(selector.blockNumber, seen);
      const found =
        options.reorganise === true && seen > 1 && selector.blockNumber !== 0n
          ? { ...block(selector.blockNumber), hash: hashOf(0xdeadn) }
          : block(selector.blockNumber);
      return wait(
        selector.blockNumber === 0n && options.genesis !== undefined
          ? { ...found, hash: options.genesis }
          : found,
      );
    },
    getCode: () => {
      calls.push('code');
      if (options.refuseHistorical === true) return Promise.reject(new Error('missing trie node'));
      return wait(options.code ?? SCRIPT_CODE);
    },
    call: ({ data }) => {
      const decoded = decodeFunctionData({ abi: proofOfReviewRegistryAbi, data });
      calls.push(decoded.functionName);
      if (options.refuseHistorical === true) return Promise.reject(new Error('missing trie node'));
      if (decoded.functionName === 'protocolVersion')
        return wait(encodeAbiParameters([{ type: 'uint256' }], [options.protocolVersion ?? 1n]));
      if (decoded.functionName === 'nonceOf')
        return wait(encodeAbiParameters([{ type: 'uint256' }], [3n]));
      const [, commitment] = decoded.args as readonly [Hex, Hex];
      const record = records[commitment] ?? { status: 0 };
      return wait(
        encodeAbiParameters(
          [
            { type: 'uint8' },
            { type: 'bytes32' },
            { type: 'bytes32' },
            { type: 'uint256' },
            { type: 'uint256' },
          ],
          [
            options.rawStatus === undefined
              ? record.status
              : (options.rawStatus as unknown as number),
            (record.predecessor ?? ZERO) as Hex,
            (record.successor ?? ZERO) as Hex,
            record.status === 0 ? 0n : (record.issuedAt ?? 1_800_000_001n),
            record.status === 0 ? 0n : (record.updatedAt ?? record.issuedAt ?? 1_800_000_001n),
          ],
        ),
      );
    },
  };
  return { client, calls };
}

/** The policy matching the scripted registry and the Chapter 2 literal vectors' reference. */
export function scriptedPolicy(overrides: Partial<RegistryPolicy> = {}): RegistryPolicy {
  const reference = protocolCase('legal').expected.reference;
  return {
    id: 'test.scripted-registry',
    chainId: reference.chainId,
    genesisHash: hashOf(0n),
    registryAddress: reference.registryAddress,
    protocolVersion: '1',
    deploymentBlock: '10',
    deploymentTransactionHash: hashOf(7n),
    runtimeCodeKeccak256: keccak256(SCRIPT_CODE),
    executionDelayBlocks: 3,
    executionDelayRevision: 'test-revision',
    ...overrides,
  };
}

export const caseReference = (id: 'generic' | 'legal' | 'legal-revised'): ReceiptReferenceV1 =>
  protocolCase(id).expected.reference;
