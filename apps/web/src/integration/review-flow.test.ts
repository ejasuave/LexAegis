import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '@lexaegis/agent/review';
import { ReviewController, type ReviewDeps } from '@/features/review/controller';
import { EXTRACTION_LABEL, FACT_PREFIX } from '@/features/review/persistence';
import {
  confirm,
  importAndWait,
  must,
  pdf,
  port,
  range,
  rig,
  wait,
} from '@/test-support/review-rig';

/*
 * The real review controller on the real account and vault controllers (real Web Crypto, in-memory
 * server) with real PDFs parsed by the real pdf.js. The "worker" is an in-process stand-in that
 * runs the same extraction code, so termination is exercised separately in pdf-intake.test.ts.
 * Not real-device evidence.
 */

describe('import, encrypted storage and recovery', () => {
  it('stores the original and its extraction encrypted, and rebuilds them after lock and unlock', async () => {
    const r = await rig();
    const doc = await importAndWait(r, 'discrepancy-2000');
    expect(doc).toMatchObject({ extraction: 'ready', selected: true, pageCount: 2 });
    expect(r.controller.getSnapshot()).toMatchObject({ save: 'saved', intake: { state: 'done' } });
    // The server holds ciphertext only: neither the document text nor the label is visible.
    const stored = [...r.h.server.objects.objects.values()]
      .map((o) => Buffer.from(o).toString('latin1'))
      .join('');
    expect(stored).not.toContain('Northwind');
    expect(stored).not.toContain('discrepancy-2000');

    r.h.vault.lock();
    await wait(10);
    // Locking empties every private pane at once.
    expect(r.controller.getSnapshot()).toMatchObject({ matterId: null, documents: [], facts: [] });
    expect(r.controller.extraction(doc.documentVersionId)).toBeNull();

    must(await r.h.vault.unlock());
    r.h.vault.selectMatter(r.matterId);
    await wait(100);
    const again = r.controller.getSnapshot().documents[0];
    expect(again).toMatchObject({ documentVersionId: doc.documentVersionId, extraction: 'ready' });
    // The same bytes come back: original preservation.
    expect(
      await sha256Bytes(r.controller.originalBytes(doc.documentVersionId) ?? new Uint8Array()),
    ).toBe(await sha256Bytes(pdf('discrepancy-2000')));
    r.controller.dispose();
  });

  it('refuses unsupported files with a typed reason and stores nothing', async () => {
    const r = await rig();
    const before = r.h.vault.getSnapshot().headRevision;
    for (const [bytes, expected] of [
      [new TextEncoder().encode('not a pdf at all'), 'not_a_pdf'],
      [pdf('malformed'), 'malformed'],
      [pdf('image-only'), 'no_extractable_text'],
      [pdf('pages-81'), 'limit_exceeded:pages'],
    ] as const) {
      await r.controller.importPdf({ bytes: new Uint8Array(bytes), label: 'x.pdf' });
      const intake = r.controller.getSnapshot().intake;
      expect(intake).toMatchObject({ state: 'failed' });
      expect('reason' in intake ? intake.reason : '').toContain(
        expected === 'not_a_pdf' ? 'not_a_pdf' : expected,
      );
    }
    expect(r.controller.getSnapshot().documents).toEqual([]);
    expect(r.h.vault.getSnapshot().headRevision).toBe(before);
    r.controller.dispose();
  });

  it('a lock during extraction discards the result: nothing is saved and nothing repopulates', async () => {
    const r = await rig({ holdWorkers: true });
    const pending = r.controller.importPdf({ bytes: pdf('clean-payment'), label: 'late.pdf' });
    await wait(50);
    expect(r.controller.getSnapshot().intake.state).toBe('running');
    r.h.vault.lock();
    const held = r.workers[0];
    if (held !== undefined) held.hold = null;
    await wait(20);
    await pending;
    expect(r.controller.getSnapshot()).toMatchObject({ matterId: null, documents: [] });
    expect(r.workers[0]?.terminated).toBe(true);
    must(await r.h.vault.unlock());
    r.h.vault.selectMatter(r.matterId);
    await wait(60);
    expect(r.controller.getSnapshot().documents).toEqual([]);
    r.controller.dispose();
  });
});

