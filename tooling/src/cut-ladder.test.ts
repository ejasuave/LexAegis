import { describe, expect, it } from 'vitest';
import { CUT_LADDER, NEVER_CUT, requiredFixtures, validateAppliedCuts } from './cut-ladder';

const cut = (step: string, date = '2026-10-10T10:00:00+01:00') => ({
  step,
  reason: 'Behind schedule at Gate C',
  date,
  affectedChecks: ['smoke:local'],
});

describe('cut ladder', () => {
  it('has the agreed order', () => {
    expect([...CUT_LADDER]).toEqual([
      'voice',
      'documentComparison',
      'matterBriefing',
      'reputationFeedback',
      'nonessential-orb-animation',
      'history-ui-polish',
      'fixture-target-twelve-to-eight',
      'agentIdentity',
      'matterNotes',
    ]);
  });

  it('accepts cuts applied in order with reason, date and affected checks', () => {
    expect(
      validateAppliedCuts([cut('voice'), cut('documentComparison'), cut('matterBriefing')]),
    ).toEqual([]);
  });

  it('rejects skipping ahead, repeats, unknown steps and missing reasons or checks', () => {
    expect(validateAppliedCuts([cut('agentIdentity')])).toContain('OUT_OF_ORDER');
    expect(validateAppliedCuts([cut('voice'), cut('voice')])).toContain('DUPLICATE_CUT');
    expect(validateAppliedCuts([cut('telemetry')])).toContain('UNKNOWN_STEP');
    expect(validateAppliedCuts([{ ...cut('voice'), reason: ' ' }])).toContain('MISSING_REASON');
    expect(validateAppliedCuts([{ ...cut('voice'), affectedChecks: [] }])).toContain(
      'NO_AFFECTED_CHECKS',
    );
  });

  it('rejects backdated cuts', () => {
    expect(
      validateAppliedCuts([
        cut('voice', '2026-10-10T10:00:00+01:00'),
        cut('documentComparison', '2026-10-09T10:00:00+01:00'),
      ]),
    ).toContain('BACKDATED');
  });

  it('never allows a protected control to be cut', () => {
    for (const control of NEVER_CUT) {
      expect(validateAppliedCuts([cut(control)])).toEqual(['NEVER_CUT']);
    }
    expect(NEVER_CUT).toEqual(
      expect.arrayContaining([
        'real-signature',
        'real-monad-transaction',
        'stop',
        'explicit-approval',
        'envio-pipeline',
      ]),
    );
  });

  it('lowers the fixture target to eight and no lower', () => {
    expect(requiredFixtures([])).toBe(12);
    expect(requiredFixtures([cut('fixture-target-twelve-to-eight')])).toBe(8);
  });
});
