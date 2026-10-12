import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeOutcome,
  deriveCases,
  readVitestJson,
  sanitisationProblems,
  validateReport,
  type CaseResult,
  type ManifestCase,
  type StageResult,
  type TestOutcome,
  type ValidationReport,
} from './validation';

const manifest: ManifestCase[] = [
  {
    id: 'alpha-case',
    owner: 'tests/system/a.spec.ts',
    requiredForMvp: true,
    requiredEvidence: 'local_integration',
  },
  {
    id: 'beta-case',
    owner: 'tests/system/b.spec.ts',
    requiredForMvp: true,
    requiredEvidence: 'browser_scripted',
  },
  {
    id: 'negctl-control',
    owner: 'tests/system/n.spec.ts',
    requiredForMvp: true,
    requiredEvidence: 'unit',
  },
];
const t = (id: string, status: TestOutcome['status']): TestOutcome => ({
  fullName: `[${id}] something ${status}`,
  status,
  durationMs: 5,
});

describe('reading a test run', () => {
  it('reads assertion results and ignores unknown or malformed shapes', () => {
    const json = JSON.stringify({
      testResults: [
        {
          assertionResults: [
            { fullName: '[alpha-case] x', status: 'passed', duration: 4.6 },
            { fullName: 1, status: 'passed' },
            { fullName: 'y', status: 'weird' },
          ],
        },
      ],
    });
    expect(readVitestJson(json)).toEqual([
      { fullName: '[alpha-case] x', status: 'passed', durationMs: 5 },
    ]);
    expect(readVitestJson('not json')).toEqual([]);
    expect(readVitestJson('{}')).toEqual([]);
  });
});

describe('deriving case results', () => {
  const derive = (
    outcomes: TestOutcome[],
    recorded = [] as Parameters<typeof deriveCases>[2],
    rerun = new Set<string>(),
  ) => deriveCases(manifest, outcomes, recorded, 'browser_scripted', rerun);
  const of = (cases: CaseResult[], id: string) => cases.find((c) => c.caseId === id);

  it('passes only with at least one test and every test passed', () => {
    const cases = derive([t('alpha-case', 'passed'), t('alpha-case', 'passed')]);
    expect(of(cases, 'alpha-case')).toMatchObject({
      status: 'pass',
      satisfied: true,
      issueCodes: [],
    });
  });
  it('a case with no selected test is not run, never a pass', () => {
    expect(of(derive([]), 'alpha-case')).toMatchObject({
      status: 'not_run',
      satisfied: false,
      issueCodes: ['NO_TESTS_SELECTED'],
    });
  });
  it('a skipped test is not a pass, and a recorded blocked result names the prerequisite', () => {
    expect(
      of(derive([t('alpha-case', 'passed'), t('alpha-case', 'skipped')]), 'alpha-case'),
    ).toMatchObject({ status: 'not_run', satisfied: false });
    const blocked = derive(
      [t('alpha-case', 'skipped')],
      [
        {
          caseId: 'alpha-case',
          status: 'blocked',
          evidencePaths: [],
          issueCodes: ['SERVICE_UNAVAILABLE'],
        },
      ],
    );
    expect(of(blocked, 'alpha-case')).toMatchObject({ status: 'blocked', satisfied: false });
    expect(of(blocked, 'alpha-case')?.issueCodes).toEqual(
      expect.arrayContaining(['SERVICE_UNAVAILABLE', 'SKIPPED']),
    );
  });
  it('a failure stays a failure; a diagnostic re-run that passes only adds FLAKY_RESULT', () => {
    const failed = derive(
      [t('alpha-case', 'failed'), t('alpha-case', 'passed')],
      [],
      new Set(['alpha-case']),
    );
    expect(of(failed, 'alpha-case')).toMatchObject({ status: 'fail', satisfied: false });
    expect(of(failed, 'alpha-case')?.issueCodes).toEqual(
      expect.arrayContaining(['ASSERTION_FAILED', 'FLAKY_RESULT']),
    );
  });
  it('a failed negative control is reported as undetected', () => {
    expect(of(derive([t('negctl-control', 'failed')]), 'negctl-control')?.issueCodes).toContain(
      'NEGATIVE_CONTROL_UNDETECTED',
    );
  });
  it('a runner weaker than the required evidence never satisfies the case', () => {
    const weak = deriveCases(manifest, [t('beta-case', 'passed')], [], 'unit');
    expect(of(weak, 'beta-case')).toMatchObject({ status: 'not_run', satisfied: false });
  });
});

const stage = (id: string, status: StageResult['status']): StageResult => ({
  id,
  command: `pnpm ${id}`,
  required: true,
  status,
  evidenceClass: 'unit',
  timeoutMs: 1000,
  durationMs: 1,
  exitCode: status === 'pass' ? 0 : 1,
  issueCodes: status === 'pass' ? [] : ['ASSERTION_FAILED'],
});

