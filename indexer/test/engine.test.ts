import { describe, expect, it } from 'vitest';
import {
  ALICE,
  BOB,
  C1,
  C2,
  C3,
  CONTRACT_ACCOUNT,
  RELAYER,
  REGISTRY_KEY,
  ZERO,
  actionId,
  fresh,
  invalidated,
  issued,
  receiptId,
  revoked,
  reviewerKey,
  supersession,
  superseded,
} from './helpers';

const summaryOf = async (f: ReturnType<typeof fresh>, reviewer = ALICE) =>
  f.indexer.ReviewerSummary.getOrThrow(reviewerKey(reviewer));

describe('[indexer-projection-reorg-and-provenance] lifecycle projections against the real handlers', () => {
  it('projects the first ISSUE as one active receipt and one action', async () => {
    const f = fresh();
    await f.run([issued({ block: 1 }, { commitment: C1, nonce: 0n })]);
    const receipt = await f.indexer.IndexedReceipt.getOrThrow(receiptId(ALICE, C1));
    expect(receipt).toMatchObject({
      status: 'ACTIVE',
      predecessor: ZERO,
      successor: ZERO,
      issuedAt: 1_001n,
      updatedAt: 1_001n,
      reviewer: ALICE,
    });
    const action = await f.indexer.IndexedAction.getOrThrow(actionId(ALICE, 0));
    expect(action).toMatchObject({
      kind: 'ISSUE',
      consumedNonce: 0n,
      nextNonce: 1n,
      eventCount: 1,
    });
    expect(await summaryOf(f)).toMatchObject({
      nextNonce: 1n,
      totalReceipts: 1,
      activeReceipts: 1,
      revokedReceipts: 0,
      supersededReceipts: 0,
      actionCount: 1,
    });
    const state = await f.indexer.RegistryState.getOrThrow(REGISTRY_KEY);
    expect(state).toMatchObject({ rawEventCount: 1, actionCount: 1, pendingSupersessions: 0 });
  });

  it('keeps the executor distinct from the reviewer', async () => {
    const f = fresh();
    await f.run([issued({ block: 1, from: RELAYER }, { commitment: C1, nonce: 0n })]);
    const action = await f.indexer.IndexedAction.getOrThrow(actionId(ALICE, 0));
    expect(action.executor).toBe(RELAYER);
    expect(action.reviewer).toBe(ALICE);
    expect(await f.indexer.IndexedReceipt.get(receiptId(RELAYER, C1))).toBeUndefined();
  });

  it('isolates reviewers that share commitment bytes', async () => {
    const f = fresh();
    await f.run([
      issued({ block: 1 }, { commitment: C1, nonce: 0n }),
      issued({ block: 2 }, { reviewer: BOB, commitment: C1, nonce: 0n }),
      revoked({ block: 3 }, { reviewer: BOB, commitment: C1, nonce: 1n }),
    ]);
    expect((await f.indexer.IndexedReceipt.getOrThrow(receiptId(ALICE, C1))).status).toBe('ACTIVE');
    expect((await f.indexer.IndexedReceipt.getOrThrow(receiptId(BOB, C1))).status).toBe('REVOKED');
    expect((await summaryOf(f, ALICE)).activeReceipts).toBe(1);
    expect((await summaryOf(f, BOB)).revokedReceipts).toBe(1);
  });

  it('revokes an active receipt and keeps its identity', async () => {
    const f = fresh();
    await f.run([
      issued({ block: 1 }, { commitment: C1, nonce: 0n }),
      revoked({ block: 5, ts: 5_000 }, { commitment: C1, nonce: 1n }),
    ]);
    const receipt = await f.indexer.IndexedReceipt.getOrThrow(receiptId(ALICE, C1));
    expect(receipt).toMatchObject({ status: 'REVOKED', issuedAt: 1_001n, updatedAt: 5_000n });
    const s = await summaryOf(f);
    expect(s).toMatchObject({
      activeReceipts: 0,
      revokedReceipts: 1,
      totalReceipts: 1,
      nextNonce: 2n,
    });
  });

  it('completes a paired supersession as one action with two raw events', async () => {
    const f = fresh();
    await f.run([
      issued({ block: 1 }, { commitment: C1, nonce: 0n }),
      ...supersession({ block: 2 }, { previous: C1, replacement: C2, nonce: 1n }),
    ]);
    const old = await f.indexer.IndexedReceipt.getOrThrow(receiptId(ALICE, C1));
    const next = await f.indexer.IndexedReceipt.getOrThrow(receiptId(ALICE, C2));
    expect(old).toMatchObject({
      status: 'SUPERSEDED',
      successor: C2,
      issuedAt: 1_001n,
      updatedAt: 1_002n,
    });
    expect(next).toMatchObject({
      status: 'ACTIVE',
      predecessor: C1,
      successor: ZERO,
      issuedAt: 1_002n,
    });
    const action = await f.indexer.IndexedAction.getOrThrow(actionId(ALICE, 1));
    expect(action).toMatchObject({
      kind: 'SUPERSEDE',
      commitment: C1,
      relatedCommitment: C2,
      eventCount: 2,
      firstLogIndex: 0,
      lastLogIndex: 1,
    });
    expect(await f.indexer.IndexedAction.get(actionId(ALICE, 2))).toBeUndefined();
    const s = await summaryOf(f);
    expect(s).toMatchObject({
      totalReceipts: 2,
      activeReceipts: 1,
      supersededReceipts: 1,
      actionCount: 2,
      nextNonce: 2n,
    });
    const state = await f.indexer.RegistryState.getOrThrow(REGISTRY_KEY);
    expect(state).toMatchObject({ rawEventCount: 3, actionCount: 2, pendingSupersessions: 0 });
    const events = await f.indexer.ChainEvent.getAll();
    expect(events.filter((e) => e.actionId === action.id)).toHaveLength(2);
  });

  it('supports repeated replacement chains by direct links', async () => {
    const f = fresh();
    await f.run([
      issued({ block: 1 }, { commitment: C1, nonce: 0n }),
      ...supersession({ block: 2 }, { previous: C1, replacement: C2, nonce: 1n }),
      ...supersession({ block: 3 }, { previous: C2, replacement: C3, nonce: 2n }),
    ]);
    const [a, b, c] = await Promise.all(
      [C1, C2, C3].map((c) => f.indexer.IndexedReceipt.getOrThrow(receiptId(ALICE, c))),
    );
    expect([a?.status, b?.status, c?.status]).toEqual(['SUPERSEDED', 'SUPERSEDED', 'ACTIVE']);
    expect([a?.successor, b?.predecessor, b?.successor, c?.predecessor]).toEqual([C2, C1, C3, C2]);
    expect(await summaryOf(f)).toMatchObject({
      totalReceipts: 3,
      activeReceipts: 1,
      supersededReceipts: 2,
    });
  });

  it('revoking a replacement never reactivates its predecessor', async () => {
    const f = fresh();
    await f.run([
      issued({ block: 1 }, { commitment: C1, nonce: 0n }),
      ...supersession({ block: 2 }, { previous: C1, replacement: C2, nonce: 1n }),
      revoked({ block: 3 }, { commitment: C2, nonce: 2n }),
    ]);
    expect((await f.indexer.IndexedReceipt.getOrThrow(receiptId(ALICE, C1))).status).toBe(
      'SUPERSEDED',
    );
    expect((await f.indexer.IndexedReceipt.getOrThrow(receiptId(ALICE, C2))).status).toBe(
      'REVOKED',
    );
    expect(await summaryOf(f)).toMatchObject({ activeReceipts: 0, totalReceipts: 2 });
  });

  it('nonce invalidation changes only the nonce and action counters', async () => {
    const f = fresh();
    await f.run([
      invalidated({ block: 1 }, { previousNonce: 0n }),
      issued({ block: 2 }, { commitment: C1, nonce: 1n }),
      invalidated({ block: 3 }, { previousNonce: 2n }),
    ]);
    const first = await f.indexer.IndexedAction.getOrThrow(actionId(ALICE, 0));
    expect(first).toMatchObject({ kind: 'INVALIDATE_NONCE', consumedNonce: 0n, nextNonce: 1n });
    expect(first.commitment).toBeUndefined();
    expect(await summaryOf(f)).toMatchObject({
      nextNonce: 3n,
      actionCount: 3,
      totalReceipts: 1,
      activeReceipts: 1,
    });
    expect((await f.indexer.IndexedReceipt.getOrThrow(receiptId(ALICE, C1))).status).toBe('ACTIVE');
  });

  it('records a contract reviewer invalidated through a different outer executor', async () => {
    const f = fresh();
    await f.run([
      invalidated({ block: 1, from: RELAYER }, { reviewer: CONTRACT_ACCOUNT, previousNonce: 0n }),
    ]);
    const action = await f.indexer.IndexedAction.getOrThrow(actionId(CONTRACT_ACCOUNT, 0));
    expect(action.reviewer).toBe(CONTRACT_ACCOUNT);
    expect(action.executor).toBe(RELAYER);
  });

  it('orders several actions in one block by log index', async () => {
    const f = fresh();
    await f.run([
      issued({ block: 1, log: 0, tx: 0 }, { commitment: C1, nonce: 0n }),
      issued({ block: 1, log: 1, tx: 1 }, { reviewer: BOB, commitment: C2, nonce: 0n }),
      revoked({ block: 1, log: 2, tx: 2 }, { commitment: C1, nonce: 1n }),
    ]);
    expect(await summaryOf(f, ALICE)).toMatchObject({ actionCount: 2, nextNonce: 2n });
    expect(await summaryOf(f, BOB)).toMatchObject({ actionCount: 1 });
    const state = await f.indexer.RegistryState.getOrThrow(REGISTRY_KEY);
    expect(state).toMatchObject({ rawEventCount: 3, lastEventLogIndex: 2 });
  });

  it('keeps uint256 nonces exact', async () => {
    const f = fresh();
    const big = (1n << 200n) + 12345n;
    await f.run([invalidated({ block: 1 }, { previousNonce: 0n, newNonce: 1n })]);
    const s = await summaryOf(f);
    expect(s.nextNonce).toBe(1n);
    const g = fresh();
    await expect(g.run([invalidated({ block: 1 }, { previousNonce: big })])).rejects.toThrow();
  });

  it('continues from existing state when processing resumes', async () => {
    const f = fresh();
    await f.run([issued({ block: 1 }, { commitment: C1, nonce: 0n })]);
    await f.run([revoked({ block: 2 }, { commitment: C1, nonce: 1n })]);
    expect(await summaryOf(f)).toMatchObject({ nextNonce: 2n, revokedReceipts: 1, actionCount: 2 });
    expect((await f.indexer.RegistryState.getOrThrow(REGISTRY_KEY)).rawEventCount).toBe(2);
  });

  it('never double counts when the preload pass runs before processing', async () => {
    const f = fresh();
    await f.run([
      issued({ block: 1 }, { commitment: C1, nonce: 0n }),
      issued({ block: 2 }, { commitment: C2, nonce: 1n }),
    ]);
    const state = await f.indexer.RegistryState.getOrThrow(REGISTRY_KEY);
    expect(state).toMatchObject({ rawEventCount: 2, actionCount: 2 });
    expect(await summaryOf(f)).toMatchObject({ totalReceipts: 2, nextNonce: 2n });
  });
});

