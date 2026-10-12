/**
 * pnpm validate:mvp
 *
 * The one bounded entry point for the local software gate: existing lint, type, schema, unit,
 * contract, build and pack commands, then the Chapter 12 system cases, run one after another with a
 * deadline each. It needs no sponsor secret and no paid service. A hung stage is stopped together
 * with every process it started.
 *
 * It writes a versioned, closed report (docs/system-validation/report.json) built ONLY from real exit
 * statuses and the JSON a test run wrote, bound to the commit, the dirty-worktree state and digests of
 * allowlisted non-secret inputs. Missing results, required skips, blocked prerequisites, an unselected
 * stage and a run that selected no tests are all non-passing. A failing case is never retried to
 * green: a failed spec file is re-run once ONLY to diagnose, and a failure that then passes stays a
 * failure carrying FLAKY_RESULT until the cause is fixed.
 *
 *   --only <id,id>      run only these stages (partial: the report says so and cannot pass)
 *   --skip <id,id>      leave these stages out (same)
 *   --no-rerun          no diagnostic re-run of a failed spec file
 *   --out <path>        report path (default docs/system-validation/report.json)
 *   --check [path]      validate an existing report (schema, completeness, paths, outcome, binding
 *                       to the current source); runs nothing
 *   --list              print the stages and exit
 *
 * Exit codes: 0 pass; 1 a required stage or case failed; 3 blocked or incomplete (a prerequisite is
 * missing, something did not run); 4 the report is invalid, stale or not sanitised; 2 usage.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { writeAtomic } from '../src/evidence-writer';
import { sourceFingerprint } from '../src/fingerprint';
import { processTree, runBounded, stopProcessTree } from '../src/privacy/run-bounded';
import { scanSecretFiles } from '../src/secrets';
import {
  DIGEST_INPUTS,
  REPORT_SCHEMA,
  computeOutcome,
  deriveCases,
  digestOf,
  optionalDigestOf,
  readVitestJson,
  reportSchema,
  sanitisationProblems,
  sha256Of,
  validateReport,
  type CaseResult,
  type Evidence,
  type Issue,
  type RecordedResult,
  type StageResult,
  type TestOutcome,
  type ValidationReport,
} from '../src/validation';
import { SYSTEM_CASES } from '../../tests/system/harness/cases';
import { readResults } from '../../tests/system/harness/recorder';
import { ROOT, gitRevision } from './lib';

interface StageDef {
  readonly id: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly evidenceClass: Evidence;
  /** A stage that cannot run unless another passed (a toolchain, for example). */
  readonly needs?: string;
  /** The id of the test group it reports into, for stages that run test files. */
  readonly kind?: 'tests-unit' | 'tests-system';
}

const MINUTE = 60_000;
export const STAGES: readonly StageDef[] = [
  { id: 'lint', args: ['lint'], timeoutMs: 15 * MINUTE, evidenceClass: 'unit' },
  { id: 'typecheck', args: ['typecheck'], timeoutMs: 15 * MINUTE, evidenceClass: 'unit' },
  { id: 'unit-tests', args: ['test'], timeoutMs: 20 * MINUTE, evidenceClass: 'unit' },
  { id: 'fixtures', args: ['fixtures:check'], timeoutMs: 5 * MINUTE, evidenceClass: 'unit' },
  {
    id: 'protocol-schemas',
    args: ['protocol:check'],
    timeoutMs: 5 * MINUTE,
    evidenceClass: 'unit',
  },
  {
    id: 'agent-prompts',
    args: ['agent:prompts:check'],
    timeoutMs: 5 * MINUTE,
    evidenceClass: 'unit',
  },
  { id: 'state', args: ['state:validate'], timeoutMs: 2 * MINUTE, evidenceClass: 'unit' },
  { id: 'secrets', args: ['secrets:check'], timeoutMs: 5 * MINUTE, evidenceClass: 'unit' },
  { id: 'exclusion', args: ['exclusion:check'], timeoutMs: 5 * MINUTE, evidenceClass: 'unit' },
  { id: 'build', args: ['build'], timeoutMs: 20 * MINUTE, evidenceClass: 'local_integration' },
  {
    id: 'packages',
    args: ['packages:check'],
    timeoutMs: 20 * MINUTE,
    evidenceClass: 'local_integration',
  },
  {
    id: 'contracts-toolchain',
    args: ['contracts:toolchain'],
    timeoutMs: 10 * MINUTE,
    evidenceClass: 'unit',
  },
  {
    id: 'contracts-tests',
    args: ['contracts:test'],
    timeoutMs: 20 * MINUTE,
    evidenceClass: 'local_integration',
    needs: 'contracts-toolchain',
  },
  {
    id: 'contracts-integration',
    args: ['test:contracts:integration'],
    timeoutMs: 20 * MINUTE,
    evidenceClass: 'local_integration',
    needs: 'contracts-toolchain',
  },
  {
    id: 'system-harness',
    args: [],
    timeoutMs: 5 * MINUTE,
    evidenceClass: 'unit',
    kind: 'tests-unit',
  },
  {
    id: 'system-cases',
    args: [],
    timeoutMs: 90 * MINUTE,
    evidenceClass: 'browser_scripted',
    kind: 'tests-system',
  },
];

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const list = (name: string): string[] | undefined => option(name)?.split(',').filter(Boolean);
const outPath = join(ROOT, option('--out') ?? 'docs/system-validation/report.json');
const manifestIds = SYSTEM_CASES.map((c) => c.id);
const requiredStageIds = STAGES.map((s) => s.id);

