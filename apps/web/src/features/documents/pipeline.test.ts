import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import {
  assembleDraft,
  buildChecklist,
  buildSnapshot,
  checkSelectionLimits,
  compareDocumentVersions,
  confirmFact,
  createSourceReference,
  demoDraftReview,
  loadRulePack,
  reconcilePayments,
  resolveSourceReference,
  runChecks,
  sha256Bytes,
  snapshotDigest,
  verifySourceSet,
  type SourceSet,
} from '@lexaegis/agent/review';
import { extractionBytes } from '@lexaegis/agent/review';
import type { ConfirmedFactV1, EvidenceSelectionV1 } from '@lexaegis/agent/contracts';
import { extractPdf, type PdfjsLike } from './extract';

/*
 * Real synthetic PDFs (fixtures/documents-v1) through the real pdf.js and the real review code.
 * Expected results come from the independently worked cases in cases.json, not from this code.
 */

const pdfjs = pdfjsModule as unknown as PdfjsLike;
const dir = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../../fixtures/documents-v1',
);
const casesFile = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8')) as {
  cases: {
    id: string;
    facts: {
      field: string;
      group: string;
      slot: string;
      value: string;
      quote: string;
      page: number;
      occurrence: number;
    }[];
    expected: Record<string, unknown>;
    kernel?: Parameters<typeof reconcilePayments>[0];
  }[];
};
const byId = (id: string) => {
  const found = casesFile.cases.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no case ${id}`);
  return found;
};

function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}
const firstPage = (doc: { pages: { text: string; items: unknown[] }[] }) => need(doc.pages[0]);
const MATTER = '99999999-9999-4999-8999-999999999999';
const REVIEWER = `0x${'ab'.repeat(20)}`;
const NOW = '2026-10-09T12:00:00.000Z';
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

async function load(id: string) {
  const bytes = new Uint8Array(readFileSync(join(dir, 'pdfs', `${id}.pdf`)));
  const sourceSha256 = await sha256Bytes(bytes);
  const identity = {
    documentId: uuid(),
    documentVersionId: uuid(),
    sourceArtifactId: uuid(),
    sourceSha256,
  };
  const out = await extractPdf(pdfjs, bytes, identity);
  if (out.kind !== 'extracted' && out.kind !== 'partial_coverage')
    throw new Error(`${id}: ${out.kind}`);
  const extractionArtifactId = uuid();
  const stored = extractionBytes(out.document);
  const loaded = {
    documentId: identity.documentId,
    documentVersionId: identity.documentVersionId,
    sourceArtifactId: identity.sourceArtifactId,
    sourceSha256,
    sourceBytes: bytes,
    extractionArtifactId,
    extractionSha256: await sha256Bytes(stored),
    extractionBytes: stored,
  };
  return { loaded, document: out.document, versionId: identity.documentVersionId, kind: out.kind };
}

async function setOf(...items: Awaited<ReturnType<typeof load>>[]): Promise<SourceSet> {
  const set = await verifySourceSet(
    MATTER,
    items.map((i) => i.loaded),
    items.map((i) => i.versionId),
  );
  if (!set.ok) throw new Error(set.code);
  return set.data;
}

function rangeOf(text: string, quote: string, occurrence: number): [number, number] {
  let from = -1;
  for (let i = 0; i < occurrence; i += 1) {
    from = text.indexOf(quote, from + 1);
    if (from < 0) throw new Error(`quote ${quote} occurrence ${occurrence} not found`);
  }
  return [from, from + quote.length];
}

async function confirmedFacts(
  id: string,
  item: Awaited<ReturnType<typeof load>>,
  set: SourceSet,
): Promise<ConfirmedFactV1[]> {
  const facts: ConfirmedFactV1[] = [];
  for (const spec of byId(id).facts) {
    const page = item.document.pages[spec.page - 1]?.text ?? '';
    const [start, end] = rangeOf(page, spec.quote, spec.occurrence);
    const ref = createSourceReference(set, {
      documentVersionId: item.versionId,
      page: spec.page,
      start,
      end,
    });
    if (!ref.ok) throw new Error(ref.code);
    const made = await confirmFact({
      set,
      candidate: {
        schema: 'lexaegis.fact-candidate.v1',
        factId: uuid(),
        matterId: MATTER,
        field: spec.field,
        group: spec.group,
        slot: spec.slot,
        value: spec.value,
        provenance: 'reviewer_selection',
        references: [ref.data],
      },
      basis: 'source',
      statementReason: null,
      confirmedBy: REVIEWER,
      confirmedAt: NOW,
      existing: facts,
    });
    if (!made.ok) throw new Error(`${spec.field}: ${made.code}`);
    facts.push(made.data);
  }
  return facts;
}

async function review(id: string, evidence: EvidenceSelectionV1[] = []) {
  const item = await load(id);
  const set = await setOf(item);
  const facts = await confirmedFacts(id, item, set);
  const rulePack = await loadRulePack();
  if (!rulePack.ok) throw new Error('rule pack');
  const result = await runChecks({
    matterId: MATTER,
    sources: set,
    integrityFailure: null,
    facts,
    evidence,
    rulePack: rulePack.data,
    reviewRecord: demoDraftReview(rulePack.data.digest),
  });
  if (!result.ok) throw new Error(result.code);
  return { item, set, facts, result: result.data, rulePack: rulePack.data };
}

const payment = (r: Awaited<ReturnType<typeof review>>) => r.result.payments[0];

describe('payment fixtures (real PDFs, hand-worked pence)', () => {
  it.each(['clean-payment', 'discrepancy-2000', 'one-penny', 'missing-instalment'])(
    '%s',
    async (id) => {
      const expected = byId(id).expected as Record<string, string>;
      const r = await review(id);
      expect(payment(r)).toMatchObject({
        outcome: expected.outcome,
        statedTotalPence: expected.statedTotalPence,
        comparableSumPence: expected.comparableSumPence,
        differencePence: expected.differencePence,
      });
    },
  );

  it('reports the £2,000 discrepancy in plain words with its citations', async () => {
    const r = await review('discrepancy-2000');
    const finding = r.result.findings.find(
      (f) => f.findingId === 'payment_reconciliation:payment-reconciliation:settlement',
    );
    expect(finding?.state).toBe('attention');
    expect(finding?.explanation).toContain('Payment schedule differs by £2,000');
    expect(finding?.references.length).toBe(4);
    for (const ref of finding?.references ?? [])
      expect(resolveSourceReference(r.set, ref).state).toBe('resolved');
  });

  it('a clean payment check is arithmetic only and gives no global verdict', async () => {
    const r = await review('clean-payment');
    const text = JSON.stringify(r.result.findings).toLowerCase();
    expect(text).not.toMatch(/valid|enforceable|approved|risk score|all clear/);
  });

  it('control vector and its SIMULATED variant stay separate', () => {
    const base = {
      group: 'settlement',
      statedTotal: { amount: '24000', currency: 'GBP', basis: 'gross' as const, confirmed: true },
      items: [
        {
          lineItemId: 'i1',
          amount: '10000',
          currency: 'GBP',
          basis: 'gross' as const,
          sourceKey: 'a',
          factId: null,
          confirmed: true,
        },
        {
          lineItemId: 'i2',
          amount: '12000',
          currency: 'GBP',
          basis: 'gross' as const,
          sourceKey: 'b',
          factId: null,
          confirmed: true,
        },
      ],
    };
    expect(reconcilePayments({ mode: 'review', ...base })).toMatchObject({
      outcome: 'mismatch',
      comparableSumPence: '2200000',
      differencePence: '200000',
      mode: 'review',
    });
    const sim = reconcilePayments({
      mode: 'simulation',
      ...base,
      items: [need(base.items[0]), { ...need(base.items[1]), amount: '14000' }],
    });
    expect(sim).toMatchObject({ outcome: 'match', differencePence: '0', mode: 'simulation' });
  });

  it.each(['gross-net-mismatch', 'non-gbp'])('%s is not comparable', (id) => {
    const c = byId(id);
    const result = reconcilePayments(c.kernel as Parameters<typeof reconcilePayments>[0]);
    expect(result.outcome).toBe('not_comparable');
    expect(result.reasons).toEqual(c.expected.reasons);
    expect(result.differencePence).toBeNull();
  });

  it('a duplicate source occurrence is not counted twice', async () => {
    const r = await review('duplicate-source');
    expect(payment(r)).toMatchObject({
      outcome: 'not_comparable',
      reasons: ['duplicate_source_occurrence'],
    });
  });

  it('values beyond Number.MAX_SAFE_INTEGER stay exact', () => {
    const big = '9007199254740993'; // pence, above 2^53
    const result = reconcilePayments({
      mode: 'review',
      group: 'settlement',
      statedTotal: {
        amount: '90071992547409.94',
        currency: 'GBP',
        basis: 'gross',
        confirmed: true,
      },
      items: [
        {
          lineItemId: 'i1',
          amount: '90071992547409.93',
          currency: 'GBP',
          basis: 'gross',
          sourceKey: 'a',
          factId: null,
          confirmed: true,
        },
      ],
    });
    expect(result).toMatchObject({
      outcome: 'mismatch',
      statedTotalPence: '9007199254740994',
      comparableSumPence: big,
      differencePence: '1',
    });
  });

  it('rejects ambiguous or malformed amounts instead of guessing', () => {
    const run = (amount: string) =>
      reconcilePayments({
        mode: 'review',
        group: 'g',
        statedTotal: { amount, currency: 'GBP', basis: 'gross', confirmed: true },
        items: [
          {
            lineItemId: 'i',
            amount: '1',
            currency: 'GBP',
            basis: 'gross',
            sourceKey: 'a',
            factId: null,
            confirmed: true,
          },
        ],
      });
    for (const bad of [
      '1e3',
      '1,00',
      '10.123',
      '$10',
      '€10',
      '10 GBP',
      '1,2345',
      '',
      '-5',
      '1000000000000000000',
    ]) {
      expect(run(bad).outcome, bad).toBe('not_comparable');
    }
    expect(run('£1,000.5').statedTotalPence).toBe('100050'); // one fractional digit is 50p
  });

  it('unconfirmed inputs need input in review mode and a partial schedule never matches', () => {
    const input = {
      mode: 'review' as const,
      group: 'g',
      statedTotal: { amount: '100', currency: 'GBP', basis: 'gross' as const, confirmed: true },
      items: [
        {
          lineItemId: 'i',
          amount: '100',
          currency: 'GBP',
          basis: 'gross' as const,
          sourceKey: 'a',
          factId: null,
          confirmed: false,
        },
      ],
    };
    expect(reconcilePayments(input)).toMatchObject({
      outcome: 'needs_input',
      reasons: ['fact_unconfirmed'],
      differencePence: null,
    });
    expect(reconcilePayments({ ...input, items: [] })).toMatchObject({
      outcome: 'needs_input',
      reasons: ['schedule_missing'],
    });
    expect(reconcilePayments({ ...input, mode: 'simulation' }).outcome).toBe('match');
  });
});

describe('other fixtures', () => {
  it('contradictory confirmed facts are reported, never resolved', async () => {
    const r = await review('contradictory-facts');
    const finding = r.result.findings.find(
      (f) => f.checkId === 'conflicting_facts' && f.state === 'attention',
    );
    expect(finding?.explanation).toContain('Agreement date has 2 different confirmed values');
    expect(Object.values(finding?.observed ?? {}).sort()).toEqual(['2026-03-04', '2026-03-14']);
  });

  it('missing adviser evidence is "not confirmed within the selected documents", with the searched scope', async () => {
    const r = await review('missing-adviser-evidence');
    const finding = r.result.findings.find((f) => f.ruleId === 'adviser-insurance');
    expect(finding).toMatchObject({
      state: 'attention',
      references: [],
      searchedDocumentVersionIds: [r.item.versionId],
    });
    expect(finding?.explanation).toBe(
      'Adviser insurance or indemnity evidence has not been confirmed within the selected documents.',
    );
    expect(r.result.checklist.items.find((i) => i.requirement === 'adviser-insurance')?.state).toBe(
      'missing',
    );
  });

  it('supplied versus confirmed evidence, and not_applicable only where a rule permits it', async () => {
    const pack = await loadRulePack();
    if (!pack.ok) throw new Error('pack');
    const sel = (confirmedForCheck: boolean): EvidenceSelectionV1 => ({
      requirement: 'adviser-insurance',
      artifactIds: [uuid()],
      confirmedForCheck,
      notApplicableReason: null,
    });
    expect(
      buildChecklist(pack.data, [sel(false)], true).items.find(
        (i) => i.requirement === 'adviser-insurance',
      )?.state,
    ).toBe('supplied_unreviewed');
    expect(
      buildChecklist(pack.data, [sel(true)], true).items.find(
        (i) => i.requirement === 'adviser-insurance',
      )?.state,
    ).toBe('confirmed_for_check');
    expect(
      buildChecklist(pack.data, [], false).items.every((i) => i.state === 'not_assessed'),
    ).toBe(true);
    const na: EvidenceSelectionV1 = {
      requirement: 'adviser-insurance',
      artifactIds: [],
      confirmedForCheck: false,
      notApplicableReason: 'Employee unrepresented.',
    };
    expect(
      buildChecklist(pack.data, [na], true).items.find((i) => i.requirement === 'adviser-insurance')
        ?.state,
    ).toBe('missing');
  });

  it('repeated quotes and repeated printed labels resolve by physical page and offset', async () => {
    const item = await load('repeated-quote-and-labels');
    const set = await setOf(item);
    const text = item.document.pages[1]?.text ?? '';
    const [a0, a1] = rangeOf(text, '10,000', 1);
    const [b0, b1] = rangeOf(text, '10,000', 2);
    const first = createSourceReference(set, {
      documentVersionId: item.versionId,
      page: 2,
      start: a0,
      end: a1,
    });
    const second = createSourceReference(set, {
      documentVersionId: item.versionId,
      page: 2,
      start: b0,
      end: b1,
    });
    if (!first.ok || !second.ok) throw new Error('refs');
    expect(first.data.quote).toBe(second.data.quote);
    expect(first.data.start).not.toBe(second.data.start);
    expect(resolveSourceReference(set, second.data)).toMatchObject({
      state: 'resolved',
      page: 2,
      start: b0,
    });
    expect(item.document.pages.map((p) => p.index)).toEqual([1, 2]);
    expect(item.document.pages[0]?.text).toContain('Page 1 of 2');
    expect(item.document.pages[1]?.text).toContain('Page 1 of 2');
  });

  it('mixed image and text coverage is partial and warns, never a clean review', async () => {
    const item = await load('mixed-image-text');
    expect(item.kind).toBe('partial_coverage');
    expect(item.document.coverage).toMatchObject({
      status: 'partial',
      pagesWithText: 1,
      pagesWithoutText: 1,
    });
    expect(item.document.coverage.warnings).toEqual(
      expect.arrayContaining(['annotations_present', 'images_not_extracted', 'pages_without_text']),
    );
    const set = await setOf(item);
    const pack = await loadRulePack();
    if (!pack.ok) throw new Error('pack');
    const result = await runChecks({
      matterId: MATTER,
      sources: set,
      integrityFailure: null,
      facts: [],
      evidence: [],
      rulePack: pack.data,
      reviewRecord: demoDraftReview(pack.data.digest),
    });
    if (!result.ok) throw new Error('checks');
    const coverage = result.data.findings.find((f) => f.checkId === 'source_coverage');
    expect(coverage?.state).toBe('attention');
    expect(coverage?.explanation).toContain('Absence of a clause cannot be concluded');
  });

  it('an image-only file has no extractable text and cannot be reviewed as complete', async () => {
    const bytes = new Uint8Array(readFileSync(join(dir, 'pdfs', 'image-only.pdf')));
    const out = await extractPdf(pdfjs, bytes, {
      documentId: uuid(),
      documentVersionId: uuid(),
      sourceArtifactId: uuid(),
      sourceSha256: await sha256Bytes(bytes),
    });
    expect(out).toEqual({ kind: 'no_extractable_text' });
  });

  it('prompt-injection text in a PDF is plain data and confirms nothing', async () => {
    const item = await load('prompt-injection');
    const set = await setOf(item);
    expect(item.document.pages[0]?.text).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    const pack = await loadRulePack();
    if (!pack.ok) throw new Error('pack');
    const result = await runChecks({
      matterId: MATTER,
      sources: set,
      integrityFailure: null,
      facts: [],
      evidence: [],
      rulePack: pack.data,
      reviewRecord: demoDraftReview(pack.data.digest),
    });
    if (!result.ok) throw new Error('checks');
    expect(result.data.checklist.items.some((i) => i.state === 'confirmed_for_check')).toBe(false);
    expect(result.data.payments[0]?.outcome).toBe('needs_input');
    expect(JSON.stringify(result.data.findings)).not.toMatch(/approved|steal/i);
  });

  it('the pound sign survives extraction and parses to pence exactly', async () => {
    const r = await review('pound-sign');
    expect(r.item.document.pages[0]?.text).toContain('£24,000');
    expect(r.facts[0]?.value).toBe('2400000');
  });
});

describe('references, integrity and invalidation', () => {
  it('rejects stale references, other versions, hash tampering and surrogate-pair boundaries', async () => {
    const a = await load('clean-payment');
    const b = await load('discrepancy-2000');
    const only = await setOf(a);
    const ref = createSourceReference(only, {
      documentVersionId: a.versionId,
      page: 2,
      start: 0,
      end: 5,
    });
    if (!ref.ok) throw new Error('ref');
    expect(resolveSourceReference(only, ref.data).state).toBe('resolved');
    expect(resolveSourceReference(only, { ...ref.data, quote: 'wrong' }).state).toBe(
      'integrity_mismatch',
    );
    expect(
      resolveSourceReference(only, { ...ref.data, sourceSha256: `0x${'00'.repeat(32)}` }).state,
    ).toBe('integrity_mismatch');
    expect(
      resolveSourceReference(only, { ...ref.data, documentVersionId: b.versionId }).state,
    ).toBe('unavailable');
    const both = await verifySourceSet(MATTER, [a.loaded, b.loaded], [b.versionId]);
    if (!both.ok) throw new Error('set');
    expect(resolveSourceReference(both.data, ref.data).state).toBe('stale_version');
    expect(
      createSourceReference(both.data, {
        documentVersionId: a.versionId,
        page: 1,
        start: 0,
        end: 1,
      }),
    ).toEqual({ ok: false, code: 'STALE_VERSION' });
    expect(
      createSourceReference(only, { documentVersionId: a.versionId, page: 9, start: 0, end: 1 }),
    ).toEqual({ ok: false, code: 'PAGE_INVALID' });
    expect(
      createSourceReference(only, { documentVersionId: a.versionId, page: 1, start: 5, end: 5 }),
    ).toEqual({ ok: false, code: 'RANGE_INVALID' });

    // Corrupted bytes fail the set; a different file under the same identity does not verify.
    const corrupted = { ...a.loaded, sourceBytes: new Uint8Array([1, 2, 3]) };
    expect(await verifySourceSet(MATTER, [corrupted], [a.versionId])).toEqual({
      ok: false,
      code: 'SOURCE_HASH_MISMATCH',
    });
    const badExtraction = { ...a.loaded, extractionBytes: new TextEncoder().encode('{}') };
    expect(await verifySourceSet(MATTER, [badExtraction], [a.versionId])).toEqual({
      ok: false,
      code: 'EXTRACTION_HASH_MISMATCH',
    });
  });

  it('refuses a range that splits a surrogate pair', async () => {
    const item = await load('clean-payment');
    const doc = structuredClone(item.document);
    const page = doc.pages[0];
    if (page === undefined) throw new Error('page');
    page.text = 'a\u{1F600}b';
    page.items = [];
    const stored = extractionBytes(doc);
    const set = await verifySourceSet(
      MATTER,
      [{ ...item.loaded, extractionBytes: stored, extractionSha256: await sha256Bytes(stored) }],
      [item.versionId],
    );
    if (!set.ok) throw new Error(set.code);
    expect(
      createSourceReference(set.data, {
        documentVersionId: item.versionId,
        page: 1,
        start: 0,
        end: 2,
      }),
    ).toEqual({ ok: false, code: 'SURROGATE_BOUNDARY' });
    expect(
      createSourceReference(set.data, {
        documentVersionId: item.versionId,
        page: 1,
        start: 1,
        end: 3,
      }),
    ).toMatchObject({ ok: true });
  });

  it('a reviewer statement needs a reason and is never a quotation; document text cannot confirm', async () => {
    const item = await load('clean-payment');
    const set = await setOf(item);
    const candidate = {
      schema: 'lexaegis.fact-candidate.v1',
      factId: uuid(),
      matterId: MATTER,
      field: 'employer',
      group: 'settlement',
      slot: 'main',
      value: 'Northwind Demo Ltd',
      provenance: 'reviewer_selection',
      references: [],
    };
    expect(
      await confirmFact({
        set,
        candidate,
        basis: 'reviewer_statement',
        statementReason: ' ',
        confirmedBy: REVIEWER,
        confirmedAt: NOW,
        existing: [],
      }),
    ).toEqual({ ok: false, code: 'REASON_REQUIRED' });
    const ok = await confirmFact({
      set,
      candidate,
      basis: 'reviewer_statement',
      statementReason: 'Stated by the client by phone.',
      confirmedBy: REVIEWER,
      confirmedAt: NOW,
      existing: [],
    });
    expect(ok).toMatchObject({ ok: true, data: { basis: 'reviewer_statement', references: [] } });
    // A candidate cannot arrive pre-confirmed or with unknown fields.
    expect(
      await confirmFact({
        set,
        candidate: { ...candidate, confirmed: true },
        basis: 'source',
        statementReason: null,
        confirmedBy: REVIEWER,
        confirmedAt: NOW,
        existing: [],
      }),
    ).toEqual({ ok: false, code: 'CANDIDATE_INVALID' });
    expect(
      await confirmFact({
        set,
        candidate: { ...candidate, field: 'agreement_date', value: '03/04/2026' },
        basis: 'reviewer_statement',
        statementReason: 'x',
        confirmedBy: REVIEWER,
        confirmedAt: NOW,
        existing: [],
      }),
    ).toEqual({ ok: false, code: 'CANDIDATE_INVALID' });
    expect(
      await confirmFact({
        set,
        candidate: { ...candidate, field: 'agreement_date', value: '2026-02-30' },
        basis: 'reviewer_statement',
        statementReason: 'x',
        confirmedBy: REVIEWER,
        confirmedAt: NOW,
        existing: [],
      }),
    ).toEqual({ ok: false, code: 'CANDIDATE_INVALID' });
  });

  it('input snapshots bind content: any fact, evidence or rule change changes the digest', async () => {
    const r = await review('clean-payment');
    const base = {
      matterId: MATTER,
      sources: [
        {
          documentVersionId: r.item.versionId,
          sourceSha256: r.item.loaded.sourceSha256,
          extractionSha256: r.item.loaded.extractionSha256,
        },
      ],
      facts: r.facts,
      evidence: [] as EvidenceSelectionV1[],
      rulePackDigest: r.rulePack.digest,
      reviewRecordState: 'demo_draft',
    };
    const d0 = await snapshotDigest(buildSnapshot(base));
    expect(await snapshotDigest(buildSnapshot(base))).toBe(d0);
    const corrected = await confirmFact({
      set: await setOf(r.item),
      candidate: {
        schema: 'lexaegis.fact-candidate.v1',
        factId: r.facts[0]?.factId,
        matterId: MATTER,
        field: 'payment_total',
        group: 'settlement',
        slot: 'total',
        value: '2400001',
        provenance: 'reviewer_selection',
        references: r.facts[0]?.references,
      },
      basis: 'source',
      statementReason: null,
      confirmedBy: REVIEWER,
      confirmedAt: NOW,
      existing: r.facts,
      replaces: r.facts[0],
    });
    if (!corrected.ok) throw new Error(corrected.code);
    expect(corrected.data.revision).toBe(2);
    expect(
      await snapshotDigest(
        buildSnapshot({ ...base, facts: [corrected.data, ...r.facts.slice(1)] }),
      ),
    ).not.toBe(d0);
    expect(
      await snapshotDigest(
        buildSnapshot({
          ...base,
          evidence: [
            {
              requirement: 'written-agreement',
              artifactIds: [uuid()],
              confirmedForCheck: true,
              notApplicableReason: null,
            },
          ],
        }),
      ),
    ).not.toBe(d0);
    expect(
      await snapshotDigest(buildSnapshot({ ...base, reviewRecordState: 'reviewed' })),
    ).not.toBe(d0);
  });

  it('enforces the documented selection limits with typed errors', () => {
    expect(
      checkSelectionLimits({
        pdfs: Array.from({ length: 9 }, () => ({ bytes: 1, pages: 1 })),
        extractionBytes: [],
      }),
    ).toEqual({ ok: false, code: 'TOO_MANY_PDFS' });
    expect(checkSelectionLimits({ pdfs: [{ bytes: 1, pages: 81 }], extractionBytes: [] })).toEqual({
      ok: false,
      code: 'TOO_MANY_PAGES_IN_PDF',
    });
    expect(
      checkSelectionLimits({
        pdfs: Array.from({ length: 3 }, () => ({ bytes: 1, pages: 60 })),
        extractionBytes: [],
      }),
    ).toEqual({ ok: false, code: 'TOO_MANY_PAGES' });
    expect(
      checkSelectionLimits({ pdfs: [{ bytes: 21 * 1024 * 1024, pages: 1 }], extractionBytes: [] }),
    ).toEqual({ ok: false, code: 'ORIGINALS_TOO_LARGE' });
    expect(
      checkSelectionLimits({ pdfs: [{ bytes: 1, pages: 1 }], extractionBytes: [3 * 1024 * 1024] }),
    ).toEqual({ ok: false, code: 'EXTRACTION_TOO_LARGE' });
    expect(
      checkSelectionLimits({
        pdfs: [{ bytes: 1, pages: 1 }],
        extractionBytes: [1.5, 1.5, 1.5].map((m) => m * 1024 * 1024),
      }),
    ).toEqual({ ok: false, code: 'EXTRACTIONS_TOO_LARGE' });
    expect(
      checkSelectionLimits({ pdfs: [{ bytes: 1, pages: 1 }], extractionBytes: [1000] }).ok,
    ).toBe(true);
  });
});

describe('comparison of two versions', () => {
  it('shows the changed amount and the negation with references on the correct side', async () => {
    const v1 = await load('version-1');
    const v2 = await load('version-2');
    const set = await verifySourceSet(MATTER, [v1.loaded, v2.loaded], [v1.versionId, v2.versionId]);
    if (!set.ok) throw new Error(set.code);
    const cmp = compareDocumentVersions(set.data, {
      matterId: MATTER,
      oldVersionId: v1.versionId,
      newVersionId: v2.versionId,
    });
    if (!cmp.ok) throw new Error(cmp.code);
    expect(cmp.data).toMatchObject({
      outcome: 'changes',
      originalBytesIdentical: false,
      extractionDiffers: true,
    });
    const removed = cmp.data.spans
      .filter((s) => s.kind === 'removed')
      .flatMap((s) => s.references.map((r) => r.quote));
    const added = cmp.data.spans
      .filter((s) => s.kind === 'added')
      .flatMap((s) => s.references.map((r) => r.quote));
    for (const expected of byId('version-2').expected.removedContains as string[])
      expect(removed.join('|')).toContain(expected);
    for (const expected of byId('version-2').expected.addedContains as string[])
      expect(added.join('|')).toContain(expected);
    // Every reference lives on the side where its text exists, and resolves there.
    for (const span of cmp.data.spans) {
      for (const ref of span.references) {
        expect(ref.documentVersionId).toBe(span.kind === 'removed' ? v1.versionId : v2.versionId);
        expect(resolveSourceReference(set.data, ref).state).toBe('resolved');
      }
    }
    // Identical text, different file: equality of text is not equality of PDFs.
    const same = compareDocumentVersions(set.data, {
      matterId: MATTER,
      oldVersionId: v1.versionId,
      newVersionId: v1.versionId,
    });
    expect(same).toEqual({ ok: false, code: 'SAME_VERSION' });
  });

  it('a larger input needs an explicit page range; an exceeded limit is incomplete, not "no changes"', async () => {
    const item = await load('clean-payment');
    const other = await load('clean-payment');
    const huge = structuredClone(item.document);
    firstPage(huge).text = 'x '.repeat(110_000);
    firstPage(huge).items = [];
    const stored = extractionBytes(huge);
    const hugeLoaded = {
      ...item.loaded,
      extractionBytes: stored,
      extractionSha256: await sha256Bytes(stored),
    };
    const set = await verifySourceSet(
      MATTER,
      [hugeLoaded, other.loaded],
      [item.versionId, other.versionId],
    );
    if (!set.ok) throw new Error(set.code);
    expect(
      compareDocumentVersions(set.data, {
        matterId: MATTER,
        oldVersionId: item.versionId,
        newVersionId: other.versionId,
      }),
    ).toEqual({ ok: false, code: 'COMPARE_INPUT_TOO_LARGE' });
    const ranged = compareDocumentVersions(set.data, {
      matterId: MATTER,
      oldVersionId: item.versionId,
      newVersionId: other.versionId,
      oldPages: [2, 2],
      newPages: [1, 1],
    });
    expect(ranged.ok).toBe(true);

    // Total replacement beyond the edit-distance limit aborts: comparison_incomplete. The clock is
    // frozen for this step so the result is the edit-distance limit itself, not whichever of the
    // two limits a busy machine happens to reach first (the diff takes about a second of CPU and
    // the time limit is two seconds of wall clock).
    vi.useFakeTimers({ toFake: ['Date'] });
    const a = structuredClone(item.document);
    const b = structuredClone(other.document);
    firstPage(a).text = Array.from({ length: 6000 }, (_, i) => `a${i}`).join(' ');
    firstPage(b).text = Array.from({ length: 6000 }, (_, i) => `b${i}`).join(' ');
    firstPage(a).items = [];
    firstPage(b).items = [];
    const sa = extractionBytes(a);
    const sb = extractionBytes(b);
    const set2 = await verifySourceSet(
      MATTER,
      [
        { ...item.loaded, extractionBytes: sa, extractionSha256: await sha256Bytes(sa) },
        { ...other.loaded, extractionBytes: sb, extractionSha256: await sha256Bytes(sb) },
      ],
      [item.versionId, other.versionId],
    );
    if (!set2.ok) throw new Error(set2.code);
    const cmp = compareDocumentVersions(set2.data, {
      matterId: MATTER,
      oldVersionId: item.versionId,
      newVersionId: other.versionId,
      oldPages: [1, 1],
      newPages: [1, 1],
    });
    if (!cmp.ok) throw new Error(cmp.code);
    vi.useRealTimers();
    expect(cmp.data).toMatchObject({
      outcome: 'comparison_incomplete',
      incompleteReason: 'edit_distance',
      spans: [],
    });
  });
});

describe('draft artifacts', () => {
  it('assembles deterministic artifacts, keeps outstanding requirements visible and excludes simulations', async () => {
    const r = await review('discrepancy-2000');
    const snapshot = buildSnapshot({
      matterId: MATTER,
      sources: [
        {
          documentVersionId: r.item.versionId,
          sourceSha256: r.item.loaded.sourceSha256,
          extractionSha256: r.item.loaded.extractionSha256,
        },
      ],
      facts: r.facts,
      evidence: [],
      rulePackDigest: r.rulePack.digest,
      reviewRecordState: 'demo_draft',
    });
    const digest = await snapshotDigest(snapshot);
    const draft = {
      matterId: MATTER,
      snapshotDigest: digest,
      resultSnapshotDigest: digest,
      sources: [
        {
          artifactId: r.item.loaded.sourceArtifactId,
          documentVersionId: r.item.versionId,
          label: 'agreement.pdf',
          bytes: r.item.loaded.sourceBytes,
          extractionArtifactId: r.item.loaded.extractionArtifactId,
          extractionBytes: r.item.loaded.extractionBytes,
        },
      ],
      evidenceFiles: [],
      facts: r.facts,
      findings: r.result.findings,
      payments: r.result.payments,
      checklist: r.result.checklist,
      comparisons: [],
      rulePack: r.rulePack,
      reviewRecord: demoDraftReview(r.rulePack.digest),
      newId: uuid,
    };
    const first = await assembleDraft(draft);
    if (!first.ok) throw new Error(first.code);
    expect(first.data.artifacts.map((a) => a.role).sort()).toEqual([
      'analysis',
      'calculation',
      'checklist',
      'extracted-text',
      'rule-pack',
      'source',
    ]);
    const codes = first.data.outstanding.map((o) => o.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'AGENT_CONFIG_MISSING',
        'DECISION_LOG_MISSING',
        'HUMAN_REVIEW_GATE_PENDING',
        'EVIDENCE_NOT_CONFIRMED',
        'FINDING_UNRESOLVED',
      ]),
    );
    const texts = first.data.artifacts
      .filter((a) => a.mediaType === 'application/json')
      .map((a) => new TextDecoder().decode(a.bytes));
    expect(texts.join('\n')).not.toContain('"mode":"simulation"');
    expect(texts.join('\n')).toContain('"aiAnalysis":false');
    // Original bytes are preserved exactly.
    expect(
      await sha256Bytes(need(first.data.artifacts.find((a) => a.role === 'source')).bytes),
    ).toBe(r.item.loaded.sourceSha256);

    // Stale results, missing dependencies and a mismatched rule-pack record block readiness.
    expect(await assembleDraft({ ...draft, resultSnapshotDigest: `0x${'00'.repeat(32)}` })).toEqual(
      { ok: false, code: 'STALE_RESULT' },
    );
    expect(await assembleDraft({ ...draft, sources: [] })).toEqual({
      ok: false,
      code: 'MISSING_DEPENDENCY',
    });
    expect(
      await assembleDraft({ ...draft, reviewRecord: demoDraftReview(`0x${'11'.repeat(32)}`) }),
    ).toEqual({ ok: false, code: 'RULE_PACK_MISMATCH' });
  });
});
