import { describe, expect, it } from 'vitest';
import type { RegistryTransactionSigning, SignedReviewAction } from '@/features/account/public';
import type { ChainApi, OperationView } from './api-client';
import { TransactionController } from './controller';

const operation = (patch: Partial<OperationView> = {}): OperationView => ({
  operationId: '11111111-1111-4111-8111-111111111111',
  kind: 'execute',
  phase: 'quoted',
  account: `0x${'ab'.repeat(20)}`,
  commitment: `0x${'11'.repeat(32)}`,
  registryNonce: '0',
  transactionNonce: '4',
  transactionHash: null,
  blockNumber: null,
  chargedFeeWei: null,
  executedViaAnotherTransaction: false,
  ...patch,
});

const quote = {
  operationId: operation().operationId,
  account: operation().account,
  chainId: '10143',
  registryAddress: `0x${'cd'.repeat(20)}`,
  calldataHash: `0x${'22'.repeat(32)}`,
  actionDigest: `0x${'33'.repeat(32)}`,
  transactionNonce: '4',
  gasLimit: '100000',
  maxFeePerGas: '200',
  maxPriorityFeePerGas: '1',
  maxFeeWei: '20000000',
  expectedFeeWei: '10000000',
  expiresAt: '2026-10-11T10:00:30.000Z',
};

function rig(options: { failRenewalQuote?: boolean } = {}) {
  const calls = { create: 0, quote: 0, submit: 0, refresh: 0, sign: 0, preview: 0 };
  const api: ChainApi = {
    create: () => (
      calls.create++,
      Promise.resolve({ ok: true, data: { operation: operation({ phase: 'reserved' }) } })
    ),
    quote: () => {
      calls.quote++;
      return options.failRenewalQuote === true && calls.quote === 2
        ? Promise.resolve({ ok: false as const, reason: 'STATE_CHANGED', network: false })
        : Promise.resolve({ ok: true, data: { quote, operation: operation() } });
    },
    submit: () => (
      calls.submit++,
      Promise.resolve({
        ok: true,
        data: {
          operation: operation({ phase: 'pending', transactionHash: `0x${'44'.repeat(32)}` }),
          transactionHash: `0x${'44'.repeat(32)}`,
        },
      })
    ),
    refresh: () => (
      calls.refresh++,
      Promise.resolve({
        ok: true,
        data: { operation: operation({ phase: 'confirmed', executedViaAnotherTransaction: true }) },
      })
    ),
    listUnresolved: () => Promise.resolve({ ok: true, data: { operations: [] } }),
  };
  let invalidated = 0;
  const signing: RegistryTransactionSigning = {
    preview: () => (
      calls.preview++,
      {
        ok: true,
        data: {
          preview: {
            operationId: quote.operationId,
            kind: 'execute',
            account: quote.account,
            chainId: '10143',
            destination: quote.registryAddress,
            calldata: '0x',
            calldataHash: quote.calldataHash,
            actionDigest: quote.actionDigest,
            transactionNonce: '4',
            gasLimit: '100000',
            maxFeePerGas: '200',
            maxFeeWei: quote.maxFeeWei,
          },
          generation: 1,
          expiresAt: Date.now() + 30_000,
        },
      }
    ),
    confirm: () => (
      calls.sign++,
      Promise.resolve({
        ok: true,
        data: {
          raw: '0x02',
          hash: `0x${'44'.repeat(32)}`,
          sender: quote.account,
          operationId: quote.operationId,
        },
      })
    ),
    invalidateAll: () => {
      invalidated++;
    },
  };
  const controller = new TransactionController({ api, signing, newIdempotencyKey: () => 'k' });
  return { controller, calls, invalidated: () => invalidated };
}

const authorisation = { signature: `0x${'55'.repeat(65)}` } as unknown as SignedReviewAction;
const request = { kind: 'execute' as const, action: {}, packageReference: {} };

describe('transaction stage', () => {
  it('quotes without sending and shows expected and maximum fee from the quote', async () => {
    const { controller, calls } = rig();
    await controller.begin(request, authorisation);
    const s = controller.getSnapshot();
    expect(s.stage).toBe('awaiting_confirmation');
    expect(s.quote).toMatchObject({ expectedFeeWei: '10000000', maxFeeWei: '20000000' });
    expect(calls.submit).toBe(0);
    expect(calls.sign).toBe(0);
  });

  it('sends only on the separate confirmation, once; a second click does nothing', async () => {
    const { controller, calls } = rig();
    await controller.begin(request, authorisation);
    await Promise.all([controller.confirmSend(), controller.confirmSend()]);
    expect(calls.sign).toBe(1);
    expect(calls.submit).toBe(1);
    expect(controller.getSnapshot().mayHaveBroadcast).toBe(true);
  });

  it('renews an expired quote without re-signing and needs a new confirmation', async () => {
    const { controller, calls } = rig();
    await controller.begin(request, authorisation);
    await controller.requote();
    expect(calls.quote).toBe(2);
    expect(calls.sign).toBe(0);
    expect(controller.getSnapshot().stage).toBe('awaiting_confirmation');
  });

  it('renews by quoting the SAME operation: a new reservation would collide with it (ACCOUNT_BUSY)', async () => {
    const { controller, calls } = rig();
    await controller.begin(request, authorisation);
    expect(calls.create).toBe(1);
    await controller.requote();
    expect(calls.create).toBe(1);
    expect(calls.quote).toBe(2);
  });

  it('falls back to a new reservation only when the earlier operation can no longer be quoted', async () => {
    const { controller, calls } = rig({ failRenewalQuote: true });
    await controller.begin(request, authorisation);
    await controller.requote();
    expect(calls.create).toBe(2);
    expect(calls.quote).toBe(3);
    expect(controller.getSnapshot().stage).toBe('awaiting_confirmation');
  });

  it('Stop before sending cancels and kills tickets; after sending it cannot cancel the transaction', async () => {
    const a = rig();
    await a.controller.begin(request, authorisation);
    a.controller.cancel();
    expect(a.controller.getSnapshot().stage).toBe('cancelled');
    expect(a.invalidated()).toBeGreaterThan(0);
    await a.controller.confirmSend();
    expect(a.calls.submit).toBe(0);

    const b = rig();
    await b.controller.begin(request, authorisation);
    await b.controller.confirmSend();
    b.controller.cancel();
    expect(b.controller.getSnapshot().stage).not.toBe('cancelled');
    expect(b.controller.getSnapshot().reason).toBe('ALREADY_SENT');
    expect(b.calls.submit).toBe(1);
  });

  it('keeps an external execution separate from this account’s own transaction', async () => {
    const { controller } = rig();
    await controller.begin(request, authorisation);
    await controller.confirmSend();
    await controller.refresh();
    const s = controller.getSnapshot();
    expect(s.stage).toBe('confirmed');
    expect(s.operation?.executedViaAnotherTransaction).toBe(true);
  });

  it('never re-signs on lock: held bytes and tickets are dropped', async () => {
    const { controller, calls } = rig();
    await controller.begin(request, authorisation);
    controller.onAccountLost();
    await controller.confirmSend();
    await controller.requote();
    expect(calls.sign).toBe(0);
    expect(calls.submit).toBe(0);
    expect(controller.getSnapshot().stage).toBe('cancelled');
  });
});
