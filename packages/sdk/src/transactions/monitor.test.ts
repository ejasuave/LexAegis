import { keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { ChainPolicy } from '../registry/live-reader';
import {
  monitorTransaction,
  observeTransaction,
  type ChainReceiptView,
  type ChainTransactionView,
  type MonitorClient,
  type MonitorTarget,
} from './monitor';

/* Deterministic RPC simulation (not a live chain) of receipt lag, speculative blocks and reorgs. */

const REGISTRY: Hex = `0x${'ab'.repeat(20)}`;
const SENDER: Hex = `0x${'01'.repeat(20)}`;
const RECIPIENT: Hex = `0x${'02'.repeat(20)}`;
const HASH = keccak256('0x01');
const policy: ChainPolicy = {
  chainId: '10143',
  registryAddress: REGISTRY,
  deploymentBlock: '1',
  runtimeCodeKeccak256: keccak256('0x00'),
  executionDelayBlocks: 3,
  executionDelayRevision: 'test',
};
const target: MonitorTarget = {
  hash: HASH,
  sender: SENDER,
  transactionNonce: 5n,
  intent: { kind: 'transfer', recipient: RECIPIENT, valueWei: 1000n },
};
const hashOf = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const tx: ChainTransactionView = {
  hash: HASH,
  from: SENDER,
  to: RECIPIENT,
  nonce: 5n,
  value: 1000n,
  input: '0x',
  gas: 21_000n,
  blockNumber: 50n,
};
const receipt = (over: Partial<ChainReceiptView> = {}): ChainReceiptView => ({
  transactionHash: HASH,
  from: SENDER,
  to: RECIPIENT,
  status: 'success',
  blockNumber: 50n,
  blockHash: hashOf(50n),
  effectiveGasPrice: 100n,
  gasUsed: 21_000n,
  logs: [],
  ...over,
});

interface World {
  tx: ChainTransactionView | null;
  receipt: ChainReceiptView | null;
  finalized: bigint;
  count: bigint;
  hashAt: (n: bigint) => Hex;
}
function client(world: World): MonitorClient {
  return {
    getChainId: () => Promise.resolve(10143),
    getBlock: (s) =>
      Promise.resolve(
        'blockTag' in s
          ? { number: world.finalized, hash: hashOf(world.finalized), timestamp: 1n }
          : { number: s.blockNumber, hash: world.hashAt(s.blockNumber), timestamp: 1n },
      ),
    getCode: () => Promise.resolve('0x'),
    call: () => Promise.resolve('0x'),
    getTransaction: () => Promise.resolve(world.tx),
    getTransactionReceipt: () => Promise.resolve(world.receipt),
    getTransactionCount: () => Promise.resolve(world.count),
    getBalance: () => Promise.resolve(0n),
  };
}
const world = (over: Partial<World> = {}): World => ({
  tx,
  receipt: receipt(),
  finalized: 60n,
  count: 6n,
  hashAt: hashOf,
  ...over,
});
const observe = (w: World, extra: Partial<Parameters<typeof observeTransaction>[0]> = {}) =>
  observeTransaction(
    { client: client(w), policy, now: () => new Date('2026-10-09T00:00:00Z'), ...extra },
    target,
  );

describe('[chain-outage-and-inconsistent-observations] transaction outcomes', () => {
  it('confirms only when the block is covered by the execution checkpoint', async () => {
    expect(await observe(world({ finalized: 60n }))).toMatchObject({
      outcome: 'confirmed',
      chargedFeeWei: '2100000',
    });
    // Finalized at 52 puts the checkpoint at 49: block 50 is executed-but-not-covered.
    expect(await observe(world({ finalized: 52n }))).toMatchObject({ outcome: 'included' });
  });

  it('classifies missing receipts without claiming the transaction was never sent', async () => {
    expect(await observe(world({ receipt: null }))).toMatchObject({ outcome: 'pending' });
    expect(await observe(world({ receipt: null, tx: null, count: 5n }))).toMatchObject({
      outcome: 'submitted',
    });
    // The nonce advanced and no evidence of the replacement exists: unknown, never success.
    expect(await observe(world({ receipt: null, tx: null, count: 6n }))).toMatchObject({
      outcome: 'unknown',
      mismatch: 'REPLACEMENT_UNESTABLISHED',
    });
  });

  it('reports a revert with its charged fee', async () => {
    expect(await observe(world({ receipt: receipt({ status: 'reverted' }) }))).toMatchObject({
      outcome: 'reverted',
      chargedFeeWei: '2100000',
    });
  });

  it('keeps a pre-confirmation reorganisation unresolved and flags a contradiction after confirmation', async () => {
    const reorganised = world({ hashAt: () => hashOf(777n) });
    expect(await observe(reorganised)).toMatchObject({
      outcome: 'pending',
      mismatch: 'NOT_CANONICAL',
    });
    expect(await observe(reorganised, { previouslyConfirmedBlockHash: hashOf(50n) })).toMatchObject(
      {
        outcome: 'pending',
        mismatch: 'CONTRADICTS_CONFIRMED',
      },
    );
    expect(await observe(world(), { previouslyConfirmedBlockHash: hashOf(51n) })).toMatchObject({
      outcome: 'unknown',
      mismatch: 'CONTRADICTS_CONFIRMED',
    });
  });

  it('does not accept a receipt for the wrong sender, recipient or value', async () => {
    expect(await observe(world({ receipt: receipt({ from: RECIPIENT }) }))).toMatchObject({
      outcome: 'unknown',
    });
    expect(await observe(world({ receipt: receipt({ to: SENDER }) }))).toMatchObject({
      outcome: 'unknown',
    });
    expect(await observe(world({ tx: { ...tx, value: 1n } }))).toMatchObject({
      outcome: 'unknown',
      mismatch: 'RECEIPT_FIELDS',
    });
  });

  it('is unknown when the RPC fails', async () => {
    const broken = client(world());
    broken.getTransaction = () => Promise.reject(new Error('timeout'));
    expect(await observeTransaction({ client: broken, policy }, target)).toMatchObject({
      outcome: 'unknown',
      mismatch: 'RPC_UNAVAILABLE',
    });
  });
});

describe('bounded monitoring', () => {
  it('polls with backoff and returns unresolved after the deadline instead of waiting forever', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const result = await monitorTransaction(
      { client: client(world({ receipt: null })), policy },
      target,
      {
        sleep: (ms) => {
          sleeps.push(ms);
          now += ms;
          return Promise.resolve();
        },
        clock: () => now,
        deadlineMs: 20_000,
      },
    );
    expect(result.resolved).toBe(false);
    expect(result.observation.outcome).toBe('pending');
    expect(sleeps[0]).toBe(2000);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(10_000);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(20_000);
  });

  it('stops as soon as the transaction is confirmed', async () => {
    const result = await monitorTransaction({ client: client(world()), policy }, target, {
      sleep: () => Promise.resolve(),
    });
    expect(result).toMatchObject({ resolved: true, observation: { outcome: 'confirmed' } });
  });
});
