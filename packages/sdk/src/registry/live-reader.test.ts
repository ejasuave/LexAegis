import { encodeAbiParameters, encodeFunctionData, keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import { proofOfReviewRegistryAbi } from './generated/registry-abi';
import {
  readChainCheckpoint,
  readLiveReceipt,
  readProvisionalState,
  type ChainPolicy,
  type LiveBlock,
  type LiveChainClient,
} from './live-reader';

/* Deterministic RPC simulation (not a live chain): shows how failures and lag are classified. */

const REGISTRY = `0x${'ab'.repeat(20)}`;
const CODE = '0x6001600155' as Hex;
const REVIEWER = `0x${'cd'.repeat(20)}`;
const COMMITMENT = `0x${'11'.repeat(32)}`;
const reference = {
  schema: 'lexaegis.receipt-ref.v1',
  chainId: '10143',
  registryAddress: REGISTRY,
  reviewerAddress: REVIEWER,
  commitment: COMMITMENT,
} as ReceiptReferenceV1;
const policy: ChainPolicy = {
  chainId: '10143',
  registryAddress: REGISTRY,
  deploymentBlock: '10',
  runtimeCodeKeccak256: keccak256(CODE),
  executionDelayBlocks: 3,
  executionDelayRevision: 'test-revision',
};
const now = () => new Date('2026-10-09T12:00:00Z');
const hashOf = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const block = (n: bigint): LiveBlock => ({
  number: n,
  hash: hashOf(n),
  timestamp: 1_800_000_000n + n,
});

const receiptWords = (
  status: bigint,
  predecessor = 0n,
  successor = 0n,
  issued = 0n,
  updated = 0n,
) =>
  encodeAbiParameters(
    [
      { type: 'uint8' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'uint256' },
      { type: 'uint256' },
    ],
    [Number(status), hashOf(predecessor), hashOf(successor), issued, updated],
  );

function fake(
  overrides: Partial<LiveChainClient> & { receipt?: Hex; finalized?: bigint | null } = {},
) {
  const finalized = overrides.finalized === undefined ? 100n : overrides.finalized;
  const calls: string[] = [];
  const client: LiveChainClient = {
    getChainId: () => Promise.resolve(10143),
    getBlock: (selector) => {
      if ('blockTag' in selector) {
        calls.push(selector.blockTag);
        return Promise.resolve(
          selector.blockTag === 'finalized'
            ? finalized === null
              ? null
              : block(finalized)
            : block(120n),
        );
      }
      calls.push(`block:${selector.blockNumber}`);
      return Promise.resolve(block(selector.blockNumber));
    },
    getCode: () => Promise.resolve(CODE),
    call: ({ data }) => {
      const selector = data.slice(0, 10);
      const sel = (name: 'protocolVersion' | 'nonceOf' | 'getReceipt') =>
        encodeFunctionData({
          abi: proofOfReviewRegistryAbi,
          functionName: name,
          args:
            name === 'protocolVersion'
              ? undefined
              : name === 'nonceOf'
                ? [REVIEWER as Hex]
                : [REVIEWER as Hex, COMMITMENT as Hex],
        }).slice(0, 10);
      if (selector === sel('protocolVersion'))
        return Promise.resolve(encodeAbiParameters([{ type: 'uint256' }], [1n]));
      if (selector === sel('nonceOf'))
        return Promise.resolve(encodeAbiParameters([{ type: 'uint256' }], [4n]));
      return Promise.resolve(overrides.receipt ?? receiptWords(0n));
    },
    ...overrides,
  };
  return { client, calls };
}

describe('chain checkpoint', () => {
  it('reads at finalized minus the validated execution delay, never at latest', async () => {
    const { client, calls } = fake();
    const result = await readChainCheckpoint(client, policy, now);
    expect(result).toMatchObject({
      status: 'ok',
      data: { finalizedHeight: '100', blockNumber: '97', executionDelayBlocks: 3 },
    });
    expect(calls).not.toContain('latest');
  });

  it('is unknown, not a fallback, without a finalized block, on the wrong chain or before deployment', async () => {
    expect(await readChainCheckpoint(fake({ finalized: null }).client, policy, now)).toEqual({
      status: 'unknown',
      reason: 'FINALIZED_UNAVAILABLE',
    });
    expect(
      await readChainCheckpoint(
        fake({ getChainId: () => Promise.resolve(143) }).client,
        policy,
        now,
      ),
    ).toEqual({ status: 'unknown', reason: 'WRONG_CHAIN' });
    expect(await readChainCheckpoint(fake({ finalized: 12n }).client, policy, now)).toEqual({
      status: 'unknown',
      reason: 'BELOW_DEPLOYMENT',
    });
    expect(
      await readChainCheckpoint(
        fake({ getChainId: () => Promise.reject(new Error('down')) }).client,
        policy,
        now,
      ),
    ).toEqual({ status: 'unknown', reason: 'RPC_UNAVAILABLE' });
  });
});

describe('live receipt', () => {
  it('returns not_found only for a validated NotFound record at the verified deployment', async () => {
    const read = await readLiveReceipt(fake().client, policy, { reference }, now);
    expect(read).toMatchObject({
      status: 'ok',
      data: { receipt: { receiptLifecycle: 'not_found' }, registryNonce: '4', binding: null },
    });
  });

  it('never reports not_found when the read failed or the deployment does not match', async () => {
    const down = fake({ call: () => Promise.reject(new Error('rate limited')) }).client;
    expect(await readLiveReceipt(down, policy, { reference }, now)).toEqual({
      status: 'unknown',
      reason: 'RPC_UNAVAILABLE',
    });
    const noCode = fake({ getCode: () => Promise.resolve('0x') as never }).client;
    expect(await readLiveReceipt(noCode, policy, { reference }, now)).toEqual({
      status: 'unknown',
      reason: 'CODE_MISMATCH',
    });
    const wrongCode = fake({ getCode: () => Promise.resolve('0x6002' as Hex) }).client;
    expect(await readLiveReceipt(wrongCode, policy, { reference }, now)).toEqual({
      status: 'unknown',
      reason: 'CODE_MISMATCH',
    });
    const empty = fake({ receipt: '0x' }).client;
    expect(await readLiveReceipt(empty, policy, { reference }, now)).toEqual({
      status: 'unknown',
      reason: 'RESPONSE_INVALID',
    });
  });

  it('is unknown when the selected block changes during the read group (reorganisation)', async () => {
    let reads = 0;
    const base = fake();
    const client: LiveChainClient = {
      ...base.client,
      getBlock: (selector) => {
        if ('blockNumber' in selector) {
          reads += 1;
          return Promise.resolve(
            reads === 1
              ? block(selector.blockNumber)
              : { ...block(selector.blockNumber), hash: hashOf(999n) },
          );
        }
        return base.client.getBlock(selector);
      },
    };
    expect(await readLiveReceipt(client, policy, { reference }, now)).toEqual({
      status: 'unknown',
      reason: 'BLOCK_CHANGED',
    });
  });

  it('refuses a reference for a different registry', async () => {
    const other = { ...reference, registryAddress: `0x${'ee'.repeat(20)}` } as ReceiptReferenceV1;
    expect(await readLiveReceipt(fake().client, policy, { reference: other }, now)).toEqual({
      status: 'unknown',
      reason: 'POLICY_INVALID',
    });
  });
});

describe('provisional state', () => {
  it('is labelled provisional and read at the latest block', async () => {
    const read = await readProvisionalState(fake().client, policy, reference, now);
    expect(read).toMatchObject({
      status: 'ok',
      data: { label: 'provisional_latest', blockNumber: '120', registryNonce: '4' },
    });
  });
});