// ---------------------------------------------------------------------------------------------------

function source(): ValidationReport['source'] {
  const revision = gitRevision();
  const fixtureNames = [
    'account-v1',
    'documents-v1',
    'protocol-interop-v1',
    'protocol-v1',
    'registry-v1',
    'vault-v1',
  ];
  return {
    commit: revision.commit,
    dirtyWorktree: revision.dirtyWorktree,
    sourceFingerprint: sourceFingerprint(ROOT),
    testsFingerprint: digestOf(ROOT, DIGEST_INPUTS.tests),
    lockfileSha256: optionalDigestOf(ROOT, DIGEST_INPUTS.lockfile),
    manifestSha256: sha256Of(JSON.stringify(SYSTEM_CASES)),
    schemasSha256: optionalDigestOf(ROOT, DIGEST_INPUTS.schemas),
    promptsSha256: optionalDigestOf(ROOT, DIGEST_INPUTS.prompts),
    configSha256: digestOf(ROOT, DIGEST_INPUTS.config),
    fixtures: fixtureNames.map((name) => ({
      name: `fixtures/${name}`,
      sha256: digestOf(ROOT, [`fixtures/${name}`]),
    })),
  };
}

function loadReport(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (argv.includes('--list')) {
  for (const stage of STAGES)
    console.log(
      `${stage.id.padEnd(22)} ${stage.evidenceClass.padEnd(18)} ${String(stage.timeoutMs / MINUTE)} min`,
    );
  process.exit(0);
}

if (argv.includes('--check')) {
  const given = argv[argv.indexOf('--check') + 1];
  const path = given !== undefined && !given.startsWith('--') ? join(ROOT, given) : outPath;
  if (!existsSync(path)) {
    console.error(`REPORT_MISSING ${relative(ROOT, path)}`);
    process.exit(4);
  }
  const text = readFileSync(path, 'utf8');
  const problems = [
    ...validateReport(loadReport(path), { manifestIds, requiredStageIds, root: ROOT }),
    ...sanitisationProblems(text),
  ];
  const parsed = reportSchema.safeParse(JSON.parse(text));
  if (parsed.success) {
    const now = source();
    // A report describes the source it ran against: any other source makes it stale, never "still true".
    for (const key of [
      'commit',
      'sourceFingerprint',
      'testsFingerprint',
      'lockfileSha256',
      'manifestSha256',
      'configSha256',
    ] as const)
      if (parsed.data.source[key] !== now[key]) problems.push(`STALE_${key}`);
    if (parsed.data.source.dirtyWorktree) problems.push('REPORT_FROM_DIRTY_WORKTREE_NOTED');
  }
  const blocking = problems.filter((p) => p !== 'REPORT_FROM_DIRTY_WORKTREE_NOTED');
  for (const problem of problems) console.error(problem);
  if (blocking.length > 0) process.exit(4);
  const outcome = parsed.success ? parsed.data.outcome : 'invalid';
  console.log(`report valid for the current source; outcome: ${outcome}`);
  process.exit(outcome === 'pass' ? 0 : outcome === 'fail' ? 1 : 3);
}

// ---- running -------------------------------------------------------------------------------------------

const only = list('--only');
const skip = list('--skip') ?? [];
for (const id of [...(only ?? []), ...skip])
  if (!requiredStageIds.includes(id)) {
    console.error(`unknown stage ${id}; known: ${requiredStageIds.join(', ')}`);
    process.exit(2);
  }
const selected = (id: string): boolean =>
  (only === undefined || only.includes(id)) && !skip.includes(id);
const complete = STAGES.every((s) => selected(s.id));
const rerunEnabled = !argv.includes('--no-rerun');

const outputRoot = join(ROOT, 'tests', '.output');
const runDirectory = join(outputRoot, `validate-${String(Date.now())}`);
mkdirSync(runDirectory, { recursive: true });
const lockFile = join(outputRoot, 'validate.lock');

/** Runs share accounts, nonces and ports: two at once would collide. */
function takeLock(): void {
  if (existsSync(lockFile)) {
    const pid = Number(readFileSync(lockFile, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = Number.isInteger(pid) && pid > 0;
    } catch {
      // No such process: the lock is stale.
    }
    if (alive) {
      console.error(`ANOTHER_RUN_ACTIVE pid ${String(pid)}: wait for it or stop it`);
      process.exit(3);
    }
  }
  writeFileSync(lockFile, String(process.pid));
}
takeLock();

/** Stops every process this run started (the stage in progress and what it spawned), then lets go of the lock. */
const stopAll = async (): Promise<void> => {
  const [, ...children] = processTree(process.pid);
  await Promise.all(children.map((pid) => stopProcessTree(pid, 1_000)));
  rmSync(lockFile, { force: true });
};
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void stopAll().then(() => process.exit(130));
  });
