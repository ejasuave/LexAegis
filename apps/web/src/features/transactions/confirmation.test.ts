import { describe, expect, it } from 'vitest';
import type { RegistryTransactionSigning, SignedReviewAction } from '@/features/account/public';
import type { ChainApi, OperationView } from './api-client';
import { verifyConfirmation, type ConfirmationSignal } from './confirmation';
import { TransactionController } from './controller';

const REVIEWER = `0x${'ab'.repeat(20)}`;
const REGISTRY = `0x${'cd'.repeat(20)}`;
const COMMITMENT = `0x${'11'.repeat(32)}`;
const HASH = `0x${'44'.repeat(32)}`;
const scope = { chainId: '10143', registryAddress: REGISTRY };

const operation = (patch: Partial<OperationView> = {}): OperationView => ({
  operationId: '11111111-1111-4111-8111-111111111111',
  kind: 'execute',
  phase: 'confirmed',
  account: REVIEWER,
  commitment: COMMITMENT,
  registryNonce: '7',
  transactionNonce: '4',
  transactionHash: HASH,
  blockNumber: '1234',
  chargedFeeWei: '10',
  executedViaAnotherTransaction: false,
  ...patch,
});

const authorisation = (patch: Record<string, unknown> = {}) =>
  ({
    signature: `0x${'55'.repeat(65)}`,
    action: {
      chainId: '10143',
      registryAddress: REGISTRY,
      action: { reviewer: REVIEWER, commitment: COMMITMENT, nonce: 7n, ...patch },
    },
  }) as unknown as SignedReviewAction;

const expected = {
  chainId: '10143',
  registryAddress: REGISTRY,
  reviewer: REVIEWER,
  commitment: COMMITMENT,
  nonce: '7',
};

describe('verifyConfirmation', () => {
  it('accepts only a confirmed, own, fully bound execution', () => {
    const signal = verifyConfirmation(operation(), expected, scope);
    expect(signal?.kind).toBe('confirmed');
    expect(signal?.id).toBe(`10143:${REGISTRY}:${HASH}`);
  });

  it.each([
    ['pending', { phase: 'pending' as const }],
    ['included but not confirmed', { phase: 'included' as const }],
    ['reverted', { phase: 'reverted' as const }],
    ['unknown', { phase: 'unknown' as const }],
    ['executed via another transaction', { executedViaAnotherTransaction: true }],
    ['no transaction hash', { transactionHash: null }],
    ['no block', { blockNumber: null }],
    ['malformed hash', { transactionHash: '0x12' }],
    ['another reviewer', { account: `0x${'ee'.repeat(20)}` }],
    ['another commitment', { commitment: `0x${'22'.repeat(32)}` }],
    ['another registry nonce', { registryNonce: '8' }],
    ['a nonce invalidation', { kind: 'invalidate_nonce' as const }],
  ])('emits nothing for %s', (_name, patch) => {
    expect(verifyConfirmation(operation(patch), expected, scope)).toBeNull();
  });

  it('emits nothing without the signed action or without a configured scope', () => {
    expect(verifyConfirmation(operation(), null, scope)).toBeNull();
    expect(verifyConfirmation(operation(), expected, null)).toBeNull();
    expect(verifyConfirmation(operation(), expected, { ...scope, chainId: '1' })).toBeNull();
    expect(
      verifyConfirmation(operation(), expected, {
        ...scope,
        registryAddress: `0x${'99'.repeat(20)}`,
      }),
    ).toBeNull();
  });
});

