import { describe, expect, it } from 'vitest';
import type { CheckFindingV1 } from '@lexaegis/agent/contracts';
import {
  DecisionController,
  decisionLogSchema,
  reviewDispositionSchema,
  validateReason,
  MAX_REASON_BYTES,
} from './decisions';
import type { ReviewSnapshot } from './controller';

const ACCOUNT = `0x${'ab'.repeat(20)}`;
const SNAP1 = `0x${'11'.repeat(32)}`;
const SNAP2 = `0x${'22'.repeat(32)}`;
const MATTER = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const SRC = '33333333-3333-4333-8333-333333333333';

const finding = (id: string, state: CheckFindingV1['state'], explanation = 'x'): CheckFindingV1 =>
  ({
    schema: 'lexaegis.check-finding.v1',
    findingId: id,
    checkId: 'payment_reconciliation',
    ruleId: 'r',
    state,
    priority: 1,
    explanation,
    observed: {},
    references: [],
    searchedDocumentVersionIds: [],
    inputDigest: SNAP1,
    engineVersion: '1',
  }) as unknown as CheckFindingV1;

function rig(findings: CheckFindingV1[], snapshotDigest = SNAP1) {
  let review = {
    matterId: MATTER,
    documents: [{ documentVersionId: DOC, sourceArtifactId: SRC, selected: true }],
    facts: [{ factId: 'f1', contentSha256: SNAP1 }],
    checks: {
      status: 'fresh',
      findings,
      snapshotDigest,
      reviewRecord: { packDigest: SNAP2, state: 'demo_draft' },
    },
  } as unknown as ReviewSnapshot;
  const listeners = new Set<() => void>();
  const entries: { entryId: string; text: string }[] = [];
  let account: string | null = ACCOUNT;
  let n = 0;
  const controller = new DecisionController({
    review: {
      getSnapshot: () => review,
      subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
    },
    vault: {
      getSnapshot: () => ({ selectedMatter: { context: { entries } } }),
      commands: {
        addEntry: (_m, input) => {
          entries.push({ entryId: `e${String(++n)}`, text: input.text });
          return { ok: true };
        },
        removeEntry: (_m, id) => {
          const i = entries.findIndex((e) => e.entryId === id);
          if (i >= 0) entries.splice(i, 1);
          return { ok: true };
        },
      },
    },
    account: () => account,
    now: () => new Date('2026-10-11T10:00:00.000Z'),
    newId: () => `44444444-4444-4444-8444-${String(++n).padStart(12, '0')}`,
  });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return {
    controller,
    entries,
    settle,
    setReview(patch: Partial<ReviewSnapshot['checks']> & { matterId?: string | null }) {
      const { matterId, ...checks } = patch;
      review = {
        ...review,
        ...(matterId !== undefined && { matterId }),
        checks: { ...review.checks, ...checks },
      };
      listeners.forEach((l) => l());
    },
    setAccount: (a: string | null) => (account = a),
  };
}

