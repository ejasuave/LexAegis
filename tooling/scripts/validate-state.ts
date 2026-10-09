/** Validates docs/build-state.json (Chapter 14 sections) with real path checks. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readState } from '../src/evidence-writer';
import { validateAppliedCuts, type AppliedCut } from '../src/cut-ladder';
import { validateBuildState } from '../src/state';
import { ROOT } from './lib';

const state = readState(ROOT);
const issues = validateBuildState(state, { pathExists: (path) => existsSync(join(ROOT, path)) });
const cuts = validateAppliedCuts((state.appliedCuts as AppliedCut[] | undefined) ?? []);
for (const issue of issues) console.error(`${issue.code} at ${issue.path}`);
for (const cut of cuts) console.error(`CUT ${cut}`);
console.log(
  issues.length + cuts.length === 0
    ? 'build-state is valid'
    : `${issues.length + cuts.length} problem(s)`,
);
process.exit(issues.length + cuts.length === 0 ? 0 : 1);
