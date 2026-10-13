import { describe, expect, it } from 'vitest';
import { chooseSelectedFinding, paymentGap, categoryLabel } from './hud.finding';
import { buildHudFixture } from './hud.fixtures';
import { selectNotices } from './hud.selectors';
import type { HudInput } from './hud.types';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const base = buildHudFixture('idle', NOW);
const none = { transactionReason: null, receiptCorrection: false };
const ids = (input: HudInput, extras = none) => selectNotices(input, extras).map((n) => n.id);
const withCeiling = (patch: Partial<HudInput['ceiling']>): HudInput => ({
  ...base,
  ceiling: { ...base.ceiling, ...patch },
});

describe('notices for non-happy paths', () => {
  it('shows nothing when everything is as expected', () => {
    expect(ids(base)).toEqual([]);
  });

  it('names an unsupported passkey and an unconfigured account without pretending locked', () => {
    expect(
      ids(withCeiling({ account: { ...base.ceiling.account, availability: 'unsupported' } })),
    ).toContain('passkey-unsupported');
    expect(
      ids(withCeiling({ account: { ...base.ceiling.account, availability: 'misconfigured' } })),
    ).toContain('account-unavailable');
  });

  it('says a session expired, with a recovery that signs and approves nothing', () => {
    const input = withCeiling({
      account: { ...base.ceiling.account, signing: 'locked', lastEvent: 'signing_expired' },
    });
    const notice = selectNotices(input, none).find((n) => n.id === 'session-expired');
    expect(notice?.body).toMatch(/Nothing was approved or signed/);
    expect(notice?.action?.href).toBe('/vault');
  });

  it('states what a vault lock does and does not do', () => {
    const notice = selectNotices(withCeiling({ vaultLabel: 'Locked' }), none).find(
      (n) => n.id === 'vault-locked',
    );
    expect(notice?.body).toMatch(/cannot retract anything already sent/);
    expect(ids(withCeiling({ vaultLabel: 'Saved' }))).not.toContain('vault-locked');
  });

  it('distinguishes unsaved, conflict, failed read-back and unavailable', () => {
    const check = (label: string, id: string) =>
      expect(ids(withCeiling({ vaultLabel: label }))).toContain(id);
    check('Unsaved changes', 'vault-unsaved');
    check('Conflict', 'vault-conflict');
    check('Recovery failed', 'vault-recovery');
    check('Vault unavailable', 'vault-unavailable');
  });

  it('separates a budget failure, a tool failure, a cancel, an interruption and an offline service', () => {
    const run = base.assistant.activeRun;
    expect(run).toBeNull();
    const failed = (code: string | null, message: string | null) =>
      selectNotices(buildFailed(code, message), none).find((n) => n.id === 'run-failed');
    expect(failed('BUDGET_EXHAUSTED', 'x')?.title).toMatch(/budget/);
    expect(failed('INTERNAL', 'The payment check could not read the schedule.')?.body).toBe(
      'The payment check could not read the schedule.',
    );
    const orb = (value: HudInput['assistant']['orb']): HudInput => ({
      ...base,
      assistant: { ...buildFailed(null, null).assistant, orb: value },
    });
    expect(ids(orb('cancelled'))).toContain('run-cancelled');
    expect(ids(orb('interrupted'))).toContain('run-interrupted');
    expect(ids(buildHudFixture('offline', NOW))).toContain('assistant-offline');
  });

  it('warns about indexer lag as history only, never as the registry state', () => {
    const indexer = base.ceiling.indexer;
    if (indexer === null) throw new Error('the fixture has an indexer reading');
    const stale = withCeiling({ indexer: { ...indexer, observedAtMs: NOW - 600_000 } });
    const notice = selectNotices(stale, none).find((n) => n.id === 'indexer-lag');
    expect(notice?.body).toMatch(/live registry read decides/);
  });

  it('keeps reverted, unknown, rejected-signing and a withdrawn confirmation apart, and never offers a retry', () => {
    const tx = (stage: HudInput['ceiling']['transaction']['stage'], may = false) =>
      withCeiling({ transaction: { stage, mayHaveBroadcast: may } });
    expect(ids(tx('reverted'))).toContain('tx-reverted');
    expect(
      selectNotices(tx('unknown', true), none).find((n) => n.id === 'tx-unknown')?.body,
    ).toMatch(/do not send it again/);
    const rejected = selectNotices(tx('failed'), { ...none, transactionReason: 'USER_CANCELLED' });
    expect(rejected.find((n) => n.id === 'tx-not-sent')?.title).toMatch(
      /Signing was not completed/,
    );
    expect(ids(tx('confirmed'), { ...none, receiptCorrection: true })).toContain(
      'receipt-correction',
    );
    for (const notice of selectNotices(tx('reverted', true), none)) {
      expect(notice.action?.label ?? '').not.toMatch(/retry|resend|sign again|send again/i);
    }
  });
});

function buildFailed(code: string | null, message: string | null): HudInput {
  const failedFixture = buildHudFixture('failed', NOW);
  const run = failedFixture.assistant.activeRun;
  return {
    ...failedFixture,
    assistant: {
      ...failedFixture.assistant,
      activeRun: run === null ? null : { ...run, failureCode: code, failureMessage: message },
    },
  };
}

describe('selected finding', () => {
  const f = (
    id: string,
    state: 'attention' | 'needs_input' | 'technical_failure' | 'ok',
    priority: number,
    resolved = false,
  ) => ({
    id,
    state,
    priority,
    resolved,
  });
  it('honours an explicit choice that still exists', () => {
    expect(chooseSelectedFinding([f('a', 'attention', 1), f('b', 'ok', 2)], 'b')).toEqual({
      id: 'b',
      reason: 'chosen',
    });
  });
  it('otherwise picks a failure over attention over input, then by priority, skipping resolved ones', () => {
    const list = [
      f('a', 'attention', 1),
      f('b', 'technical_failure', 9),
      f('c', 'needs_input', 0),
      f('d', 'attention', 0, true),
    ];
    expect(chooseSelectedFinding(list, null)).toEqual({
      id: 'b',
      reason: 'highest_priority_unresolved',
    });
    expect(chooseSelectedFinding(list, 'gone')?.id).toBe('b');
    expect(chooseSelectedFinding([f('a', 'attention', 1, true), f('z', 'ok', 5)], null)).toEqual({
      id: 'a',
      reason: 'first_listed',
    });
    expect(chooseSelectedFinding([], null)).toBeNull();
  });
});

describe('finding figures', () => {
  it('classifies the calculator’s difference without computing money', () => {
    expect(paymentGap({ difference: '-12500' })).toEqual({ kind: 'gap', minor: '-12500' });
    expect(paymentGap({ difference: '0' })).toEqual({ kind: 'none' });
    expect(paymentGap({ difference: 'n/a' })).toEqual({ kind: 'unknown' });
    expect(paymentGap({})).toEqual({ kind: 'unknown' });
    expect(paymentGap({ difference: '1.5' })).toEqual({ kind: 'unknown' });
  });
  it('names checks in plain words', () => {
    expect(categoryLabel('payment_reconciliation')).toBe('Payment arithmetic');
    expect(categoryLabel('new_check')).toBe('Check');
  });
});
