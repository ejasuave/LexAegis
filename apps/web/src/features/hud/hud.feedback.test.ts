import { describe, expect, it } from 'vitest';
import { EnvelopeLimiter, ReceiptEffects, RECEIPT_COALESCE_MS } from './hud.effects';
import {
  LOADING_MIN_VISIBLE_MS,
  LOADING_SHOW_AFTER_MS,
  LOADING_STILL_WORKING_MS,
  LoadingGate,
  PositiveEffects,
  detectPositiveEvents,
  selectPendingWork,
  type PendingInput,
  type PendingWork,
  type PositiveContext,
  type PositiveSnapshot,
} from './hud.feedback';

const IDLE: PendingInput = {
  vault: null,
  account: { ceremony: 'idle', backend: 'signed_in' },
  review: {
    loading: false,
    intake: 'idle',
    intakeLabel: null,
    checks: 'none',
    comparison: 'none',
    save: 'saved',
  },
  transaction: 'idle',
  run: null,
  indexerCatchingUp: false,
};

const work = (key: string): PendingWork => ({
  key,
  region: 'analysis',
  sentence: 'Running the checks on this device.',
  step: null,
  cancellable: true,
});

describe('selectPendingWork', () => {
  it('is null when nothing is pending', () => {
    expect(selectPendingWork(IDLE)).toBeNull();
  });
  it('names the real operation and never invents steps', () => {
    const w = selectPendingWork({ ...IDLE, review: { ...IDLE.review, checks: 'running' } });
    expect(w?.sentence).toBe('Running the checks on this device.');
    expect(w?.step).toBeNull();
  });
  it('gives a step count only when the controller knows the total', () => {
    const run = { active: true, operation: 'summary', stepsCompleted: 1, stepsTotal: null };
    expect(selectPendingWork({ ...IDLE, run })?.step).toBeNull();
    expect(selectPendingWork({ ...IDLE, run: { ...run, stepsTotal: 4 } })?.step).toEqual({
      done: 1,
      total: 4,
    });
  });
  it('puts the reviewer-facing wait for a passkey before background work', () => {
    const w = selectPendingWork({
      ...IDLE,
      vault: 'awaiting_passkey',
      review: { ...IDLE.review, checks: 'running' },
    });
    expect(w?.key).toBe('passkey');
  });
});

describe('LoadingGate thresholds', () => {
  it('shows nothing for work shorter than the show-after threshold', () => {
    const gate = new LoadingGate();
    expect(gate.update(work('a'), 0).visible).toBe(false);
    expect(gate.update(work('a'), LOADING_SHOW_AFTER_MS - 1).visible).toBe(false);
    const done = gate.update(null, LOADING_SHOW_AFTER_MS - 1);
    expect(done.visible).toBe(false);
    expect(done.finished).toBeNull();
  });
  it('shows once the threshold passes and schedules its own change', () => {
    const gate = new LoadingGate();
    const first = gate.update(work('a'), 1000);
    expect(first.nextChangeAtMs).toBe(1000 + LOADING_SHOW_AFTER_MS);
    expect(gate.update(work('a'), 1000 + LOADING_SHOW_AFTER_MS).visible).toBe(true);
  });
  it('keeps a shown state for the minimum, then ends and reports it once', () => {
    const gate = new LoadingGate();
    gate.update(work('a'), 0);
    const shownAt = LOADING_SHOW_AFTER_MS;
    expect(gate.update(work('a'), shownAt).visible).toBe(true);
    const held = gate.update(null, shownAt + 10);
    expect(held.visible).toBe(true);
    expect(held.nextChangeAtMs).toBe(shownAt + LOADING_MIN_VISIBLE_MS);
    const ended = gate.update(null, shownAt + LOADING_MIN_VISIBLE_MS);
    expect(ended.visible).toBe(false);
    expect(ended.finished).toBe('Finished: running the checks on this device.');
    expect(gate.update(null, shownAt + LOADING_MIN_VISIBLE_MS + 1).finished).toBeNull();
  });
  it('says "still working" only from real elapsed time', () => {
    const gate = new LoadingGate();
    gate.update(work('a'), 0);
    expect(gate.update(work('a'), 1000).stillWorking).toBe(false);
    expect(gate.update(work('a'), LOADING_STILL_WORKING_MS).stillWorking).toBe(true);
  });
  it('restarts the clock for a different operation', () => {
    const gate = new LoadingGate();
    gate.update(work('a'), 0);
    gate.update(work('a'), 500);
    const next = gate.update(work('b'), 600);
    expect(next.visible).toBe(false);
    expect(next.finished).toBe('Finished: running the checks on this device.');
  });
});

const ctx = (over: Partial<PositiveContext> = {}): PositiveContext => ({
  nowMs: 10_000,
  source: 'live',
  pageVisible: true,
  mode: 'full',
  sameMatter: true,
  ...over,
});
const saved = { kind: 'saved_verified', id: 'm1:3', matterId: 'm1' } as const;

