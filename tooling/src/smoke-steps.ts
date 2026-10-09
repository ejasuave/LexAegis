import { pendingT0IsFailure } from './gates';

/** The ordered golden-path journey (Chapter 14.3). Shared by smoke:local and smoke:testnet. */
export interface SmokeStep {
  readonly id: string;
  readonly title: string;
  /** Chapters whose completion the step depends on. */
  readonly requires: readonly string[];
  readonly assertion: string;
  readonly evidenceClass: 'local_scripted' | 'live_testnet';
}

export const SMOKE_STEPS: readonly SmokeStep[] = [
  {
    id: 'access-and-import',
    title: 'Access the synthetic account, unlock the vault, import the original agreement',
    requires: ['04', '05', '08'],
    assertion: 'Exact bytes and version retained',
    evidenceClass: 'local_scripted',
  },
  {
    id: 'consent-before-send',
    title: 'Inspect the disclosure and explicitly send the selected text',
    requires: ['10'],
    assertion: 'No provider submission before consent',
    evidenceClass: 'local_scripted',
  },
  {
    id: 'assistant-and-citation',
    title: 'Run the assistant; open the citation; verify 2400000 - (1000000 + 1200000) = 200000',
    requires: ['08', '09', '10'],
    assertion: 'Real tool events; citation opens at the right page; amounts are decimal strings',
    evidenceClass: 'local_scripted',
  },
  {
    id: 'human-dispositions',
    title:
      'Confirm facts and record human dispositions (discrepancy accepted with reason, never "corrected")',
    requires: ['10'],
    assertion: 'Integrity or storage failure cannot be waived',
    evidenceClass: 'local_scripted',
  },
  {
    id: 'freeze-save-readback',
    title: 'Freeze, encrypt, save and read back',
    requires: ['05', '10'],
    assertion: 'Approval stays unavailable until capture readiness succeeds',
    evidenceClass: 'local_scripted',
  },
  {
    id: 'approve-send-confirm',
    title:
      'Review the exact action, approve, confirm fee and Send, observe local confirmation, check with the SDK',
    requires: ['04', '06', '10'],
    assertion: 'Saved, signed, broadcast and confirmed stay distinct',
    evidenceClass: 'local_scripted',
  },
  {
    id: 'export-and-verify',
    title: 'Export; import in a separate verifier origin without a session',
    requires: ['05', '10', '11'],
    assertion: 'File match and Active registry state shown separately',
    evidenceClass: 'local_scripted',
  },
  {
    id: 'tamper-detection',
    title: 'Change one artifact byte in a well-formed container',
    requires: ['11'],
    assertion: 'Integrity failure, not a parser error; original export preserved',
    evidenceClass: 'local_scripted',
  },
  {
    id: 'supersede-and-revoke',
    title: 'Import the corrected source, re-review, freeze, approve supersession; cover revocation',
    requires: ['03', '08', '09', '10', '11'],
    assertion: 'Old Superseded and replacement Active from registry and verifier',
    evidenceClass: 'local_scripted',
  },
  {
    id: 'stop-cancellation',
    title: 'Stop during a run',
    requires: ['09', '10'],
    assertion:
      'No new tool dispatch after acknowledgement; no late result replaces the current version',
    evidenceClass: 'local_scripted',
  },
];

export type StepStatus = 'pending' | 'blocked' | 'passed' | 'failed';

export interface StepReport {
  readonly id: string;
  readonly title: string;
  readonly status: StepStatus;
  /** Missing chapters or the missing driver. Empty only for a passed step. */
  readonly dependencies: readonly string[];
}

export type RunStatus = 'passed' | 'incomplete' | 'failed';

export interface SmokeReport {
  readonly steps: readonly StepReport[];
  readonly status: RunStatus;
}

/**
 * Plans a run. A step is pending while a chapter it needs is not complete, and blocked when its
 * prerequisites exist but no browser driver does. Nothing is ever reported as passed here:
 * only a driver that really executed the step may return it, so success cannot be manufactured.
 */
export function planSmoke(options: {
  readonly completedChapters: ReadonlySet<string>;
  readonly drivers: ReadonlyMap<string, StepStatus>;
  readonly now: string;
}): SmokeReport {
  const steps = SMOKE_STEPS.map((step): StepReport => {
    const missing = step.requires.filter((chapter) => !options.completedChapters.has(chapter));
    if (missing.length > 0) {
      return {
        id: step.id,
        title: step.title,
        status: 'pending',
        dependencies: missing.map((c) => `chapter-${c}`),
      };
    }
    const driven = options.drivers.get(step.id);
    if (driven === undefined) {
      return {
        id: step.id,
        title: step.title,
        status: 'blocked',
        dependencies: ['browser-driver'],
      };
    }
    return { id: step.id, title: step.title, status: driven, dependencies: [] };
  });
  const anyFailed = steps.some((step) => step.status === 'failed');
  const allPassed = steps.every((step) => step.status === 'passed');
  // From Gate C entry on, an unfinished T0 step is a failure, not merely an incomplete run.
  const unfinished = steps.some((step) => step.status === 'pending' || step.status === 'blocked');
  const status: RunStatus = allPassed
    ? 'passed'
    : anyFailed || (unfinished && pendingT0IsFailure(options.now))
      ? 'failed'
      : 'incomplete';
  return { steps, status };
}

export function renderStepTable(report: SmokeReport): string {
  const rows = report.steps.map(
    (step, index) =>
      `${String(index + 1).padStart(2)}  ${step.status.padEnd(8)}  ${step.id.padEnd(24)}  ${step.dependencies.join(', ')}`,
  );
  return [
    '#   status    step                      depends on',
    ...rows,
    '',
    `run: ${report.status}`,
  ].join('\n');
}