describe('the outcome', () => {
  const passing = deriveCases(
    manifest,
    manifest.map((m) => t(m.id, 'passed')),
    [],
    'browser_scripted',
  );
  it('passes only when everything required passed and the run was complete', () => {
    expect(computeOutcome([stage('lint', 'pass')], passing, true)).toEqual({
      outcome: 'pass',
      blockers: [],
    });
    expect(computeOutcome([stage('lint', 'pass')], passing, false).outcome).toBe('incomplete');
  });
  it('fail beats blocked beats incomplete, and blockers name the ids', () => {
    expect(computeOutcome([stage('lint', 'fail')], passing, true)).toEqual({
      outcome: 'fail',
      blockers: ['stage:lint'],
    });
    const blocked = [
      stage('lint', 'pass'),
      { ...stage('contracts', 'blocked'), issueCodes: ['PREREQUISITE_MISSING' as const] },
    ];
    expect(computeOutcome(blocked, passing, true).outcome).toBe('blocked');
    expect(
      computeOutcome(
        [{ ...stage('lint', 'not_run'), issueCodes: ['STAGE_NOT_SELECTED'] }],
        passing,
        false,
      ).outcome,
    ).toBe('incomplete');
  });
  it('an unsatisfied (flaky) case blocks even when its status is not fail', () => {
    const cases = passing.map((c) =>
      c.caseId === 'alpha-case'
        ? { ...c, satisfied: false, issueCodes: ['FLAKY_RESULT' as const] }
        : c,
    );
    expect(computeOutcome([stage('lint', 'pass')], cases, true).blockers).toEqual([
      'case:alpha-case',
    ]);
  });
});

describe('validating a report', () => {
  const root = mkdtempSync(join(tmpdir(), 'validation-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'evidence.json'), '{}');
  const cases = deriveCases(
    manifest,
    manifest.map((m) => t(m.id, 'passed')),
    [],
    'browser_scripted',
  );
  const stages = [stage('lint', 'pass')];
  const sha = 'a'.repeat(64);
  const good: ValidationReport = {
    schema: 'lexaegis.validation-report.v1',
    scope: 'local_software_gate',
    limits:
      'Local synthetic software gate. Not live-capability evidence, not a security audit, not deployment readiness and not permission to publish or deploy.',
    generatedAt: '2026-10-12T10:00:00.000Z',
    durationMs: 1,
    complete: true,
    source: {
      commit: null,
      dirtyWorktree: true,
      sourceFingerprint: sha,
      testsFingerprint: sha,
      lockfileSha256: sha,
      manifestSha256: sha,
      schemasSha256: null,
      promptsSha256: null,
      configSha256: sha,
      fixtures: [],
    },
    environment: { node: 'v24', os: 'linux-x64' },
    stages,
    cases,
    negativeControls: [{ caseId: 'negctl-control', detected: true }],
    outcome: 'pass',
    blockers: [],
  };
  const context = { manifestIds: manifest.map((m) => m.id), requiredStageIds: ['lint'], root };
  it('accepts a consistent report', () => {
    expect(validateReport(good, context)).toEqual([]);
  });
  it('rejects an outcome that the content does not support, a missing case and an unknown field', () => {
    const failing = { ...good, stages: [stage('lint', 'fail')] };
    expect(validateReport(failing, context).join()).toMatch(/OUTCOME_MISMATCH/);
    expect(validateReport({ ...good, cases: cases.slice(1) }, context).join()).toMatch(
      /MISSING_CASE alpha-case/,
    );
    expect(validateReport({ ...good, extra: 1 }, context).join()).toMatch(/SCHEMA/);
    expect(validateReport({ ...good, complete: false }, context).join()).toMatch(
      /OUTCOME_MISMATCH|PASS_WHEN_PARTIAL/,
    );
  });
  it('rejects a pass without tests, a non-pass without an issue and a missing evidence path', () => {
    const noTests = cases.map((c) =>
      c.caseId === 'alpha-case' ? { ...c, tests: { passed: 0, failed: 0, skipped: 0 } } : c,
    );
    expect(validateReport({ ...good, cases: noTests }, context).join()).toMatch(
      /PASS_WITHOUT_TESTS/,
    );
    const silent = [{ ...stage('lint', 'fail'), issueCodes: [] }];
    expect(
      validateReport(
        { ...good, stages: silent, outcome: 'fail', blockers: ['stage:lint'] },
        context,
      ).join(),
    ).toMatch(/NON_PASS_WITHOUT_ISSUE/);
    const missing = cases.map((c) =>
      c.caseId === 'alpha-case' ? { ...c, evidencePaths: ['docs/nope.json'] } : c,
    );
    expect(validateReport({ ...good, cases: missing }, context).join()).toMatch(
      /EVIDENCE_PATH_MISSING/,
    );
  });
  it('flags text that must not be uploaded', () => {
    expect(sanitisationProblems('{"a":"/home/someone/x"}')).toContain('ABSOLUTE_HOME_PATH');
    expect(sanitisationProblems(`{"k":"0x${'ab'.repeat(32)}"}`)).toContain(
      'PRIVATE_KEY_SHAPED_VALUE',
    );
    expect(sanitisationProblems('{"a":"https://user:pass@host.example/"}')).toContain(
      'REDACTION_WOULD_CHANGE_REPORT',
    );
    expect(sanitisationProblems('{"a":"clean"}')).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