describe('PositiveEffects', () => {
  it('plays once for a verified live event and labels it', () => {
    const out = new PositiveEffects().consume(saved, ctx());
    expect(out.accepted).toBe(true);
    expect(out.play).toBe(true);
    expect(out.label?.text).toBe('Saved and verified.');
    expect(out.announce).toBe('Saved and verified.');
  });
  it('dedupes by stable identity', () => {
    const effects = new PositiveEffects();
    expect(effects.consume(saved, ctx()).accepted).toBe(true);
    expect(effects.consume(saved, ctx({ nowMs: 99_000 })).accepted).toBe(false);
  });
  it('never replays hydration, even if the same event arrives live later', () => {
    const effects = new PositiveEffects();
    expect(effects.consume(saved, ctx({ source: 'hydration' })).accepted).toBe(false);
    expect(effects.consume(saved, ctx()).accepted).toBe(false);
  });
  it('ignores another matter and a hidden tab for the wave', () => {
    const effects = new PositiveEffects();
    expect(effects.consume(saved, ctx({ sameMatter: false })).accepted).toBe(false);
    const hidden = effects.consume({ ...saved, id: 'x' }, ctx({ pageVisible: false }));
    expect(hidden.play).toBe(false);
    expect(hidden.announce).toBeNull();
  });
  it('keeps the label and announcement but skips the wave in reduced and off', () => {
    for (const mode of ['reduced', 'off'] as const) {
      const out = new PositiveEffects().consume(saved, ctx({ mode }));
      expect(out.play).toBe(false);
      expect(out.label).not.toBeNull();
      expect(out.announce).not.toBeNull();
    }
  });
  it('coalesces a second event inside two seconds into history only', () => {
    const effects = new PositiveEffects();
    expect(effects.consume(saved, ctx({ nowMs: 0 })).play).toBe(true);
    const second = effects.consume(
      { ...saved, id: 'm1:4' },
      ctx({ nowMs: RECEIPT_COALESCE_MS - 1 }),
    );
    expect(second.accepted).toBe(true);
    expect(second.play).toBe(false);
    expect(second.log).not.toBeNull();
    const later = effects.consume({ ...saved, id: 'm1:5' }, ctx({ nowMs: RECEIPT_COALESCE_MS }));
    expect(later.play).toBe(true);
  });
  it('shares one envelope window with the receipt effect', () => {
    const limiter = new EnvelopeLimiter();
    const positive = new PositiveEffects(limiter);
    const receipt = new ReceiptEffects(limiter);
    expect(positive.consume(saved, ctx({ nowMs: 0 })).play).toBe(true);
    const out = receipt.consume(
      { kind: 'confirmed', id: 'tx1' },
      {
        nowMs: 500,
        source: 'live',
        pageVisible: true,
        mode: 'full',
        sameMatter: true,
        networkLabel: 'Monad testnet',
      },
    );
    expect(out.accepted).toBe(true);
    expect(out.play).toBe(false);
  });
});

const snap = (over: Partial<PositiveSnapshot> = {}): PositiveSnapshot => ({
  matterId: 'm1',
  factIds: ['f1'],
  checks: 'fresh',
  checksDigest: 'd1',
  saveInFlight: false,
  savedVerified: false,
  saveRevision: 1,
  findingsTotal: 2,
  findingsUnresolved: 2,
  evidenceItems: 2,
  evidenceUnsatisfied: 2,
  ...over,
});

describe('detectPositiveEvents', () => {
  it('yields nothing for the first snapshot, a changed matter or no change', () => {
    expect(detectPositiveEvents(null, snap())).toEqual([]);
    expect(detectPositiveEvents(snap({ matterId: 'm0', factIds: [] }), snap())).toEqual([]);
    expect(detectPositiveEvents(snap(), snap())).toEqual([]);
  });
  it('detects a new fact, a finished analysis, a verified save, resolution and evidence', () => {
    const before = snap({ checks: 'running', saveInFlight: true });
    const after = snap({
      factIds: ['f1', 'f2'],
      checks: 'fresh',
      savedVerified: true,
      findingsUnresolved: 0,
      evidenceUnsatisfied: 0,
    });
    const kinds = detectPositiveEvents(before, after).map((e) => e.kind);
    expect(kinds).toEqual([
      'fact_confirmed',
      'analysis_completed',
      'saved_verified',
      'findings_resolved',
      'evidence_complete',
    ]);
  });
  it('does not call a save verified unless one was in flight', () => {
    const before = snap({ saveInFlight: false, savedVerified: false });
    const after = snap({ saveInFlight: false, savedVerified: true });
    expect(detectPositiveEvents(before, after)).toEqual([]);
  });
  it('does not celebrate findings that were never open or a checklist that was always empty', () => {
    const before = snap({ findingsTotal: 0, findingsUnresolved: 0, evidenceItems: 0 });
    const after = snap({ findingsTotal: 0, findingsUnresolved: 0, evidenceItems: 0 });
    expect(detectPositiveEvents(before, after)).toEqual([]);
  });
});
