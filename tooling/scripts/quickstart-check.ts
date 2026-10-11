/**
 * pnpm quickstart:check: runs the commands in docs/QUICKSTART.md from a clean directory and fails
 * when one stops working or its output no longer contains what the guide says it shows.
 *
 * The guide is the source of truth: fenced blocks tagged `quickstart:<id> <phase>` are executed in
 * order in one shell, and the following `quickstart:expect:<id>` block lists text each output must
 * contain. `quickstart:file <path>` blocks must appear verbatim in that repository file. Path 3 needs
 * the pinned Foundry toolchain: if it is not installed the path is recorded as NOT RUN, never passed.
 *
 * It measures and records, separately, installation time and local execution time. It performs no
 * live step: nothing here contacts a public network except what installing packages needs, and the
 * pnpm store is offline. Evidence is written to docs/evidence/chapter15-quickstart-<date>.json.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './lib';

interface Block {
  readonly kind: 'run' | 'expect' | 'file';
  readonly id: string;
  readonly phase: 'install' | 'execute';
  readonly body: string;
  readonly path?: string;
}

function parse(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^```(\w+) quickstart:(\S+)(?: (\S+))?$/.exec(lines[index] ?? '');
    if (header === null) continue;
    const body: string[] = [];
    index += 1;
    while (index < lines.length && lines[index] !== '```') {
      body.push(lines[index] ?? '');
      index += 1;
    }
    const [, , tag = '', extra] = header;
    const text = body.join('\n');
    if (tag.startsWith('expect:')) {
      blocks.push({
        kind: 'expect',
        id: tag.slice('expect:'.length),
        phase: 'execute',
        body: text,
      });
    } else if (tag === 'file') {
      blocks.push({
        kind: 'file',
        id: extra ?? '',
        phase: 'execute',
        body: text,
        path: extra ?? '',
      });
    } else {
      blocks.push({
        kind: 'run',
        id: tag,
        phase: extra === 'install' ? 'install' : 'execute',
        body: text,
      });
    }
  }
  return blocks;
}

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
}

const markdown = readFileSync(join(ROOT, 'docs', 'QUICKSTART.md'), 'utf8');
const blocks = parse(markdown);
const runs = blocks.filter((block) => block.kind === 'run');
const expectations = new Map(
  blocks.filter((block) => block.kind === 'expect').map((block) => [block.id, block.body]),
);

const forgeInstalled = existsSync(join(ROOT, '.tools', 'foundry'));
const store = execFileSync('pnpm', ['store', 'path'], { cwd: ROOT, encoding: 'utf8' }).trim();
const scratch = mkdtempSync(join(tmpdir(), 'lexaegis-quickstart-'));

/** One shell for all blocks, so `export` and `cd` carry over exactly as for someone pasting them. */
const script = [
  'set -u',
  ...runs.flatMap((block) => {
    if (block.id === 'path3' && !forgeInstalled) return [`echo "@@SKIP ${block.id}@@"`];
    return [
      `echo "@@BEGIN ${block.id} $(date +%s%3N)@@"`,
      block.body,
      `echo "@@END ${block.id} $? $(date +%s%3N)@@"`,
    ];
  }),
].join('\n');

const started = Date.now();
const shell = spawnSync('bash', ['-c', script], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
  env: {
    ...process.env,
    TMPDIR: scratch,
    // The guide says the store can be offline; here it always is.
    QS_PNPM_FLAGS: `--offline --store-dir ${store}`,
    CI: '1',
  },
});
const output = `${shell.stdout}\n${shell.stderr}`;