describe('confirmed facts, checks and invalidation', () => {
  async function withPayment() {
    const r = await rig();
    const doc = await importAndWait(r, 'discrepancy-2000');
    const id = doc.documentVersionId;
    for (const spec of [
      { field: 'payment_total', slot: 'total', value: '2400000', quote: '24,000', page: 2 },
      { field: 'payment_instalment', slot: 'i1', value: '1000000', quote: '10,000', page: 2 },
      { field: 'payment_instalment', slot: 'i2', value: '1200000', quote: '12,000', page: 2 },
      { field: 'payment_basis', slot: 'basis', value: 'gross', quote: 'gross', page: 2 },
    ]) {
      expect(await confirm(r, id, spec)).toEqual({ ok: true });
    }
    return { r, id };
  }

  it('needs an unlocked account to confirm; unconfirmed candidates never count', async () => {
    const r = await rig();
    const doc = await importAndWait(r, 'clean-payment');
    const locked = new ReviewController({
      ...({} as ReviewDeps),
      vault: port(r.h),
      account: () => null,
      intake: { run: () => Promise.reject(new Error('no')), cancel: () => undefined },
      runDiff: () => ({
        promise: Promise.resolve({ kind: 'incomplete', reason: 'cancelled' }),
        cancel: () => undefined,
      }),
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
    });
    await wait(80);
    const text = locked.extraction(doc.documentVersionId)?.pages[1]?.text ?? '';
    const ref = locked.createReference({
      documentVersionId: doc.documentVersionId,
      page: 2,
      ...range(text, '24,000'),
    });
    if (!ref.ok) throw new Error(ref.code);
    expect(
      await locked.confirmFact({
        candidate: {
          schema: 'lexaegis.fact-candidate.v1',
          factId: crypto.randomUUID(),
          matterId: r.matterId,
          field: 'payment_total',
          group: 'settlement',
          slot: 'total',
          value: '2400000',
          provenance: 'reviewer_selection',
          references: [ref.data],
        },
        basis: 'source',
        statementReason: null,
      }),
    ).toEqual({ ok: false, code: 'ACCOUNT_LOCKED' });
    expect(locked.getSnapshot().facts).toEqual([]);
    locked.dispose();
    r.controller.dispose();
  });

  it('runs the checks from confirmed facts, and any change marks them stale', async () => {
    const { r } = await withPayment();
    await r.controller.runChecks();
    const checks = r.controller.getSnapshot().checks;
    expect(checks.status).toBe('fresh');
    expect(checks.payments[0]).toMatchObject({ outcome: 'mismatch', differencePence: '200000' });
    expect(
      checks.findings.some((f) => f.explanation.includes('Payment schedule differs by £2,000')),
    ).toBe(true);
    expect(checks.reviewRecord?.state).toBe('demo_draft');

    const factId = r.controller.getSnapshot().facts.find((f) => f.slot === 'i2')?.factId ?? '';
    expect(r.controller.removeFact(factId)).toEqual({ ok: true });
    expect(r.controller.getSnapshot().checks.status).toBe('stale');
    // Draft readiness is cleared with the stale result.
    expect(await r.controller.draftArtifacts()).toEqual({ ok: false, code: 'STALE_RESULT' });
    await r.controller.runChecks();
    expect(r.controller.getSnapshot().checks.payments[0]).toMatchObject({
      differencePence: '1400000',
    });
    r.controller.dispose();
  });

  it('saves facts encrypted, rebuilds them after unlock and refuses a tampered entry', async () => {
    const { r, id } = await withPayment();
    await r.controller.save();
    expect(r.controller.getSnapshot().save).toBe('saved');
    r.h.vault.lock();
    await wait(10);
    must(await r.h.vault.unlock());
    r.h.vault.selectMatter(r.matterId);
    await wait(120);
    expect(
      r.controller
        .getSnapshot()
        .facts.map((f) => f.slot)
        .sort(),
    ).toEqual(['basis', 'i1', 'i2', 'total']);
    expect(r.controller.getSnapshot().facts[0]?.references[0]?.documentVersionId).toBe(id);

    // Editing a stored fact's value without its recorded hash makes it unusable, not trusted.
    const entry = r.h.vault
      .getSnapshot()
      .selectedMatter?.context.entries.find(
        (e) => e.text.startsWith(FACT_PREFIX) && e.text.includes('"slot":"i1"'),
      );
    if (entry === undefined) throw new Error('entry');
    must(
      r.h.vault.correctEntry(
        r.matterId,
        entry.entryId,
        entry.text.replace('"value":"1000000"', '"value":"9999999"'),
      ),
    );
    must(r.h.vault.confirmEntry(r.matterId, entry.entryId));
    must(await r.h.vault.saveMatter(r.matterId));
    r.h.vault.lock();
    must(await r.h.vault.unlock());
    r.h.vault.selectMatter(r.matterId);
    await wait(120);
    expect(r.controller.getSnapshot().unresolvedFacts).toBe(1);
    expect(r.controller.getSnapshot().facts.map((f) => f.slot)).not.toContain('i1');
    r.controller.dispose();
  });

  it('assembles a draft only from fresh results, with outstanding requirements and no simulation', async () => {
    const { r } = await withPayment();
    await r.controller.runChecks();
    const draft = await r.controller.draftArtifacts();
    if (!draft.ok) throw new Error(draft.code);
    expect(draft.artifacts.map((a) => a.role)).toEqual(
      expect.arrayContaining([
        'source',
        'extracted-text',
        'calculation',
        'checklist',
        'rule-pack',
        'analysis',
      ]),
    );
    expect(draft.outstanding.map((o) => o.code)).toEqual(
      expect.arrayContaining([
        'AGENT_CONFIG_MISSING',
        'DECISION_LOG_MISSING',
        'HUMAN_REVIEW_GATE_PENDING',
      ]),
    );
    // Nothing about a draft enables signing: there is no signing surface here at all.
    expect(JSON.stringify(draft.outstanding)).not.toMatch(/approved|signed/i);
    r.controller.dispose();
  });
});