function rig(phases: OperationView['phase'][], options: { signed?: boolean } = {}) {
  const queue = [...phases];
  const api: ChainApi = {
    create: () =>
      Promise.resolve({
        ok: true,
        data: {
          operation: operation({ phase: 'reserved', transactionHash: null, blockNumber: null }),
        },
      }),
    quote: () =>
      Promise.resolve({
        ok: true,
        data: {
          quote: {
            operationId: operation().operationId,
            account: REVIEWER,
            chainId: '10143',
            registryAddress: REGISTRY,
            calldataHash: `0x${'22'.repeat(32)}`,
            actionDigest: `0x${'33'.repeat(32)}`,
            transactionNonce: '4',
            gasLimit: '1',
            maxFeePerGas: '1',
            maxPriorityFeePerGas: '1',
            maxFeeWei: '1',
            expectedFeeWei: '1',
            expiresAt: '2026-10-11T10:00:30.000Z',
          },
          operation: operation({ phase: 'quoted', transactionHash: null, blockNumber: null }),
        },
      }),
    submit: () =>
      Promise.resolve({
        ok: true,
        data: {
          operation: operation({ phase: 'pending', blockNumber: null }),
          transactionHash: HASH,
        },
      }),
    refresh: () =>
      Promise.resolve({
        ok: true,
        data: { operation: operation({ phase: queue.shift() ?? 'confirmed' }) },
      }),
    listUnresolved: () =>
      Promise.resolve({ ok: true, data: { operations: [operation({ phase: 'confirmed' })] } }),
  };
  const signing = {
    preview: () => ({
      ok: true,
      data: {
        preview: {
          operationId: operation().operationId,
          kind: 'execute',
          account: REVIEWER,
          chainId: '10143',
          destination: REGISTRY,
          calldata: '0x',
          calldataHash: `0x${'22'.repeat(32)}`,
          actionDigest: `0x${'33'.repeat(32)}`,
          transactionNonce: '4',
          gasLimit: '1',
          maxFeePerGas: '1',
          maxFeeWei: '1',
        },
        generation: 1,
        expiresAt: Date.now() + 30_000,
      },
    }),
    confirm: () =>
      Promise.resolve({
        ok: true,
        data: { raw: '0x02', hash: HASH, sender: REVIEWER, operationId: operation().operationId },
      }),
    invalidateAll: () => undefined,
  } as unknown as RegistryTransactionSigning;
  const controller = new TransactionController({
    api,
    signing,
    newIdempotencyKey: () => 'k',
    scope: () => scope,
  });
  const signals: ConfirmationSignal[] = [];
  controller.onConfirmation((s) => signals.push(s));
  const request = { kind: 'execute' as const, action: {}, packageReference: {} };
  const start = async () => {
    await controller.begin(
      request,
      options.signed === false
        ? ({ signature: '0x' } as unknown as SignedReviewAction)
        : authorisation(),
    );
    await controller.confirmSend();
  };
  return { controller, signals, start };
}

describe('transaction controller confirmation signal', () => {
  it('emits exactly once when a watched operation becomes confirmed, and not for earlier stages', async () => {
    const { controller, signals, start } = rig(['pending', 'included', 'confirmed', 'confirmed']);
    await start();
    await controller.refresh();
    await controller.refresh();
    expect(signals).toHaveLength(0);
    await controller.refresh();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.kind).toBe('confirmed');
    await controller.refresh();
    expect(signals).toHaveLength(1);
  });

  it('never emits for reverted, unknown or rejected outcomes', async () => {
    for (const phase of ['reverted', 'unknown', 'replaced', 'cancelled'] as const) {
      const { controller, signals, start } = rig([phase]);
      await start();
      await controller.refresh();
      expect(signals).toHaveLength(0);
    }
  });

  it('emits nothing when the signed action is not held (an unbound confirmation)', async () => {
    const { controller, signals, start } = rig(['confirmed'], { signed: false });
    await start();
    await controller.refresh();
    expect(signals).toHaveLength(0);
  });

  it('does not emit for a recovered or replayed operation', async () => {
    const { controller, signals } = rig([]);
    await controller.recover();
    expect(controller.getSnapshot().stage).toBe('confirmed');
    expect(signals).toHaveLength(0);
  });

  it('withdraws a confirmation that later stops being confirmed, once', async () => {
    const { controller, signals, start } = rig(['confirmed', 'unknown', 'unknown']);
    await start();
    await controller.refresh();
    await controller.refresh();
    await controller.refresh();
    expect(signals.map((s) => s.kind)).toEqual(['confirmed', 'invalidated']);
    expect(signals[1]?.id).toBe(signals[0]?.id);
  });
});
