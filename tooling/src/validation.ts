import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { redact } from './redact';

/*
 * The versioned validation report of `pnpm validate:mvp` and the rules that derive it. Everything in a
 * report comes from real runner outcomes (exit statuses and the JSON a test run wrote) and the case
 * manifest. A missing result, a required skip, a blocked prerequisite or a run that selected no tests
 * is never a pass, and an existing report file is never evidence by itself: `validateReport` re-derives
 * the outcome and the completeness from the content.
 *
 * SCOPE. This is a LOCAL SOFTWARE GATE over synthetic data. It is not live-capability evidence, not a
 * security audit and not deployment readiness (Chapter 13 owns hosting checks).
 */

export const REPORT_SCHEMA = 'lexaegis.validation-report.v1';

export const STATUSES = ['pass', 'fail', 'blocked', 'not_run'] as const;
export type Status = (typeof STATUSES)[number];

export const EVIDENCE = [
  'unit',
  'local_integration',
  'browser_scripted',
  'live_read',
  'live_human',
] as const;
export type Evidence = (typeof EVIDENCE)[number];
const RANK: Readonly<Record<Evidence, number>> = {
  unit: 0,
  local_integration: 1,
  browser_scripted: 2,
  live_read: 3,
  live_human: 4,
};

export const ISSUES = [
  'SERVICE_UNAVAILABLE',
  'PREREQUISITE_MISSING',
  'REAL_DEVICE_REQUIRED',
  'USER_ACTION_REQUIRED',
  'LIVE_OPT_IN_REQUIRED',
  'SKIPPED',
  'FLAKY_RESULT',
  'ASSERTION_FAILED',
  'NEGATIVE_CONTROL_UNDETECTED',
  'TIMED_OUT',
  'NO_TESTS_SELECTED',
  'STAGE_NOT_SELECTED',
] as const;
export type Issue = (typeof ISSUES)[number];

const safePath = z
  .string()
  .regex(/^[A-Za-z0-9_./-]+$/)
  .max(200);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const stageSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .max(40),
  command: z.string().max(200),
  required: z.boolean(),
  status: z.enum(STATUSES),
  evidenceClass: z.enum(EVIDENCE),
  timeoutMs: z.number().int().min(1),
  durationMs: z.number().int().min(0),
  exitCode: z.number().int().nullable(),
  issueCodes: z.array(z.enum(ISSUES)).max(10),
});
export type StageResult = z.infer<typeof stageSchema>;

export const caseSchema = z.strictObject({
  caseId: z
    .string()
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
    .max(80),
  owner: safePath,
  requiredForMvp: z.boolean(),
  requiredEvidence: z.enum(EVIDENCE),
  evidenceClass: z.enum(EVIDENCE),
  status: z.enum(STATUSES),
  satisfied: z.boolean(),
  durationMs: z.number().int().min(0),
  tests: z.strictObject({
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    skipped: z.number().int().min(0),
  }),
  evidencePaths: z.array(safePath).max(20),
  issueCodes: z.array(z.enum(ISSUES)).max(10),
});
export type CaseResult = z.infer<typeof caseSchema>;

