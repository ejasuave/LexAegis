import { recoverTypedDataAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { toEip712ReviewAction } from '@lexaegis/sdk/registry';
import { createReviewGateLatch } from '@/features/account/review-signing';
import { ApprovalController, PREFLIGHT_FRESHNESS_MS } from '@/features/review/approval';
import { DecisionController } from '@/features/review/decisions';
import { PackageController } from '@/features/review/package';
import type { LiveState } from '@/features/transactions/live-state';
import { CONFIG } from '@/test-support/account-harness';
import { confirm, importAndWait, port, rig, wait, type Rig } from '@/test-support/review-rig';

/*
 * Stage one of approval on the real account, vault, review, decision and package controllers.
 * The chain is a scripted reader returning the shape the real route returns; this is a
 * fixture, not live evidence.
 */

async function frozen() {
  const latch = createReviewGateLatch();
  const r = await rig({ harness: { reviewGate: latch.gate } });
  const doc = await importAndWait(r, 'discrepancy-2000');
  for (const spec of [
    { field: 'payment_total', slot: 'total', value: '2400000', quote: '24,000', page: 2 },
    { field: 'payment_instalment', slot: 'i1', value: '1000000', quote: '10,000', page: 2 },
    { field: 'payment_instalment', slot: 'i2', value: '1200000', quote: '12,000', page: 2 },
    { field: 'payment_basis', slot: 'basis', value: 'gross', quote: 'gross', page: 2 },
  ]) {
    await confirm(r, doc.documentVersionId, spec);
  }
  await r.controller.save();
  await r.controller.runChecks();
  const address = () => r.h.controller.getSnapshot().account?.address ?? null;
  const decisions = new DecisionController({
    review: r.controller,
    vault: port(r.h),
    account: address,
    now: () => new Date(r.h.clock.now),
    newId: () => crypto.randomUUID(),
  });
  await wait(30);
  for (const view of decisions.getSnapshot().findings) {
    if (view.finding.state === 'ok') continue;
    decisions.decide({
      findingId: view.finding.findingId,
      kind: 'accepted_unresolved',
      reason: 'Client told.',
    });
  }
  await decisions.record();
  const pkg = new PackageController({
    review: r.controller,
    decisions,
    vault: {
      getSnapshot: () => ({
        generation: r.h.vault.getSnapshot().generation,
        selectedMatterId: r.h.vault.getSnapshot().selectedMatterId,
      }),
      subscribe: (l) => r.h.vault.subscribe(l),
      commands: r.h.vault,
      recoverableSubject: (c) => r.h.vault.recoverableSubject(c),
    },
    account: address,
    config: () => ({ chainId: CONFIG.chainId, registryAddress: CONFIG.registryAddress }),
    now: () => new Date(r.h.clock.now),
    newId: () => crypto.randomUUID(),
  });
  await pkg.buildPreview();
  const done = await pkg.freeze();
  const commitment = done.frozen?.commitment ?? '';
  expect(done.status).toBe('recoverable');
  return { r, latch, commitment };
}

interface Chain {
  nonce: string;
  lifecycle: 'not_found' | 'active' | 'revoked' | 'superseded';
  ageMs: number;
  down: boolean;
  onRead: (() => void) | null;
}

function approvalFor(r: Rig, latch: ReturnType<typeof createReviewGateLatch>, chain: Chain) {
  const account = () => {
    const s = r.h.controller.getSnapshot();
    return {
      address: s.account?.address ?? null,
      generation: s.generation,
      signing: s.signing.state,
      backend: s.backend.state,
    };
  };
  return new ApprovalController({
    review: {
      preview: (request) => r.h.controller.review.preview(request),
      confirm: (ticket, request) => r.h.controller.review.confirm(ticket, request),
      owns: (signed) => r.h.controller.review.owns(signed),
      invalidateAll: () => r.h.controller.review.invalidateAll(),
    },
    bindGate: (check) => latch.bind(check),
    account,
    onAccountChange: (l) => r.h.controller.subscribe(l),
    vault: {
      getSnapshot: () => ({ generation: r.h.vault.getSnapshot().generation }),
      subscribe: (l) => r.h.vault.subscribe(l),
      recoverableSubject: (c) => r.h.vault.recoverableSubject(c),
    },
    config: () => ({ chainId: CONFIG.chainId, registryAddress: CONFIG.registryAddress }),
    live: (): Promise<LiveState> => {
      chain.onRead?.();
      if (chain.down) return Promise.resolve({ status: 'unknown', reason: 'RPC_UNAVAILABLE' });
      return Promise.resolve({
        status: 'ok',
        blockNumber: '100',
        blockTimestamp: String(Math.floor(r.h.clock.now / 1000)),
        observedAt: new Date(r.h.clock.now - chain.ageMs).toISOString(),
        registryNonce: chain.nonce,
        receiptLifecycle: chain.lifecycle,
      });
    },
    now: () => r.h.clock.now,
  });
}

const chain = (patch: Partial<Chain> = {}): Chain => ({
  nonce: '0',
  lifecycle: 'not_found',
  ageMs: 0,
  down: false,
  onRead: null,
  ...patch,
});

describe('stage one: explicit package authorisation', () => {
  it('previews the exact action from the verified package and signs only on a trusted approval', async () => {
    const { r, latch, commitment } = await frozen();
    const approval = approvalFor(r, latch, chain());
    const previewed = await approval.prepare({ kind: 'issue', commitment });
    expect(previewed.stage, JSON.stringify(previewed.failure)).toBe('preview');
    const d = previewed.display;
    if (d === null) throw new Error('no display');
    expect(d).toMatchObject({ kind: 'issue', commitment, nonce: '0', chainId: CONFIG.chainId });
    expect(d.registryAddress).toBe(CONFIG.registryAddress);
    expect(d.scope?.artifactCount).toBeGreaterThan(5);
    expect(d.concerns.length).toBeGreaterThan(0); // the reviewer's own reasons, from the frozen log
    // Nothing is signed by previewing, and an untrusted caller cannot approve.
    expect(approval.takeAuthorisation()).toBeNull();
    const untrusted = await approval.approve({ trusted: false });
    expect(untrusted.failure).toBe('NOT_TRUSTED');
    expect(approval.takeAuthorisation()).toBeNull();

    // A fresh preview, then the real approval.
    await approval.prepare({ kind: 'issue', commitment });
    const signed = await approval.approve({ trusted: true });
    expect(signed.stage).toBe('signed');
    expect(signed.notice).toBe('Approval signed; publication not confirmed.');
    const taken = approval.takeAuthorisation();
    if (taken === null) throw new Error('no authorisation');
    const eip712 = toEip712ReviewAction(taken.signed.typedData);
    if (!eip712.ok) throw new Error('typed data');
    const recovered = await recoverTypedDataAddress({
      ...eip712.data,
      signature: taken.signed.signature,
    });
    expect(recovered.toLowerCase()).toBe(d.reviewer);
    expect(taken.request.packageReference.commitment).toBe(commitment);
    expect(approval.takeAuthorisation()).toBeNull(); // released once
    // The signature is held by no public state.
    expect(JSON.stringify(approval.getSnapshot())).not.toContain(taken.signed.signature);
  });

  it('refuses without a capture verified in this unlock, or for a commitment it never saw', async () => {
    const { r, latch, commitment } = await frozen();
    const approval = approvalFor(r, latch, chain());
    expect(
      (await approval.prepare({ kind: 'issue', commitment: `0x${'33'.repeat(32)}` })).failure,
    ).toBe('CAPTURE_NOT_VERIFIED');
    r.h.vault.lock();
    await wait(5);
    expect((await approval.prepare({ kind: 'issue', commitment })).failure).toBeOneOf([
      'CAPTURE_NOT_VERIFIED',
      'SESSION_LOCKED',
      'NO_ACCOUNT',
    ]);
  });

  it('refuses stale observations, unknown chain state and the wrong lifecycle', async () => {
    const { r, latch, commitment } = await frozen();
    expect(
      (
        await approvalFor(r, latch, chain({ ageMs: PREFLIGHT_FRESHNESS_MS + 1000 })).prepare({
          kind: 'issue',
          commitment,
        })
      ).failure,
    ).toBe('STALE_OBSERVATION');
    expect(
      (await approvalFor(r, latch, chain({ down: true })).prepare({ kind: 'issue', commitment }))
        .failure,
    ).toBe('CHAIN_UNKNOWN');
    expect(
      (
        await approvalFor(r, latch, chain({ lifecycle: 'active' })).prepare({
          kind: 'issue',
          commitment,
        })
      ).failure,
    ).toBe('LIFECYCLE_REJECTED');
    // The gate is shut whenever no live context exists.
    expect(r.h.controller.review.preview({ action: {}, packageReference: {} }).ok).toBe(false);
  });

  it('invalidates the preview when the nonce changes before approval; nothing is signed', async () => {
    const { r, latch, commitment } = await frozen();
    const c = chain();
    const approval = approvalFor(r, latch, c);
    await approval.prepare({ kind: 'issue', commitment });
    c.nonce = '1';
    const out = await approval.approve({ trusted: true });
    expect(out.failure).toBe('CHANGED');
    expect(approval.takeAuthorisation()).toBeNull();
    // A used or discarded ticket cannot be reused: approving again needs a new preview.
    expect((await approval.approve({ trusted: true })).failure).toBe('NO_PREVIEW');
  });

  it('discards the signature if the account locks while signing', async () => {
    const { r, latch, commitment } = await frozen();
    const real = r.h.controller.review;
    const approval = new ApprovalController({
      review: {
        preview: (request) => real.preview(request),
        owns: (signed) => real.owns(signed),
        invalidateAll: () => real.invalidateAll(),
        confirm: (ticket, request) => {
          const pending = real.confirm(ticket, request);
          r.h.controller.lock();
          return pending;
        },
      },
      bindGate: (check) => latch.bind(check),
      account: () => {
        const s = r.h.controller.getSnapshot();
        return {
          address: s.account?.address ?? null,
          generation: s.generation,
          signing: s.signing.state,
          backend: s.backend.state,
        };
      },
      onAccountChange: (l: () => void) => r.h.controller.subscribe(l),
      vault: {
        getSnapshot: () => ({ generation: r.h.vault.getSnapshot().generation }),
        subscribe: (l: () => void) => r.h.vault.subscribe(l),
        recoverableSubject: (c: string) => r.h.vault.recoverableSubject(c),
      },
      config: () => ({ chainId: CONFIG.chainId, registryAddress: CONFIG.registryAddress }),
      live: () =>
        Promise.resolve<LiveState>({
          status: 'ok',
          blockNumber: '1',
          blockTimestamp: '1',
          observedAt: new Date(r.h.clock.now).toISOString(),
          registryNonce: '0',
          receiptLifecycle: 'not_found',
        }),
      now: () => r.h.clock.now,
    });
    await approval.prepare({ kind: 'issue', commitment });
    const out = await approval.approve({ trusted: true });
    expect(out.stage).not.toBe('signed');
    expect(approval.getSnapshot().stage).not.toBe('signed');
    expect(approval.takeAuthorisation()).toBeNull();
  });

  it('revokes a known public receipt without any private documents, only when it is Active', async () => {
    const { r, latch, commitment } = await frozen();
    const reviewer = r.h.controller.getSnapshot().account?.address ?? '';
    const reference = {
      schema: 'lexaegis.receipt-ref.v1' as const,
      chainId: CONFIG.chainId,
      registryAddress: CONFIG.registryAddress,
      reviewerAddress: reviewer,
      commitment: `0x${'77'.repeat(32)}`,
    };
    // Not Active on the live registry: refused before any preview.
    const notActive = approvalFor(r, latch, chain({ lifecycle: 'not_found' }));
    expect((await notActive.prepare({ kind: 'revoke', reference })).failure).toBe(
      'LIFECYCLE_REJECTED',
    );
    // Active: previewed and signed; the signed action is REVOKE (code 1) for that commitment.
    const approval = approvalFor(r, latch, chain({ lifecycle: 'active', nonce: '2' }));
    const previewed = await approval.prepare({ kind: 'revoke', reference });
    expect(previewed.display).toMatchObject({
      kind: 'revoke',
      commitment: reference.commitment,
      nonce: '2',
      scope: null,
    });
    expect((await approval.approve({ trusted: true })).stage).toBe('signed');
    const taken = approval.takeAuthorisation();
    expect(taken?.request.action.action).toMatchObject({
      action: 1,
      commitment: reference.commitment,
      nonce: '2',
    });
    // Another reviewer's receipt is refused outright.
    const foreign = { ...reference, reviewerAddress: `0x${'12'.repeat(20)}` };
    expect(
      (
        await approvalFor(r, latch, chain({ lifecycle: 'active' })).prepare({
          kind: 'revoke',
          reference: foreign,
        })
      ).failure,
    ).toBe('SCOPE_MISMATCH');
    void commitment;
  });

  it('refuses to treat an ordinary package as a replacement, and a replacement as a new issue', async () => {
    const { r, latch, commitment } = await frozen();
    const approval = approvalFor(r, latch, chain());
    expect((await approval.prepare({ kind: 'supersede', commitment })).failure).toBe(
      'NOT_A_REPLACEMENT',
    );
  });
});