process.on('exit', () => rmSync(lockFile, { force: true }));

const childEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  ...process.env,
  CI: process.env.CI ?? '1',
  ...extra,
});

function vitestArgs(
  kind: 'tests-unit' | 'tests-system',
  outputFile: string,
  files: readonly string[],
): string[] {
  return [
    '--filter',
    '@lexaegis/system-tests',
    'exec',
    'vitest',
    'run',
    '--config',
    kind === 'tests-unit' ? 'vitest.config.ts' : 'vitest.system.config.ts',
    '--reporter=json',
    `--outputFile=${outputFile}`,
    ...files,
  ];
}

const stageResults: StageResult[] = [];
let outcomes: TestOutcome[] = [];
const recorded: RecordedResult[] = [];

function issuesFor(
  status: 'pass' | 'fail' | 'blocked' | 'not_run',
  timedOut: boolean,
  code: Issue,
): Issue[] {
  if (status === 'pass') return [];
  return timedOut ? ['TIMED_OUT'] : [code];
}

for (const stage of STAGES) {
  const base = {
    id: stage.id,
    required: true,
    evidenceClass: stage.evidenceClass,
    timeoutMs: stage.timeoutMs,
  };
  const command =
    stage.kind === undefined ? `pnpm ${stage.args.join(' ')}` : `pnpm vitest (${stage.kind})`;
  if (!selected(stage.id)) {
    stageResults.push({
      ...base,
      command,
      status: 'not_run',
      durationMs: 0,
      exitCode: null,
      issueCodes: ['STAGE_NOT_SELECTED'],
    });
    continue;
  }
  const needed =
    stage.needs === undefined ? undefined : stageResults.find((r) => r.id === stage.needs);
  if (needed !== undefined && needed.status !== 'pass') {
    stageResults.push({
      ...base,
      command,
      status: 'blocked',
      durationMs: 0,
      exitCode: null,
      issueCodes: ['PREREQUISITE_MISSING'],
    });
    console.log(`${stage.id}: blocked (needs ${stage.needs})`);
    continue;
  }
  console.log(`${stage.id}: running`);
  const outputFile = join(runDirectory, `${stage.id}.json`);
  const args = stage.kind === undefined ? stage.args : vitestArgs(stage.kind, outputFile, []);
  const env = childEnv(
    stage.kind === 'tests-system' ? { SYSTEM_TEST_OUTPUT: join(runDirectory, 'system') } : {},
  );
  const run = await runBounded('pnpm', args, { cwd: ROOT, env, timeoutMs: stage.timeoutMs });
  writeFileSync(join(runDirectory, `${stage.id}.log`), run.output);
  let status: 'pass' | 'fail' | 'blocked' | 'not_run' =
    run.status === 0 && !run.timedOut ? 'pass' : 'fail';
  let code: Issue = 'ASSERTION_FAILED';

  if (stage.kind !== undefined) {
    const found = existsSync(outputFile) ? readVitestJson(readFileSync(outputFile, 'utf8')) : [];
    // Never infer success from an exit status with no selected tests.
    if (found.length === 0 && status === 'pass') {
      status = 'fail';
      code = 'NO_TESTS_SELECTED';
    }
    outcomes = [...outcomes, ...found];
    if (stage.kind === 'tests-system')
      recorded.push(...resultsFrom(join(runDirectory, 'system', 'results.jsonl')));
  }
  stageResults.push({
    ...base,
    command,
    status,
    durationMs: run.durationMs,
    exitCode: run.status,
    issueCodes: issuesFor(status, run.timedOut, code),
  });
  console.log(`${stage.id}: ${status}${run.timedOut ? ' (timed out, process tree stopped)' : ''}`);
}

function resultsFrom(file: string): RecordedResult[] {
  return readResults(file).map((r) => ({
    caseId: r.caseId,
    status: r.status,
    evidencePaths: r.evidencePaths,
    issueCodes: r.issueCodes,
  }));
}

