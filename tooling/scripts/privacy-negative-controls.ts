/**
 * pnpm test:privacy:controls
 *
 * Negative controls for `pnpm test:privacy:browser`: shows that each disclosure-boundary check
 * FAILS when the fault it exists for is present, names the right boundary, and passes again when
 * the fault is removed.
 *
 * Everything happens in a DISPOSABLE git worktree of the current commit, in the user's cache directory.
 * The working tree is never edited. One fault at a time is written into the module that owns the
 * boundary (tooling/src/privacy/faults.ts), the owning check runs there, the fault is reverted with
 * git, and the check runs again. Markers are synthetic; the only "forbidden receiver" is a loopback
 * server started by this script, so nothing leaves this machine. The worktree, its build output and
 * the receiver are removed at the end.
 *
 * A fault counts as detected only when the check reports the expected rule at the expected
 * boundary for the expected canary. A crash, a compile error or a missing observation file is
 * NOT a detection.
 *
 *   --only <id,id>     run a subset (partial: never recorded)
 *   --no-record        do not write evidence
 *   --keep-worktree    leave the worktree in place (debugging only)
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { recordEvidence } from '../src/evidence-writer';
import {
  ALL_FAULT_CANARIES,
  FAULTS,
  applyFault,
  judgeFault,
  type Fault,
} from '../src/privacy/faults';
import { runBounded } from '../src/privacy/run-bounded';
import { ROOT, gitRevision, stamp } from './lib';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const only = option('--only')?.split(',');
const keepWorktree = args.includes('--keep-worktree');
const selected = FAULTS.filter((fault) => only === undefined || only.includes(fault.id));
const partial = selected.length !== FAULTS.length;
const skipRecord = args.includes('--no-record') || partial;
if (selected.length === 0) {
  console.error(`no such fault; known: ${FAULTS.map((fault) => fault.id).join(', ')}`);
  process.exit(2);
}

/** One owning-check run: the observed HUD journey and the scan of the assets it built. */
const CHECK_TIMEOUT_MS = 12 * 60_000;

interface CheckReport {
  readonly outcome: 'pass' | 'fail';
  readonly failures: string[];
}

const git = (cwd: string, gitArgs: string[]): { status: number | null; stdout: string } => {
  const result = spawnSync('git', gitArgs, { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout };
};

const revision = gitRevision();
const startedAt = new Date();
const work = mkdtempSync(join(tmpdir(), 'lexaegis-negative-controls-'));
// The copy lives on the same disk as the package store (the user's cache directory), so its
// dependencies install offline from that store. A temporary directory on another filesystem has no
// store of its own and cannot install without the network.
const cacheHome =
  process.env.LEXAEGIS_CONTROLS_DIR ?? process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
mkdirSync(join(cacheHome, 'lexaegis'), { recursive: true });
const worktreeParent = mkdtempSync(join(cacheHome, 'lexaegis', 'negative-controls-'));
const worktree = join(worktreeParent, 'source');
const canariesFile = join(work, 'canaries.json');
writeFileSync(canariesFile, JSON.stringify(ALL_FAULT_CANARIES));

// The forbidden receiver: loopback only, owned by this run, never on the application's allowlist.
const received: { marker: boolean }[] = [];
const receiver = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    received.push({ marker: Buffer.concat(chunks).toString('utf8').includes('NEGATIVE-CONTROL') });
    response.writeHead(204).end();
  });
});
await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
const receiverUrl = `http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}/collect`;

interface ControlResult {
  readonly faultId: string;
  readonly boundary: string;
  readonly mistake: string;
  readonly owningModule: string;
  readonly expectedDetector: string[];
  readonly outcome: 'detected' | 'not_detected' | 'not_run';
  readonly reason: string | null;
  readonly observedFailure: string[];
  readonly otherFailures: number;
  readonly receiverRequests: number | null;
  readonly restored: 'pass' | 'fail' | 'not_run';
  readonly restoredFailures: string[];
  readonly seconds: number;
}
const results: ControlResult[] = [];
let setupFailure: string | null = null;
let baseline: CheckReport | null = null;

async function ownedCheck(label: string): Promise<CheckReport | null> {
  const reportFile = join(work, `report-${label}.json`);
  rmSync(reportFile, { force: true });
  const run = await runBounded(
    'pnpm',
    [
      'exec',
      'tsx',
      join('tooling', 'scripts', 'privacy-browser-check.ts'),
      '--journey',
      'hud',
      '--no-record',
      '--report',
      reportFile,
      '--extra-canaries',
      canariesFile,
    ],
    { cwd: worktree, env: process.env, timeoutMs: CHECK_TIMEOUT_MS },
  );
  if (run.timedOut || !existsSync(reportFile)) return null;
  return JSON.parse(readFileSync(reportFile, 'utf8')) as CheckReport;
}

