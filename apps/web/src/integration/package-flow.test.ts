import { describe, expect, it } from 'vitest';
import { DecisionController } from '@/features/review/decisions';
import { PackageController } from '@/features/review/package';
import { CONFIG } from '@/test-support/account-harness';
import { confirm, importAndWait, port, rig, wait, type Rig } from '@/test-support/review-rig';

/*
 * The real review controller, decision controller and package controller on the real account and
 * vault controllers (real Web Crypto, in-memory server), with real synthetic PDFs. Scripted
 * fixture only: not real-device or live evidence.
 */

async function ready() {
  const r = await rig();
  const doc = await importAndWait(r, 'discrepancy-2000');
  for (const spec of [
    { field: 'payment_total', slot: 'total', value: '2400000', quote: '24,000', page: 2 },
    { field: 'payment_instalment', slot: 'i1', value: '1000000', quote: '10,000', page: 2 },
    { field: 'payment_instalment', slot: 'i2', value: '1200000', quote: '12,000', page: 2 },
    { field: 'payment_basis', slot: 'basis', value: 'gross', quote: 'gross', page: 2 },
  ]) {
    expect(await confirm(r, doc.documentVersionId, spec)).toEqual({ ok: true });
  }
  await r.controller.save();
  await r.controller.runChecks();
  return { r, doc };
}

function controllers(r: Rig) {
  const address = () => r.h.controller.getSnapshot().account?.address ?? null;
  const decisions = new DecisionController({
    review: r.controller,
    vault: port(r.h),
    account: address,
    now: () => new Date(r.h.clock.now),
    newId: () => crypto.randomUUID(),
  });
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
  return { decisions, pkg };
}

async function decideAll(decisions: DecisionController) {
  await wait(30);
  for (const view of decisions.getSnapshot().findings) {
    if (view.finding.state === 'ok' || view.finding.state === 'technical_failure') continue;
    const out = decisions.decide({
      findingId: view.finding.findingId,
      kind: 'accepted_unresolved',
      reason: 'Client has been told about the difference.',
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
  }
}

describe('decision log, package preview, freeze and verified save', () => {
  it('cannot preview before decisions are recorded', async () => {
    const { r } = await ready();
    const { pkg } = controllers(r);
    await wait(30);
    expect((await pkg.buildPreview()).failure).toBe('DECISIONS_NOT_RECORDED');
  });

  it('previews exactly one decision log and full scope, with modelExecution none', async () => {
    const { r } = await ready();
    const { decisions, pkg } = controllers(r);
    await decideAll(decisions);
    const recorded = await decisions.record();
    expect(recorded.ok).toBe(true);
    const state = await pkg.buildPreview();
    expect(state.status, JSON.stringify(state.failure)).toBe('preview');
    const preview = state.preview;
    if (preview === null) throw new Error('no preview');
    expect(preview.artifacts.filter((a) => a.role === 'decision-log')).toHaveLength(1);
    expect(preview.artifacts.some((a) => a.role === 'source')).toBe(true);
    expect([...preview.scopeArtifactIds].sort()).toEqual(preview.artifacts.map((a) => a.id).sort());
    expect(preview.modelExecution).toBe('none');
    expect(preview.acceptedConcerns.length).toBeGreaterThan(0);
    expect(preview.limitations.join(' ')).toContain('not the settlement agreement');
    // Nothing was frozen or saved by previewing.
    expect(state.frozen).toBeNull();
    expect(r.h.vault.getSnapshot().selectedMatter?.frozenReviews).toHaveLength(0);
  });

  it('freezes, saves and verifies; the capture is rebuilt by read-back and nothing is approved', async () => {
    const { r } = await ready();
    const { decisions, pkg } = controllers(r);
    await decideAll(decisions);
    await decisions.record();
    await pkg.buildPreview();
    const done = await pkg.freeze();
    expect(done.status, JSON.stringify(done)).toBe('recoverable');
    const commitment = done.frozen?.commitment ?? '';
    expect(commitment).toMatch(/^0x[0-9a-f]{64}$/);
    const subject = r.h.vault.recoverableSubject(commitment);
    expect(subject?.reference.commitment).toBe(commitment);
    expect(subject?.reference.reviewerAddress).toBe(r.h.controller.getSnapshot().account?.address);
    expect(done.notice).toContain('not approval');
    // Public projection only: no opening, label or hash in the frozen view.
    expect(JSON.stringify(done.frozen)).not.toMatch(/blindingNonce|sha256|label/);
    // After lock and unlock the capture is gone until it is rebuilt by retrieval and verification.
    r.h.vault.lock();
    await wait(5);
    expect(r.h.vault.recoverableSubject(commitment)).toBeNull();
    expect(pkg.getSnapshot().status).toBe('empty');
  });

  it('discards a pending preview when the working review changes, and rejects a stale freeze', async () => {
    const { r, doc } = await ready();
    const { decisions, pkg } = controllers(r);
    await decideAll(decisions);
    await decisions.record();
    await pkg.buildPreview();
    expect(pkg.getSnapshot().status).toBe('preview');
    // A changed fact changes the inputs: preview, decisions and checks all become stale.
    expect(
      await confirm(r, doc.documentVersionId, {
        field: 'payment_instalment',
        slot: 'i3',
        value: '200000',
        quote: '24,000',
        page: 2,
      }),
    ).toEqual({ ok: true });
    await wait(30);
    expect(pkg.getSnapshot().status).toBe('empty');
    expect((await pkg.freeze()).failure).toBe('NO_PREVIEW');
    expect(r.h.vault.getSnapshot().selectedMatter?.frozenReviews).toHaveLength(0);
  });

  it('a retry after an uncertain save reuses the same commitment and creates no second capture', async () => {
    const { r } = await ready();
    const { decisions, pkg } = controllers(r);
    await decideAll(decisions);
    await decisions.record();
    await pkg.buildPreview();
    r.h.faults.loseNextWriteResponse = true;
    const first = await pkg.freeze();
    if (first.status === 'recoverable') {
      // The lost response may have hit a write that was already committed; still one capture.
      expect(r.h.vault.getSnapshot().selectedMatter?.frozenReviews).toHaveLength(1);
      return;
    }
    expect(first.status).toBe('failed');
    const commitment = first.frozen?.commitment ?? '';
    const second = await pkg.retry();
    expect(second.status, JSON.stringify(second)).toBe('recoverable');
    expect(second.frozen?.commitment).toBe(commitment);
    expect(r.h.vault.getSnapshot().selectedMatter?.frozenReviews).toHaveLength(1);
  });
});