describe('comparison', () => {
  it('compares two imported versions and is discarded when the selection changes mid-run', async () => {
    const r = await rig();
    const a = await importAndWait(r, 'version-1');
    const b = await importAndWait(r, 'version-2');
    await r.controller.compare({
      oldVersionId: a.documentVersionId,
      newVersionId: b.documentVersionId,
    });
    const done = r.controller.getSnapshot().comparison;
    expect(done.status).toBe('ready');
    expect(done.result?.outcome).toBe('changes');
    expect(await r.controller.saveComparison()).toBe(true);

    // A diff that never finishes, then a selection change: the late result must not appear.
    let release: (outcome: { kind: 'done'; changes: [] }) => void = () => undefined;
    const slow = new ReviewController({
      vault: port(r.h),
      account: () => null,
      intake: { run: () => Promise.reject(new Error('no')), cancel: () => undefined },
      runDiff: () => ({
        promise: new Promise((resolve) => (release = resolve)),
        cancel: () => undefined,
      }),
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
    });
    await wait(150);
    const pending = slow.compare({
      oldVersionId: a.documentVersionId,
      newVersionId: b.documentVersionId,
    });
    await wait(10);
    expect(slow.getSnapshot().comparison.status).toBe('running');
    await slow.setSelected([a.documentVersionId]);
    release({ kind: 'done', changes: [] });
    await pending;
    expect(slow.getSnapshot().comparison.result).toBeNull();
    slow.dispose();
    r.controller.dispose();
  });
});

describe('privacy', () => {
  it('stores the extraction label convention and keeps document words out of the clear', async () => {
    const r = await rig();
    const doc = await importAndWait(r, 'prompt-injection');
    const matter = r.h.vault.getSnapshot().selectedMatter;
    expect(
      matter?.sources.some((s) => s.label === `${EXTRACTION_LABEL}${doc.documentVersionId}`),
    ).toBe(true);
    const wire = JSON.stringify(
      [...r.h.server.objects.objects.values()].map((o) => Buffer.from(o).toString('latin1')),
    );
    expect(wire).not.toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    expect(wire).not.toContain('prompt-injection.pdf');
    r.controller.dispose();
  });
});