try {
  // ---- A disposable copy of the tested source state ------------------------------------------
  console.log(`worktree of ${revision.commit ?? 'unknown commit'} in ${worktreeParent}`);
  if (git(ROOT, ['worktree', 'add', '--detach', worktree, 'HEAD']).status !== 0) {
    setupFailure = 'WORKTREE_NOT_CREATED';
  } else {
    const install = spawnSync('pnpm', ['install', '--frozen-lockfile', '--offline'], {
      cwd: worktree,
      encoding: 'utf8',
      timeout: 15 * 60_000,
    });
    if (install.status !== 0) {
      setupFailure = 'DEPENDENCIES_NOT_INSTALLED_OFFLINE';
      console.log(`${install.stdout}${install.stderr}`.trim().split('\n').slice(-3).join('\n'));
    }
    // Local-only tools and generated assets that are not tracked: the pinned S3-compatible server
    // and the pdf.js files the application copies before a build.
    const tools = join(ROOT, '.tools', 'versitygw');
    if (existsSync(tools)) {
      cpSync(tools, join(worktree, '.tools', 'versitygw'), { recursive: true });
    } else {
      setupFailure ??= 'S3_TOOL_MISSING (run pnpm tools:s3)';
    }
    if (
      setupFailure === null &&
      spawnSync('node', [join('scripts', 'copy-pdfjs-assets.mjs')], {
        cwd: join(worktree, 'apps', 'web'),
      }).status !== 0
    ) {
      setupFailure = 'PDFJS_ASSETS_NOT_COPIED';
    }
  }

  if (setupFailure === null) {
    console.log('\n=== baseline: the unchanged copy, with every fault canary registered ===');
    baseline = await ownedCheck('baseline');
    console.log(
      baseline === null
        ? 'baseline: NO REPORT'
        : `baseline: ${baseline.outcome.toUpperCase()} (${String(baseline.failures.length)} failure(s))`,
    );
    if (baseline?.outcome !== 'pass') {
      setupFailure = 'BASELINE_NOT_CLEAN';
      // Failure lines name rules, scopes, IDs and classes: never a value.
      for (const failure of baseline?.failures ?? []) console.log(`  baseline: ${failure}`);
    }
  }

  for (const fault of setupFailure === null ? selected : []) {
    const began = Date.now();
    console.log(`\n=== ${fault.id}: ${fault.boundary} ===`);
    const path = join(worktree, fault.file);
    const result = await control(fault, path);
    results.push({ ...result, seconds: Math.round((Date.now() - began) / 1000) });
    console.log(
      `${fault.id}: ${result.outcome.toUpperCase()}${result.reason === null ? '' : ` (${result.reason})`}; restored: ${result.restored.toUpperCase()}`,
    );
    for (const line of result.observedFailure) console.log(`  detected by: ${line}`);
    for (const line of result.restoredFailures) console.log(`  after restore: ${line}`);
    if (result.restored !== 'pass') {
      // A copy that is not clean again cannot serve as the starting point of the next control.
      setupFailure = `RESTORE_FAILED after ${fault.id}`;
      break;
    }
  }
} finally {
  receiver.close();
  if (keepWorktree) {
    console.error(`kept ${worktree}`);
  } else {
    git(ROOT, ['worktree', 'remove', '--force', worktree]);
    git(ROOT, ['worktree', 'prune']);
    rmSync(worktreeParent, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

async function control(fault: Fault, path: string): Promise<Omit<ControlResult, 'seconds'>> {
  const base = {
    faultId: fault.id,
    boundary: fault.boundary,
    mistake: fault.mistake,
    owningModule: fault.file,
    expectedDetector: fault.expect.map((pattern) => pattern.source),
  };
  const notRun = (reason: string): Omit<ControlResult, 'seconds'> => ({
    ...base,
    outcome: 'not_run',
    reason,
    observedFailure: [],
    otherFailures: 0,
    receiverRequests: null,
    restored: 'pass',
    restoredFailures: [],
  });
  if (!existsSync(path)) return notRun('OWNING_MODULE_MISSING');
  const applied = applyFault(fault, readFileSync(path, 'utf8'), { receiverUrl });
  if (!applied.ok) return notRun(applied.reason);

  received.length = 0;
  writeFileSync(path, applied.text);
  const faulty = await ownedCheck(`${fault.id}-fault`);
  const receiverRequests = received.length;

  // Remove the fault with git and prove the copy is the tested source again.
  git(worktree, ['checkout', '--', fault.file]);
  const clean =
    git(worktree, ['status', '--porcelain', '--untracked-files=no']).stdout.trim() === '';
  const restoredReport = clean ? await ownedCheck(`${fault.id}-restored`) : null;
  const restored = restoredReport?.outcome === 'pass' ? 'pass' : 'fail';
  const restoredFailures = clean
    ? (restoredReport?.failures ?? ['NO_REPORT'])
    : ['FAULT_NOT_REVERTED'];

  if (faulty === null) {
    return {
      ...base,
      outcome: 'not_detected',
      reason: 'NO_REPORT: the check did not finish, which is not a detection',
      observedFailure: [],
      otherFailures: 0,
      receiverRequests,
      restored,
      restoredFailures,
    };
  }
  const verdict = judgeFault(fault, faulty.failures);
  const receiverOk =
    fault.receiver === undefined ||
    (fault.receiver === 'none' ? receiverRequests === 0 : receiverRequests > 0);
  const reason = !verdict.detected
    ? verdict.missing.length > 0
      ? `EXPECTED_FAILURE_MISSING ${verdict.missing.join(' | ')}`
      : `UNEXPECTED_FAILURE ${verdict.forbidden.join(' | ')}`
    : !receiverOk
      ? `RECEIVER_SAW_${String(receiverRequests)}_REQUESTS (expected ${fault.receiver ?? ''})`
      : faulty.outcome !== 'fail'
        ? 'CHECK_DID_NOT_FAIL'
        : null;
  return {
    ...base,
    outcome: reason === null ? 'detected' : 'not_detected',
    reason,
    observedFailure: verdict.matched,
    otherFailures: faulty.failures.length - verdict.matched.length,
    receiverRequests: fault.receiver === undefined ? null : receiverRequests,
    restored,
    restoredFailures,
  };
}

const finishedAt = new Date();
const detected = results.filter(
  (result) => result.outcome === 'detected' && result.restored === 'pass',
);
const outcome =
  setupFailure === null && detected.length === selected.length && results.length === selected.length
    ? 'pass'
    : 'fail';
const report = {
  schema: 'lexaegis.evidence.privacy-negative-controls.v1',
  note: 'Synthetic faults in a disposable git worktree of the commit below; local services and a loopback receiver only. Shows that each named check detects its fault. It does not show that the checks detect every leak.',
  command: 'pnpm test:privacy:controls',
  checkedAt: finishedAt.toISOString(),
  durationSeconds: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
  commit: revision.commit,
  workingTreeDirtyAtStart: revision.dirtyWorktree,
  testedCopy: 'git worktree of HEAD (uncommitted changes in the working tree are not in it)',
  owningCheck:
    'pnpm test:privacy:browser --journey hud (observed HUD journey and its built assets)',
  scope: partial ? `partial: ${selected.map((fault) => fault.id).join(', ')}` : 'every fault',
  outcome,
  setupFailure,
  baseline:
    baseline === null
      ? 'NOT YET: no report'
      : { outcome: baseline.outcome, failures: baseline.failures },
  faults: selected.length,
  detectedAndRestored: detected.length,
  results,
};
const path = join(
  ROOT,
  'docs',
  'evidence',
  `chapter17-privacy-negative-controls-${finishedAt.toISOString().slice(0, 10)}.json`,
);
if (!skipRecord) {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  await recordEvidence({
    root: ROOT,
    results: [
      stamp({
        id: `privacy-negative-controls-${finishedAt.toISOString().replace(/\D/g, '').slice(0, 14)}`,
        subject: 'privacy-negative-controls',
        command: 'pnpm test:privacy:controls',
        evidenceClass: 'virtual_authenticator',
        outcome,
        reasonCodes: [
          'SYNTHETIC_FAULTS_IN_A_DISPOSABLE_WORKTREE',
          'AUTHENTICATOR_MODE_VIRTUAL',
          'SCRIPTED_PROVIDER_AND_CHAIN',
          ...(outcome === 'pass' ? [] : ['CONTROL_NOT_DETECTED_OR_NOT_RUN']),
        ],
        evidenceRefs: [{ type: 'path', value: relative(ROOT, path) }],
        facts: {
          faults: String(selected.length),
          detectedAndRestored: String(detected.length),
          testedCommit: revision.commit ?? 'unknown',
        },
        checkedAt: finishedAt.toISOString(),
      }),
    ],
  });
}
console.log(
  `\nnegative controls: ${outcome.toUpperCase()} (${String(detected.length)} of ${String(selected.length)} detected and restored)${setupFailure === null ? '' : `; ${setupFailure}`}${skipRecord ? '' : ` -> ${relative(ROOT, path)}`}`,
);
process.exitCode = outcome === 'pass' ? 0 : 1;
