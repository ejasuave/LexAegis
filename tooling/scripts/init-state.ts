/** One-time, idempotent additive migration of docs/build-state.json for Chapter 14. Existing sections are untouched. */
import { join } from 'node:path';
import { CUT_LADDER, MIN_FIXTURES, NEVER_CUT, STRETCH_FIXTURES } from '../src/cut-ladder';
import { readState, writeAtomic } from '../src/evidence-writer';
import { GATE_CUTOFFS, SUBMISSION_TARGETS } from '../src/gates';
import { FEATURES, initialStatus } from '../src/register';
import { validateBuildState } from '../src/state';
import { ROOT } from './lib';

const state = readState(ROOT);
const next: Record<string, unknown> = { ...state };

next.tiers ??= {
  schemaVersion: 1,
  features: FEATURES.map((feature) => ({
    id: feature.id,
    tier: feature.tier,
    chapter: feature.chapter,
    status: initialStatus(feature.id),
    evidence: [],
  })),
};
next.results ??= [];
next.appliedCuts ??= [];
next.gates ??= {
  schemaVersion: 1,
  note: 'Computed from recorded results by pnpm readiness. Evidence lives in results; these are never edited by hand.',
  targets: GATE_CUTOFFS,
  submission: SUBMISSION_TARGETS,
  evaluations: [],
};
next.cutLadder ??= {
  order: CUT_LADDER,
  neverCut: NEVER_CUT,
  fixtureTargets: { required: MIN_FIXTURES, stretch: STRETCH_FIXTURES },
};

const issues = validateBuildState(next);
if (issues.length > 0) throw new Error(`state would be invalid: ${JSON.stringify(issues)}`);
await writeAtomic(join(ROOT, 'docs', 'build-state.json'), JSON.stringify(next));
console.log('build-state extended (existing sections preserved)');
