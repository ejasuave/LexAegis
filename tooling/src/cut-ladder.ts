/** Ordered cut ladder (Chapter 14.3). The earlier a step, the sooner it goes. */
export const CUT_LADDER = [
  'voice',
  'documentComparison',
  'matterBriefing',
  'reputationFeedback',
  'nonessential-orb-animation',
  'history-ui-polish',
  'fixture-target-twelve-to-eight',
  'agentIdentity',
  'matterNotes',
] as const;
export type CutStep = (typeof CUT_LADDER)[number];

/** Never cut: these are the product. Nothing protecting them may be cut either. */
export const NEVER_CUT = [
  'real-signature',
  'real-monad-transaction',
  'independent-verifier-with-tamper-failure',
  'honest-status-labels',
  'stop',
  'explicit-approval',
  'consent',
  'encryption',
  'save-and-read-back',
  'limits',
  'authorisation-checks',
  'envio-pipeline',
] as const;

export const MIN_FIXTURES = 8;
export const STRETCH_FIXTURES = 12;

export interface AppliedCut {
  readonly step: string;
  readonly reason: string;
  readonly date: string;
  readonly affectedChecks: readonly string[];
}

export type CutIssue =
  | 'UNKNOWN_STEP'
  | 'NEVER_CUT'
  | 'DUPLICATE_CUT'
  | 'OUT_OF_ORDER'
  | 'MISSING_REASON'
  | 'NO_AFFECTED_CHECKS'
  | 'BACKDATED';

/** Checks that recorded cuts follow the ladder in order, one at a time, with a reason and date. */
export function validateAppliedCuts(cuts: readonly AppliedCut[]): CutIssue[] {
  const issues: CutIssue[] = [];
  const seen = new Set<string>();
  let highest = -1;
  let previousDate = Number.NEGATIVE_INFINITY;
  const never: readonly string[] = NEVER_CUT;
  for (const cut of cuts) {
    if (never.includes(cut.step)) issues.push('NEVER_CUT');
    const index = (CUT_LADDER as readonly string[]).indexOf(cut.step);
    if (index === -1) {
      if (!never.includes(cut.step)) issues.push('UNKNOWN_STEP');
      continue;
    }
    if (seen.has(cut.step)) issues.push('DUPLICATE_CUT');
    seen.add(cut.step);
    // A step may be cut only after every earlier step has been.
    for (let earlier = 0; earlier < index; earlier += 1) {
      const name = CUT_LADDER[earlier];
      if (name !== undefined && !seen.has(name)) {
        issues.push('OUT_OF_ORDER');
        break;
      }
    }
    if (index < highest) issues.push('OUT_OF_ORDER');
    highest = Math.max(highest, index);
    if (cut.reason.trim() === '') issues.push('MISSING_REASON');
    if (cut.affectedChecks.length === 0) issues.push('NO_AFFECTED_CHECKS');
    const when = Date.parse(cut.date);
    if (when < previousDate) issues.push('BACKDATED');
    previousDate = when;
  }
  return issues;
}

/** The fixture requirement after cuts: 12 normally, 8 once the ladder reaches that step. Never below 8. */
export function requiredFixtures(cuts: readonly AppliedCut[]): number {
  return cuts.some((cut) => cut.step === 'fixture-target-twelve-to-eight')
    ? MIN_FIXTURES
    : STRETCH_FIXTURES;
}