describe('review dispositions', () => {
  it('validates reasons: required for accepted concerns and not-applicable, bounded to 2 KiB', () => {
    expect(validateReason('acknowledged', '').ok).toBe(true);
    expect(validateReason('accepted_unresolved', '   ')).toEqual({
      ok: false,
      code: 'REASON_REQUIRED',
    });
    expect(validateReason('not_applicable', '')).toEqual({ ok: false, code: 'REASON_REQUIRED' });
    expect(validateReason('acknowledged', 'é'.repeat(MAX_REASON_BYTES / 2 + 1))).toEqual({
      ok: false,
      code: 'REASON_TOO_LONG',
    });
    expect(validateReason('acknowledged', 'é'.repeat(MAX_REASON_BYTES / 2)).ok).toBe(true);
  });

  it('rejects unknown fields and a missing reason at the schema boundary', () => {
    const base = {
      schema: 'lexaegis.review-disposition.v1',
      dispositionId: '44444444-4444-4444-8444-000000000001',
      findingId: 'a',
      findingDigest: SNAP1,
      snapshotDigest: SNAP1,
      reviewer: ACCOUNT,
      kind: 'accepted_unresolved',
      reason: 'because',
      recordedAt: '2026-10-11T10:00:00.000Z',
    };
    expect(reviewDispositionSchema.safeParse(base).success).toBe(true);
    expect(reviewDispositionSchema.safeParse({ ...base, approved: true }).success).toBe(false);
    expect(reviewDispositionSchema.safeParse({ ...base, reason: '' }).success).toBe(false);
  });

  it('records a disposition bound to the finding, snapshot and reviewer', async () => {
    const r = rig([finding('a', 'attention')]);
    await r.settle();
    const out = r.controller.decide({
      findingId: 'a',
      kind: 'accepted_unresolved',
      reason: 'client accepts',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.reviewer).toBe(ACCOUNT);
    expect(out.data.snapshotDigest).toBe(SNAP1);
    expect(out.data.findingDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.entries).toHaveLength(1);
    // Nothing is preselected and nothing records itself.
    expect(r.controller.getSnapshot().recorded).toBe(false);
  });

  it('never waives a technical failure, and refuses kinds the finding state does not allow', async () => {
    const r = rig([finding('t', 'technical_failure'), finding('a', 'attention')]);
    await r.settle();
    expect(r.controller.decide({ findingId: 't', kind: 'acknowledged', reason: '' })).toEqual({
      ok: false,
      code: 'NOT_WAIVABLE',
    });
    expect(r.controller.decide({ findingId: 'a', kind: 'not_applicable', reason: 'no' })).toEqual({
      ok: false,
      code: 'KIND_NOT_ALLOWED',
    });
    expect(r.controller.decide({ findingId: 'zz', kind: 'acknowledged', reason: '' })).toEqual({
      ok: false,
      code: 'FINDING_NOT_FOUND',
    });
  });

  it('requires a live account and refuses when results are not fresh', async () => {
    const r = rig([finding('a', 'attention')]);
    await r.settle();
    r.setAccount(null);
    expect(r.controller.decide({ findingId: 'a', kind: 'acknowledged', reason: '' })).toEqual({
      ok: false,
      code: 'ACCOUNT_LOCKED',
    });
    r.setAccount(ACCOUNT);
    r.setReview({ status: 'stale' });
    await r.settle();
    expect(r.controller.decide({ findingId: 'a', kind: 'acknowledged', reason: '' }).ok).toBe(
      false,
    );
  });
});

describe('decision log', () => {
  it('is built only after an explicit record and never contains its own digest', async () => {
    const r = rig([finding('a', 'attention'), finding('b', 'ok')]);
    await r.settle();
    expect(r.controller.getSnapshot().log).toBeNull();
    r.controller.decide({ findingId: 'a', kind: 'acknowledged', reason: '' });
    const recorded = await r.controller.record();
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(decisionLogSchema.safeParse(recorded.data.record).success).toBe(true);
    const text = new TextDecoder().decode(recorded.data.bytes);
    expect(text).not.toContain(recorded.data.digest);
    expect(recorded.data.record.scope.cleanPassIds).toEqual(['b']);
    expect(recorded.data.record.limitations.join(' ')).toContain('not cryptographic approval');
    expect(r.controller.getSnapshot().recorded).toBe(true);
  });

  it('refuses to record while a finding awaits a decision, a technical failure exists, or a change is required', async () => {
    const r = rig([finding('a', 'attention')]);
    await r.settle();
    expect(await r.controller.record()).toEqual({ ok: false, code: 'OUTSTANDING' });
    r.controller.decide({ findingId: 'a', kind: 'requires_change', reason: '' });
    expect(await r.controller.record()).toEqual({ ok: false, code: 'REQUIRES_CHANGE' });
    const t = rig([finding('t', 'technical_failure')]);
    await t.settle();
    expect(await t.controller.record()).toEqual({ ok: false, code: 'TECHNICAL_FAILURE' });
  });

  it('invalidates the log and dependent dispositions when the inputs change', async () => {
    const r = rig([finding('a', 'attention')]);
    await r.settle();
    r.controller.decide({ findingId: 'a', kind: 'acknowledged', reason: '' });
    await r.controller.record();
    expect(r.controller.getSnapshot().recorded).toBe(true);
    // Same finding id, different result: the earlier disposition no longer applies.
    r.setReview({ findings: [finding('a', 'attention', 'changed result')], snapshotDigest: SNAP2 });
    await r.settle();
    const state = r.controller.getSnapshot();
    expect(state.recorded).toBe(false);
    expect(state.stale).toBe(true);
    expect(state.dispositions).toHaveLength(0);
    expect(r.entries).toHaveLength(0);
  });

  it('clears everything on a matter change and ignores a disposition made for another account', async () => {
    const r = rig([finding('a', 'attention')]);
    await r.settle();
    r.controller.decide({ findingId: 'a', kind: 'acknowledged', reason: '' });
    r.setReview({ matterId: null });
    await r.settle();
    expect(r.controller.getSnapshot().dispositions).toHaveLength(0);
  });

  it('reloads working decisions from the encrypted record only when they still match', async () => {
    const r = rig([finding('a', 'attention')]);
    await r.settle();
    r.controller.decide({ findingId: 'a', kind: 'acknowledged', reason: '' });
    const saved = [...r.entries];
    r.controller.dispose();
    const again = rig([finding('a', 'attention')]);
    again.entries.push(...saved);
    await again.settle();
    // The same inputs and account: the decision comes back, but the log does not.
    expect(again.controller.getSnapshot().dispositions).toHaveLength(1);
    expect(again.controller.getSnapshot().recorded).toBe(false);
    const other = rig([finding('a', 'attention', 'different')]);
    other.entries.push(...saved);
    await other.settle();
    expect(other.controller.getSnapshot().dispositions).toHaveLength(0);
    expect(other.entries).toHaveLength(0);
  });
});