export const OUTCOMES = ['pass', 'fail', 'blocked', 'incomplete'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const reportSchema = z.strictObject({
  schema: z.literal(REPORT_SCHEMA),
  scope: z.literal('local_software_gate'),
  limits: z.literal(
    'Local synthetic software gate. Not live-capability evidence, not a security audit, not deployment readiness and not permission to publish or deploy.',
  ),
  generatedAt: z.iso.datetime(),
  durationMs: z.number().int().min(0),
  /** True only when every stage and the whole manifest were selected. A partial run cannot pass. */
  complete: z.boolean(),
  source: z.strictObject({
    commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
    dirtyWorktree: z.boolean(),
    sourceFingerprint: sha256,
    testsFingerprint: sha256,
    lockfileSha256: sha256.nullable(),
    manifestSha256: sha256,
    schemasSha256: sha256.nullable(),
    promptsSha256: sha256.nullable(),
    configSha256: sha256,
    fixtures: z.array(z.strictObject({ name: safePath, sha256 })).max(20),
  }),
  environment: z.strictObject({ node: z.string().max(40), os: z.string().max(40) }),
  stages: z.array(stageSchema).max(40),
  cases: z.array(caseSchema).max(200),
  negativeControls: z.array(
    z.strictObject({
      caseId: z.string().max(80),
      detected: z.boolean(),
    }),
  ),
  outcome: z.enum(OUTCOMES),
  /** Ids of required stages and cases that do not pass. */
  blockers: z.array(z.string().max(100)).max(300),
});
export type ValidationReport = z.infer<typeof reportSchema>;

// ---- Deriving case results from real test-run output ------------------------------------------------

export interface ManifestCase {
  readonly id: string;
  readonly owner: string;
  readonly requiredForMvp: boolean;
  readonly requiredEvidence: Evidence;
}

export interface RecordedResult {
  readonly caseId: string;
  readonly status: Status;
  readonly evidencePaths: readonly string[];
  readonly issueCodes: readonly Issue[];
}

export interface TestOutcome {
  readonly fullName: string;
  readonly status: 'passed' | 'failed' | 'skipped' | 'pending' | 'todo' | 'disabled';
  readonly durationMs: number;
}

/** Flattens the JSON a vitest run writes (`--reporter=json`). Unknown shapes yield nothing, never a pass. */
export function readVitestJson(text: string): TestOutcome[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const files = (parsed as { testResults?: unknown }).testResults;
  if (!Array.isArray(files)) return [];
  const out: TestOutcome[] = [];
  for (const file of files as { assertionResults?: unknown }[]) {
    if (!Array.isArray(file.assertionResults)) continue;
    for (const item of file.assertionResults as Record<string, unknown>[]) {
      const status = item.status;
      if (
        typeof item.fullName !== 'string' ||
        (status !== 'passed' &&
          status !== 'failed' &&
          status !== 'skipped' &&
          status !== 'pending' &&
          status !== 'todo' &&
          status !== 'disabled')
      )
        continue;
      out.push({
        fullName: item.fullName,
        status,
        durationMs: typeof item.duration === 'number' ? Math.round(item.duration) : 0,
      });
    }
  }
  return out;
}

const CASE_TAG = /\[([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\]/;

/**
 * One result per manifest case. A case passes only when it has at least one test, every test passed,
 * and the evidence class of its runner is at least what the case requires. A recorded `blocked` result
 * (the suite could not start) explains skipped tests; it never turns a skip into a pass.
 */
export function deriveCases(
  manifest: readonly ManifestCase[],
  outcomes: readonly TestOutcome[],
  recorded: readonly RecordedResult[],
  runnerEvidence: Evidence,
  diagnosticRerunPassed: ReadonlySet<string> = new Set(),
): CaseResult[] {
  const byCase = new Map<string, TestOutcome[]>();
  for (const outcome of outcomes) {
    const id = CASE_TAG.exec(outcome.fullName)?.[1];
    if (id === undefined) continue;
    byCase.set(id, [...(byCase.get(id) ?? []), outcome]);
  }
  const latest = new Map<string, RecordedResult>();
  for (const item of recorded) latest.set(item.caseId, item);
  return manifest.map((item) => {
    const tests = byCase.get(item.id) ?? [];
    const passed = tests.filter((t) => t.status === 'passed').length;
    const failed = tests.filter((t) => t.status === 'failed').length;
    const skipped = tests.length - passed - failed;
    const note = latest.get(item.id);
    const issues = new Set<Issue>();
    let status: Status;
    if (failed > 0) {
      status = 'fail';
      issues.add('ASSERTION_FAILED');
    } else if (tests.length === 0) {
      status = 'not_run';
      issues.add('NO_TESTS_SELECTED');
    } else if (skipped > 0) {
      if (note?.status === 'blocked') {
        status = 'blocked';
        for (const code of note.issueCodes) issues.add(code);
      } else {
        status = 'not_run';
      }
      issues.add('SKIPPED');
    } else {
      status = 'pass';
    }
    if (status === 'fail' && diagnosticRerunPassed.has(item.id)) issues.add('FLAKY_RESULT');
    // A runner that cannot produce the required evidence class never satisfies the case.
    const enough = RANK[runnerEvidence] >= RANK[item.requiredEvidence];
    if (status === 'pass' && !enough) {
      status = 'not_run';
      issues.add(
        item.requiredEvidence === 'live_human' ? 'REAL_DEVICE_REQUIRED' : 'LIVE_OPT_IN_REQUIRED',
      );
    }
    if (item.id.startsWith('negctl-') && status === 'fail')
      issues.add('NEGATIVE_CONTROL_UNDETECTED');
    return {
      caseId: item.id,
      owner: item.owner,
      requiredForMvp: item.requiredForMvp,
      requiredEvidence: item.requiredEvidence,
      evidenceClass: runnerEvidence,
      status,
      satisfied: status === 'pass' && !issues.has('FLAKY_RESULT'),
      durationMs: tests.reduce((sum, t) => sum + t.durationMs, 0),
      tests: { passed, failed, skipped },
      evidencePaths: [...(note?.evidencePaths ?? [])],
      issueCodes: [...issues],
    };
  });
}

// ---- Outcome and validation -------------------------------------------------------------------------

export function computeOutcome(
  stages: readonly StageResult[],
  cases: readonly CaseResult[],
  complete: boolean,
): { outcome: Outcome; blockers: string[] } {
  const required = [
    ...stages.filter((s) => s.required).map((s) => ({ id: `stage:${s.id}`, status: s.status })),
    ...cases
      .filter((c) => c.requiredForMvp)
      .map((c) => ({ id: `case:${c.caseId}`, status: c.status })),
  ];
  const unsatisfied = new Set(cases.filter((c) => !c.satisfied).map((c) => `case:${c.caseId}`));
  const blockers = required
    .filter((item) => item.status !== 'pass' || unsatisfied.has(item.id))
    .map((item) => item.id);
  const statusOf = (id: string): Status | undefined => required.find((r) => r.id === id)?.status;
  let outcome: Outcome;
  if (blockers.some((id) => statusOf(id) === 'fail')) outcome = 'fail';
  else if (blockers.some((id) => statusOf(id) === 'blocked')) outcome = 'blocked';
  else if (blockers.length > 0 || !complete) outcome = 'incomplete';
  else outcome = 'pass';
  return { outcome, blockers };
}

export interface ReportContext {
  readonly manifestIds: readonly string[];
  readonly requiredStageIds: readonly string[];
  /** Repository root, to check that every evidence path exists. */
  readonly root: string;
}

/** Schema, completeness, consistency and path checks. Returns the problems; [] means valid. */
export function validateReport(input: unknown, context: ReportContext): string[] {
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success)
    return parsed.error.issues.map((i) => `SCHEMA ${i.path.join('.')}: ${i.message}`);
  const report = parsed.data;
  const problems: string[] = [];
  const stageIds = report.stages.map((s) => s.id);
  if (new Set(stageIds).size !== stageIds.length) problems.push('DUPLICATE_STAGE');
  for (const id of context.requiredStageIds)
    if (!stageIds.includes(id)) problems.push(`MISSING_STAGE ${id}`);
  const caseIds = report.cases.map((c) => c.caseId);
  if (new Set(caseIds).size !== caseIds.length) problems.push('DUPLICATE_CASE');
  for (const id of context.manifestIds)
    if (!caseIds.includes(id)) problems.push(`MISSING_CASE ${id}`);
  for (const id of caseIds)
    if (!context.manifestIds.includes(id)) problems.push(`UNKNOWN_CASE ${id}`);
  for (const item of [...report.stages, ...report.cases]) {
    const id = 'caseId' in item ? item.caseId : item.id;
    if (item.status !== 'pass' && item.issueCodes.length === 0)
      problems.push(`NON_PASS_WITHOUT_ISSUE ${id}`);
    if (item.status === 'pass' && item.issueCodes.some((c) => c !== 'FLAKY_RESULT'))
      problems.push(`PASS_WITH_BLOCKING_ISSUE ${id}`);
  }
  for (const item of report.cases) {
    if (item.status === 'pass' && item.tests.passed === 0)
      problems.push(`PASS_WITHOUT_TESTS ${item.caseId}`);
    if (item.satisfied && (item.status !== 'pass' || item.issueCodes.includes('FLAKY_RESULT')))
      problems.push(`SATISFIED_WITHOUT_PASS ${item.caseId}`);
    if (RANK[item.evidenceClass] < RANK[item.requiredEvidence] && item.satisfied)
      problems.push(`WEAK_EVIDENCE_SATISFIED ${item.caseId}`);
    for (const path of item.evidencePaths)
      if (!existsSync(join(context.root, path))) problems.push(`EVIDENCE_PATH_MISSING ${path}`);
  }
  const derived = computeOutcome(report.stages, report.cases, report.complete);
  if (derived.outcome !== report.outcome)
    problems.push(`OUTCOME_MISMATCH ${report.outcome} != ${derived.outcome}`);
  if (derived.blockers.join('|') !== report.blockers.join('|')) problems.push('BLOCKERS_MISMATCH');
  if (report.outcome === 'pass' && !report.complete) problems.push('PASS_WHEN_PARTIAL');
  return problems;
}

/** Text of the report that must not be uploaded or committed: credentials, URLs with secrets, home paths. */
export function sanitisationProblems(text: string): string[] {
  const problems: string[] = [];
  if (redact(text) !== text) problems.push('REDACTION_WOULD_CHANGE_REPORT');
  if (/\/home\/|\/Users\/|[A-Za-z]:\\\\Users/.test(text)) problems.push('ABSOLUTE_HOME_PATH');
  if (/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/.test(text)) problems.push('PRIVATE_KEY_SHAPED_VALUE');
  return problems;
}

// ---- Allowlisted digests ----------------------------------------------------------------------------

export const sha256Of = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

function* filesUnder(directory: string): Generator<string> {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (entry.name === 'node_modules' || entry.name === '.output') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}

/** Digest over named files and directories (relative, sorted). Missing entries are skipped. */
export function digestOf(root: string, names: readonly string[]): string {
  const hash = createHash('sha256');
  for (const name of names) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const files = statSync(path).isDirectory() ? [...filesUnder(path)] : [path];
    for (const file of files)
      hash.update(
        `${relative(root, file).split(sep).join('/')}\0${sha256Of(readFileSync(file))}\n`,
      );
  }
  return hash.digest('hex');
}

export function optionalDigestOf(root: string, names: readonly string[]): string | null {
  return names.some((name) => existsSync(join(root, name))) ? digestOf(root, names) : null;
}

/** Inputs that define "the tests and the configuration" a report describes. Allowlisted: no .env, no output. */
export const DIGEST_INPUTS = {
  tests: [
    'tests/system',
    'tests/privacy',
    'tests/vitest.config.ts',
    'tests/vitest.system.config.ts',
    'tests/package.json',
  ],
  lockfile: ['pnpm-lock.yaml'],
  schemas: ['packages/protocol/schemas'],
  prompts: ['packages/agent/prompts'],
  config: [
    'package.json',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'vitest.config.mts',
    'eslint.config.mjs',
    '.github/workflows/ci.yml',
  ],
} as const;