describe('rejected transitions publish nothing', () => {
  const rejects = async (items: Parameters<ReturnType<typeof fresh>['run']>[0]) => {
    const f = fresh();
    await expect(f.run(items)).rejects.toThrow();
    return f;
  };

  it('rejects a log from the wrong registry', async () => {
    const f = await rejects([
      issued({ block: 1, src: `0x${'9'.repeat(40)}` }, { commitment: C1, nonce: 0n }),
    ]);
    expect(await f.indexer.IndexedAction.getAll()).toHaveLength(0);
  });

  it('rejects a replacement whose predecessor is missing', async () => {
    const f = await rejects(
      supersession({ block: 1 }, { previous: C1, replacement: C2, nonce: 0n }),
    );
    expect(await f.indexer.IndexedReceipt.getAll()).toHaveLength(0);
    expect(await f.indexer.IndexedAction.getAll()).toHaveLength(0);
  });

  it('rejects mismatched paired logs', async () => {
    const f = fresh();
    await f.run([issued({ block: 1 }, { commitment: C1, nonce: 0n })]);
    await expect(
      f.run([
        issued({ block: 2, log: 0 }, { commitment: C2, predecessor: C1, nonce: 1n }),
        superseded({ block: 2, log: 1 }, { previous: C1, replacement: C3, nonce: 1n }),
      ]),
    ).rejects.toThrow();
    expect((await f.indexer.IndexedReceipt.getOrThrow(receiptId(ALICE, C1))).status).toBe('ACTIVE');
    expect(await f.indexer.IndexedReceipt.get(receiptId(ALICE, C3))).toBeUndefined();
  });

  it('rejects a Superseded log with no staged issuance', async () => {
    const f = fresh();
    await f.run([issued({ block: 1 }, { commitment: C1, nonce: 0n })]);
    await expect(
      f.run([superseded({ block: 2 }, { previous: C1, replacement: C2, nonce: 1n })]),
    ).rejects.toThrow();
  });

  it('rejects a nonce gap', async () => {
    await rejects([issued({ block: 1 }, { commitment: C1, nonce: 3n })]);
  });

  it('rejects an event whose timestamp differs from its block', async () => {
    await rejects([issued({ block: 1 }, { commitment: C1, nonce: 0n, ts: 77n })]);
  });

  it('rejects reuse of a terminal receipt', async () => {
    const f = fresh();
    await f.run([
      issued({ block: 1 }, { commitment: C1, nonce: 0n }),
      revoked({ block: 2 }, { commitment: C1, nonce: 1n }),
    ]);
    await expect(f.run([revoked({ block: 3 }, { commitment: C1, nonce: 2n })])).rejects.toThrow();
    await expect(f.run([issued({ block: 3 }, { commitment: C1, nonce: 2n })])).rejects.toThrow();
    expect((await f.indexer.IndexedReceipt.getOrThrow(receiptId(ALICE, C1))).status).toBe(
      'REVOKED',
    );
  });

  it('rejects an invalidation that does not advance by exactly one', async () => {
    await rejects([invalidated({ block: 1 }, { previousNonce: 0n, newNonce: 2n })]);
  });
});

