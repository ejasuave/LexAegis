import { describe, expect, it } from 'vitest';
import { projectEvent } from '../src/projection/apply';
import { normalize, type RawLog } from '../src/projection/normalize';
import { IntegrityError, type Tables } from '../src/projection/types';
import { ALICE, BOB, C1, C2, REGISTRY_KEY, START, ZERO, hex32, reviewerKey } from './helpers';
import { BINDING } from '../src/binding.generated';

/** A Map-backed store with the same get/set surface as an Envio handler context. */
function memory(): Tables & { readonly dump: () => string } {
  const maps = new Map<string, Map<string, { readonly id: string }>>();
  const table = (name: string) => {
    const m = maps.get(name) ?? new Map<string, { readonly id: string }>();
    maps.set(name, m);
    return {
      get: (id: string) => Promise.resolve(m.get(id) as never),
      set: (e: { readonly id: string }) => void m.set(e.id, e),
    };
  };
  return {
    RegistryState: table('RegistryState'),
    ReviewerSummary: table('ReviewerSummary'),
    IndexedReceipt: table('IndexedReceipt'),
    IndexedAction: table('IndexedAction'),
    ChainEvent: table('ChainEvent'),
    PendingSupersession: table('PendingSupersession'),
    dump: () =>
      JSON.stringify(
        [...maps].map(([k, v]) => [k, [...v.values()]]),
        (_k, x: unknown): unknown => (typeof x === 'bigint' ? `${x}n` : x),
      ),
  };
}

const GEN = 'test-generation-0001';
const raw = (over: Partial<RawLog> = {}): RawLog => ({
  kind: 'RECEIPT_ISSUED',
  chainId: Number(BINDING.chainId),
  srcAddress: BINDING.registryAddress,
  reviewer: ALICE,
  commitment: C1,
  relatedCommitment: ZERO,
  nonce: 0n,
  eventTimestamp: 1_000n,
  blockNumber: START + 1,
  blockHash: hex32(0x77),
  blockTimestamp: 1_000,
  transactionHash: hex32(0x88),
  executor: ALICE,
  logIndex: 0,
  ...over,
});

const code = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (e) {
    if (e instanceof IntegrityError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
};

describe('transition integrity', () => {
  it('treats an identical persisted event as a no-op', async () => {
    const t = memory();
    await projectEvent(t, normalize(raw()), GEN);
    const before = t.dump();
    await projectEvent(t, normalize(raw()), GEN);
    expect(t.dump()).toBe(before);
  });

  it('fails when a different payload arrives under the same event id', async () => {
    const t = memory();
    await projectEvent(t, normalize(raw()), GEN);
    expect(await code(() => projectEvent(t, normalize(raw({ commitment: C2 })), GEN))).toBe(
      'EVENT_CONFLICT',
    );
  });

  it('rejects an event ordered before the last indexed position', async () => {
    const t = memory();
    await projectEvent(t, normalize(raw({ blockNumber: START + 5 })), GEN);
    const earlier = raw({
      blockNumber: START + 4,
      blockHash: hex32(0x55),
      transactionHash: hex32(0x56),
      commitment: C2,
      nonce: 1n,
    });
    expect(await code(() => projectEvent(t, normalize(earlier), GEN))).toBe(
      'EVENT_ORDER_REGRESSION',
    );
  });

  it('rejects a changed deployment fingerprint on existing state', async () => {
    const t = memory();
    await projectEvent(t, normalize(raw()), GEN);
    const state = await t.RegistryState.get(REGISTRY_KEY);
    if (state === undefined) throw new Error('state missing');
    t.RegistryState.set({ ...state, configFingerprint: hex32(1) });
    const next = raw({
      blockNumber: START + 2,
      blockHash: hex32(0x78),
      transactionHash: hex32(0x89),
      commitment: C2,
      nonce: 1n,
    });
    expect(await code(() => projectEvent(t, normalize(next), GEN))).toBe('CONFIG_CHANGED');
  });

  it('refuses to start without a valid generation', async () => {
    expect(await code(() => projectEvent(memory(), normalize(raw()), undefined))).toBe(
      'GENERATION_INVALID',
    );
    expect(await code(() => projectEvent(memory(), normalize(raw()), 'Bad Gen!'))).toBe(
      'GENERATION_INVALID',
    );
  });

  it('writes nothing when a transition is rejected', async () => {
    const t = memory();
    await projectEvent(t, normalize(raw()), GEN);
    const before = t.dump();
    const bad = raw({
      blockNumber: START + 2,
      blockHash: hex32(0x78),
      transactionHash: hex32(0x89),
      commitment: C2,
      nonce: 9n,
    });
    expect(await code(() => projectEvent(t, normalize(bad), GEN))).toBe('NONCE_DISCONTINUITY');
    expect(t.dump()).toBe(before);
    expect(await t.ReviewerSummary.get(reviewerKey(BOB))).toBeUndefined();
  });
});

describe('normalisation', () => {
  it('rejects the wrong chain, unsafe numbers and malformed values', () => {
    expect(() => normalize(raw({ chainId: 143 }))).toThrow(/WRONG_CHAIN/);
    expect(() => normalize(raw({ blockNumber: 2 ** 60 }))).toThrow(/INVALID_PARAMETER/);
    expect(() => normalize(raw({ nonce: -1n }))).toThrow(/INVALID_PARAMETER/);
    expect(() => normalize(raw({ nonce: 1n << 256n }))).toThrow(/INVALID_PARAMETER/);
    expect(() => normalize(raw({ commitment: '0x12' }))).toThrow(/INVALID_PARAMETER/);
    expect(() => normalize(raw({ commitment: ZERO }))).toThrow(/INVALID_PARAMETER/);
    expect(() => normalize(raw({ reviewer: `0x${'0'.repeat(40)}` }))).toThrow(/INVALID_PARAMETER/);
    expect(() => normalize(raw({ eventTimestamp: 5n }))).toThrow(/TIMESTAMP_MISMATCH/);
  });

  it('lowercases addresses and hashes', () => {
    const e = normalize(raw({ reviewer: ALICE.toUpperCase().replace('0X', '0x') }));
    expect(e.reviewer).toBe(ALICE);
  });
});