// ---- cases, with a diagnostic (never pass-hiding) re-run of failed spec files ------------------------------

let cases: CaseResult[] = deriveCases(SYSTEM_CASES, outcomes, recorded, 'browser_scripted');
const rerunPassed = new Set<string>();
if (rerunEnabled && selected('system-cases')) {
  const failed = cases.filter((c) => c.status === 'fail' && c.owner.endsWith('.spec.ts'));
  for (const owner of new Set(failed.map((c) => c.owner))) {
    console.log(`diagnostic re-run of ${owner} (the failure stays recorded)`);
    const outputFile = join(runDirectory, `rerun-${owner.replaceAll('/', '_')}.json`);
    const run = await runBounded(
      'pnpm',
      vitestArgs('tests-system', outputFile, [owner.slice('tests/'.length)]),
      {
        cwd: ROOT,
        env: childEnv({ SYSTEM_TEST_OUTPUT: join(runDirectory, 'rerun') }),
        timeoutMs: 30 * MINUTE,
      },
    );
    const again = existsSync(outputFile) ? readVitestJson(readFileSync(outputFile, 'utf8')) : [];
    const rerun = deriveCases(SYSTEM_CASES, again, [], 'browser_scripted');
    for (const c of failed.filter((f) => f.owner === owner))
      if (run.status === 0 && rerun.find((r) => r.caseId === c.caseId)?.status === 'pass')
        rerunPassed.add(c.caseId);
  }
  cases = deriveCases(SYSTEM_CASES, outcomes, recorded, 'browser_scripted', rerunPassed);
}
// A case whose runner stage did not run is not run, whatever an old results file says.
const caseStageRan = (c: CaseResult): boolean =>
  stageResults.find(
    (s) => s.id === (c.owner.endsWith('harness.test.ts') ? 'system-harness' : 'system-cases'),
  )?.status !== 'not_run';
cases = cases.map((c) =>
  caseStageRan(c) || c.status === 'not_run'
    ? c.status === 'not_run' && !caseStageRan(c)
      ? { ...c, issueCodes: ['STAGE_NOT_SELECTED' as const] }
      : c
    : {
        ...c,
        status: 'not_run' as const,
        satisfied: false,
        issueCodes: ['STAGE_NOT_SELECTED' as const],
      },
);

const negativeControls = cases
  .filter((c) => c.caseId.startsWith('negctl-'))
  .map((c) => ({ caseId: c.caseId, detected: c.status === 'pass' }));
const verdict = computeOutcome(stageResults, cases, complete);

const report: ValidationReport = {
  schema: REPORT_SCHEMA,
  scope: 'local_software_gate',
  limits:
    'Local synthetic software gate. Not live-capability evidence, not a security audit, not deployment readiness and not permission to publish or deploy.',
  generatedAt: new Date().toISOString(),
  durationMs: stageResults.reduce((sum, s) => sum + s.durationMs, 0),
  complete,
  source: source(),
  environment: { node: process.version, os: `${process.platform}-${process.arch}` },
  stages: stageResults,
  cases,
  negativeControls,
  outcome: verdict.outcome,
  blockers: verdict.blockers,
};

// Sanitise BEFORE anything is written for upload or commit.
const text = `${JSON.stringify(report, null, 2)}\n`;
const problems = [
  ...validateReport(JSON.parse(text), { manifestIds, requiredStageIds, root: ROOT }),
  ...sanitisationProblems(text),
];
mkdirSync(join(outPath, '..'), { recursive: true });
const secretCheck = join(runDirectory, 'report.json');
writeFileSync(secretCheck, text);
if (scanSecretFiles(runDirectory, ['report.json']).length > 0)
  problems.push('CREDENTIAL_SHAPE_IN_REPORT');
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error('report not written: it is invalid or not sanitised');
  process.exit(4);
}
await writeAtomic(outPath, text);

console.log(
  `\nreport: ${relative(ROOT, outPath)}  outcome: ${report.outcome}  complete: ${String(complete)}`,
);
for (const stage of stageResults)
  console.log(
    `  ${stage.status.padEnd(8)} ${stage.id}${stage.issueCodes.length > 0 ? `  ${stage.issueCodes.join(',')}` : ''}`,
  );
const notPass = cases.filter((c) => c.requiredForMvp && c.status !== 'pass');
for (const item of notPass)
  console.log(`  ${item.status.padEnd(8)} case ${item.caseId}  ${item.issueCodes.join(',')}`);
console.log(
  `  cases passing: ${String(cases.filter((c) => c.satisfied).length)}/${String(cases.length)}`,
);
process.exit(report.outcome === 'pass' ? 0 : report.outcome === 'fail' ? 1 : 3);