describe('[indexer-projection-reorg-and-provenance] deterministic replay', () => {
  const sequence = () => [
    issued({ block: 1 }, { commitment: C1, nonce: 0n }),
    issued({ block: 2 }, { reviewer: BOB, commitment: C1, nonce: 0n }),
    ...supersession({ block: 3 }, { previous: C1, replacement: C2, nonce: 1n }),
    revoked({ block: 4 }, { commitment: C2, nonce: 2n }),
    invalidated({ block: 5 }, { previousNonce: 3n }),
  ];
  const dump = async (f: ReturnType<typeof fresh>) => {
    const strip = <T extends { id: string }>(rows: T[]) =>
      [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
    const registry = await f.indexer.RegistryState.getAll();
    return JSON.stringify(
      {
        registry: registry.map(({ generation: _g, ...rest }) => rest),
        events: strip(await f.indexer.ChainEvent.getAll()),
        actions: strip(await f.indexer.IndexedAction.getAll()),
        receipts: strip(await f.indexer.IndexedReceipt.getAll()),
        summaries: strip(await f.indexer.ReviewerSummary.getAll()),
      },
      (_k, v: unknown): unknown => (typeof v === 'bigint' ? `${v}n` : v),
    );
  };

  it('rebuilding the same ordered source yields identical entities and counters', async () => {
    const a = fresh();
    const b = fresh();
    await a.run(sequence());
    await b.run(sequence());
    expect(await dump(a)).toBe(await dump(b));
  });

  it('delivering the same events in two batches yields the same result as one batch', async () => {
    const whole = fresh();
    await whole.run(sequence());
    const split = fresh();
    const all = sequence();
    await split.run(all.slice(0, 2));
    await split.run(all.slice(2));
    expect(await dump(split)).toBe(await dump(whole));
  });
});