interface Result {
  id: string;
  phase: string;
  status: 'pass' | 'fail' | 'not_run';
  durationMs: number;
}
const results: Result[] = [];
for (const block of runs) {
  if (output.includes(`@@SKIP ${block.id}@@`)) {
    results.push({ id: block.id, phase: block.phase, status: 'not_run', durationMs: 0 });
    check(`${block.id}: the Foundry toolchain is not installed, so this path was NOT RUN`, true);
    continue;
  }
  const begin = new RegExp(
    `@@BEGIN ${block.id} (\\d+)@@\\n([\\s\\S]*?)@@END ${block.id} (\\d+) (\\d+)@@`,
  ).exec(output);
  if (begin === null) {
    results.push({ id: block.id, phase: block.phase, status: 'fail', durationMs: 0 });
    check(`${block.id}: the block ran`, false, 'it did not complete');
    continue;
  }
  const text = begin[2] ?? '';
  const status = Number(begin[3]);
  const duration = Number(begin[4]) - Number(begin[1]);
  const wanted = (expectations.get(block.id) ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '');
  const missing = wanted.filter((line) => !text.includes(line));
  const ok = status === 0 && missing.length === 0;
  results.push({
    id: block.id,
    phase: block.phase,
    status: ok ? 'pass' : 'fail',
    durationMs: duration,
  });
  check(
    `${block.id} (${block.phase}): runs and shows what the guide says`,
    ok,
    ok
      ? `${String(duration)} ms`
      : `status ${String(status)}; missing: ${missing.join(' | ').slice(0, 200)}`,
  );
}

for (const block of blocks.filter((item) => item.kind === 'file')) {
  const file = block.path ?? '';
  const content = existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), 'utf8') : '';
  check(`the guide quotes ${file} verbatim`, content.includes(block.body.trim()));
}

check(
  'every run block in the guide has an expectation',
  runs.every((block) => expectations.has(block.id)),
);
check(
  'the guide offers no widget embed snippet or URL (NOT YET)',
  /NOT YET/.test(markdown) && !/<script[^>]*widget|embed\.js/i.test(markdown),
);
check(
  'the guide claims no unmeasured speed',
  !/\b(five|5|ten|10)[- ]minutes?\b/i.test(markdown) && !/in minutes/i.test(markdown),
);

const ok = checks.every((item) => item.ok);
const sum = (phase: string): number =>
  results
    .filter((result) => result.phase === phase && result.id !== 'path3')
    .reduce((total, result) => total + result.durationMs, 0);
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const dirty =
  execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
const pnpmVersion = execFileSync('pnpm', ['--version'], { cwd: ROOT, encoding: 'utf8' }).trim();
const date = new Date().toISOString().slice(0, 10);
const evidence = {
  schema: 'lexaegis.quickstart-evidence.v1',
  date,
  evidenceClass: 'local_scripted',
  command: 'pnpm quickstart:check',
  outcome: ok ? 'pass' : 'fail',
  sourceRevision: revision,
  workingTreeDirty: dirty,
  environment: {
    os: `${platform()} ${release()}`,
    arch: arch(),
    node: process.version,
    pnpm: pnpmVersion,
    packageStore: 'offline (the repository store)',
  },
  paths: {
    sdk: results.find((result) => result.id === 'path1') ?? null,
    cli: results.find((result) => result.id === 'path2') ?? null,
    lifecycleLocal: results.find((result) => result.id === 'path3') ?? null,
  },
  timingsMs: {
    installation: sum('install'),
    localExecution: sum('execute'),
    lifecycleLocalExecution: results.find((result) => result.id === 'path3')?.durationMs ?? 0,
    liveStepsPerformedManually: 0,
    wallClockOfThisCheck: Date.now() - started,
  },
  notRun: results.filter((result) => result.status === 'not_run').map((result) => result.id),
  liveSteps: 'not performed: no check contacts a public network',
  outsiderAcceptance: 'NOT YET: no one other than the author has followed the guide',
  widget: 'NOT YET (Chapter 18)',
  note: 'Author-run, automated, offline-store evidence. It is not an outsider following the guide, not independent adoption and not a claim about time for anyone else.',
};
if (process.argv.includes('--write') || ok) {
  writeFileSync(
    join(ROOT, 'docs', 'evidence', `chapter15-quickstart-${date}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}
rmSync(scratch, { recursive: true, force: true });
console.log(
  `\n${String(checks.filter((item) => item.ok).length)} of ${String(checks.length)} checks passed.`,
);
process.exitCode = ok ? 0 : 1;
