/**
 * pnpm readiness [--live] [--require A|B|C|D]
 * Offline by default: no network call, install or download. Writes docs/readiness-report.md and
 * build-state with one run ID. Exit nonzero for invalid state, failed checks, or any required or
 * due gate that is not pass.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readState, recordEvidence, writeAtomic } from '../src/evidence-writer';
import { evaluateGates, gateConsequences, GATE_IDS, type GateId } from '../src/gates';
import { redact } from '../src/redact';
import {
  probeHealth,
  probeIndexer,
  probeRegistry,
  runAll,
  type CheckSpec,
  type Fetcher,
} from '../src/readiness';
import { exitCode, renderGateTable, renderReport, reportRunId } from '../src/report';
import { sourceFingerprint } from '../src/fingerprint';
import { validateBuildState, type EvidenceResult } from '../src/state';
import { ROOT, stamp, toolVersion } from './lib';

const BUDGET_MS = 110_000;
const started = Date.now();
const argv = process.argv.slice(2);
const live = argv.includes('--live');
const requireArg = argv[argv.indexOf('--require') + 1];
const required =
  argv.includes('--require') && GATE_IDS.some((g) => g === requireArg)
    ? (requireArg as GateId)
    : undefined;
if (argv.includes('--require') && required === undefined) {
  console.error('--require expects A, B, C or D');
  process.exit(2);
}

const nowIso = new Date().toISOString();
const runId = `rd-${nowIso.replace(/\D/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
const reportPath = join(ROOT, 'docs', 'readiness-report.md');

// An interrupted earlier run can leave the report and build-state disagreeing about the last run.
const previous = readState(ROOT).readiness as { runId?: string } | undefined;
const previousReport = existsSync(reportPath)
  ? reportRunId(readFileSync(reportPath, 'utf8'))
  : null;
if (previous?.runId !== undefined && previousReport !== null && previous.runId !== previousReport) {
  console.warn(
    `previous run left mismatched result IDs (state ${previous.runId}, report ${previousReport}); this run rewrites both`,
  );
}

const forgeBinary = join(ROOT, '.tools', 'foundry', 'v1.8.5', 'forge');
const pnpm = (id: string, script: string, extra: Partial<CheckSpec> = {}): CheckSpec => ({
  id,
  command: 'pnpm',
  args: ['run', '--silent', script],
  cwd: ROOT,
  ...extra,
});
const specs: CheckSpec[] = [
  pnpm('typecheck', 'typecheck'),
  pnpm('unit-tests', 'test'),
  pnpm('forge-test', 'contracts:test', {
    requires: () =>
      existsSync(forgeBinary)
        ? null
        : 'pinned Foundry 1.8.5 is not installed (pnpm contracts:toolchain)',
  }),
  pnpm('secret-scan', 'secrets:check'),
  pnpm('protected-baselines', 'baselines:check'),
  pnpm('build', 'build', { after: 'typecheck' }),
  pnpm('exclusion', 'exclusion:check', { after: 'build' }),
];

const fingerprintAtStart = sourceFingerprint(ROOT);
const checks = await runAll(specs, BUDGET_MS);

const probes = [];
if (live) {
  const fetcher: Fetcher = (url, init) => fetch(url, init);
  probes.push(
    await probeRegistry(fetcher, {
      rpcUrl: process.env.ALCHEMY_MONAD_RPC_URL,
      registryAddress: process.env.NEXT_PUBLIC_REGISTRY_ADDRESS,
      expectedChainId: '10143',
      expectedCodeLength: undefined,
    }),
    await probeHealth(fetcher, process.env.NEXT_PUBLIC_APP_ORIGIN),
    probeIndexer(),
  );
}

const changedDuringRun = sourceFingerprint(ROOT) !== fingerprintAtStart;
const outcomeOf = (id: string) => checks.find((c) => c.id === id)?.outcome ?? 'unknown';
const local = [
  'typecheck',
  'unit-tests',
  'forge-test',
  'build',
  'exclusion',
  'protected-baselines',
];
const allPass = local.every((id) => outcomeOf(id) === 'pass');
const anyFail = local.some((id) => outcomeOf(id) === 'fail');

const stampNew = (
  subject: string,
  outcome: EvidenceResult['outcome'],
  reasons: string[],
  evidenceClass: EvidenceResult['evidenceClass'] = 'local_scripted',
) =>
  stamp({
    id: `${runId}-${subject}`,
    subject,
    command: `pnpm readiness${live ? ' --live' : ''}`,
    evidenceClass,
    outcome: changedDuringRun ? 'unknown' : outcome,
    reasonCodes: changedDuringRun ? ['SOURCE_CHANGED_DURING_RUN'] : reasons,
    checkedAt: nowIso,
  });

const newResults: EvidenceResult[] = [
  ...checks.map((c) =>
    stampNew(
      `check-${c.id}`,
      c.outcome,
      c.outcome === 'pass'
        ? []
        : [c.reason.split(':')[0]?.replace(/\W+/g, '_').toUpperCase() ?? 'FAILED'],
    ),
  ),
  stampNew(
    'chapters-1-3-checks',
    allPass ? 'pass' : anyFail ? 'fail' : 'unknown',
    allPass ? [] : ['CHECKS_NOT_ALL_PASSED'],
  ),
  ...probes.map((p) =>
    stampNew(p.id, p.outcome, p.outcome === 'pass' ? [] : [p.reason], 'live_testnet'),
  ),
];
// Content fingerprint on these results is the one taken before the run.
for (const r of newResults)
  (r.sourceRevision as { contentFingerprint: string }).contentFingerprint = fingerprintAtStart;

const state = readState(ROOT);
const priorResults = (state.results as EvidenceResult[] | undefined) ?? [];
const evaluations = evaluateGates([...priorResults, ...newResults], {
  now: nowIso,
  currentFingerprint: fingerprintAtStart,
});
const consequences = gateConsequences(
  evaluations.find((e) => e.gate === 'B') ?? (evaluations[1] as never),
  nowIso,
);

const stateIssues = validateBuildState(
  { ...state, results: [...priorResults, ...newResults] },
  { pathExists: (path) => existsSync(join(ROOT, path)) },
);
const totalMs = Date.now() - started;
const versions = {
  node: process.version,
  pnpm: toolVersion('pnpm'),
  forge: existsSync(forgeBinary)
    ? toolVersion(forgeBinary).replace('forge Version: ', '')
    : 'unavailable',
};

const checkRows = checks.map((c) => ({
  id: c.id,
  outcome: c.outcome,
  reason: c.reason,
  durationMs: c.durationMs,
}));
const markdown = renderReport({
  runId,
  generatedAt: nowIso,
  fingerprint: fingerprintAtStart,
  evaluations,
  checks: [
    ...checkRows,
    ...probes.map((p) => ({ id: p.id, outcome: p.outcome, reason: p.reason, durationMs: 0 })),
  ],
  totalMs,
  versions,
});

await writeAtomic(reportPath, markdown);
await recordEvidence({
  root: ROOT,
  results: newResults,
  sections: {
    gates: { ...(state.gates as object), evaluations, consequences, evaluatedAt: nowIso },
    readiness: {
      runId,
      generatedAt: nowIso,
      live,
      fingerprint: fingerprintAtStart,
      totalMs,
      versions,
      checks: checkRows,
    },
  },
});

console.log(renderGateTable(evaluations));
console.log('');
for (const c of checks)
  console.log(
    `${c.outcome.padEnd(7)} ${c.id.padEnd(20)} ${(c.durationMs / 1000).toFixed(1).padStart(5)}s  ${c.outcome === 'pass' ? '' : redact(c.reason)}`,
  );
for (const p of probes) console.log(`${p.outcome.padEnd(7)} ${p.id.padEnd(20)}        ${p.reason}`);
console.log(
  `\nrun ${runId}  total ${(totalMs / 1000).toFixed(1)}s of ${String(BUDGET_MS / 1000)}s budget`,
);
for (const issue of stateIssues) console.error(`STATE ${issue.code} at ${issue.path}`);
if (consequences.meraBountyClaimsWithdrawn)
  console.log(`Gate B consequence: ${consequences.releaseBlockers.join(' | ')}`);

process.exit(
  exitCode({
    stateValid: stateIssues.length === 0,
    checks,
    evaluations,
    now: nowIso,
    ...(required !== undefined && { require: required }),
  }),
);
