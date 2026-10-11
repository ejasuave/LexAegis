/**
 * pnpm contracts:static [-- --write]
 *
 * Solidity static analysis of the production registry and its inheritance, in an ISOLATED copy of
 * the Foundry project (the analyser runs `forge clean` and a forced rebuild, which must never touch
 * contracts/out). The copy keeps the pinned compiler, settings and dependencies unchanged.
 *
 *  1. `forge lint src` with the pinned Foundry: must report nothing.
 *  2. The same lint with the two inline suppressions removed (in the copy only): the diagnostics
 *     the source suppresses, each of which must be triaged.
 *  3. Slither at the pinned version: the full, unfiltered finding list, plus which functions the
 *     registry can reach. No detector, path or severity is excluded.
 *  4. Every finding must be named by exactly one entry of docs/security/static-analysis-triage.json.
 *
 * Exit codes: 0 every finding accounted for; 1 untriaged, stale or mismatched findings, or a lint
 * diagnostic in the source; 3 a tool is unavailable or failed to run (NOT a clean result).
 * `--write` refreshes docs/security/slither-findings.json; without it the committed inventory must
 * already equal the observed one. Nothing is uploaded and no network is used.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { format } from 'prettier';
import {
  PINNED,
  countLintDiagnostics,
  inventorySchema,
  parseSlither,
  reconcile,
  triageSchema,
  unresolved,
  type Inventory,
} from '../src/static-analysis';
import { ROOT } from './lib';

const write = process.argv.includes('--write');
const contracts = join(ROOT, 'contracts');
const work = join(ROOT, '.tools', 'slither', 'work');
const project = join(work, 'contracts');
const findingsPath = join(ROOT, 'docs', 'security', 'slither-findings.json');
const triagePath = join(ROOT, 'docs', 'security', 'static-analysis-triage.json');

function unavailable(reason: string, next: string): never {
  console.log(`NOT YET: ${reason}`);
  console.log(`next: ${next}`);
  process.exit(3);
}

const toolchain = JSON.parse(readFileSync(join(contracts, 'toolchain.json'), 'utf8')) as {
  foundry: { version: string };
};
const forgeDir = join(ROOT, '.tools', 'foundry', `v${toolchain.foundry.version}`);
const forge = join(forgeDir, 'forge');
if (!existsSync(forge))
  unavailable('the pinned Foundry is not installed', 'pnpm contracts:toolchain');
const slither =
  process.env.SLITHER_BIN ?? join(ROOT, '.tools', 'slither', 'venv', 'bin', 'slither');
const python = join(slither, '..', 'python');

// ---- The isolated copy: same sources, settings and dependency tree, a separate out/ and cache/.
function freshCopy(): void {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  cpSync(join(contracts, 'src'), join(project, 'src'), { recursive: true });
  cpSync(join(contracts, 'script'), join(project, 'script'), { recursive: true });
  for (const file of ['foundry.toml', 'toolchain.json'])
    cpSync(join(contracts, file), join(project, file));
  symlinkSync(join(contracts, 'node_modules'), join(project, 'node_modules'));
  symlinkSync(join(ROOT, 'node_modules'), join(work, 'node_modules'));
}
const run = (command: string, args: string[]) =>
  spawnSync(command, args, {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${forgeDir}${delimiter}${process.env.PATH ?? ''}` },
    maxBuffer: 256 * 1024 * 1024,
    timeout: 10 * 60_000,
  });

freshCopy();
const issues: string[] = [];

// ---- 1 and 2: the contract linter.
const lint = run(forge, ['lint', 'src']);
if (lint.status !== 0) unavailable('forge lint did not run', 'pnpm contracts:static');
const lintInSource = countLintDiagnostics(`${lint.stdout}\n${lint.stderr}`);
for (const [rule, count] of Object.entries(lintInSource))
  issues.push(`LINT_DIAGNOSTIC_IN_SOURCE ${rule} x${String(count)}`);

for (const file of readdirSync(join(project, 'src'))) {
  if (!file.endsWith('.sol')) continue;
  const path = join(project, 'src', file);
  writeFileSync(
    path,
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => !line.includes('forge-lint:'))
      .join('\n'),
  );
}
const unsuppressed = run(forge, ['lint', 'src']);
const suppressedLint = countLintDiagnostics(`${unsuppressed.stdout}\n${unsuppressed.stderr}`);
freshCopy(); // the analyser sees the real, unmodified sources

// ---- 3: Slither.
if (!existsSync(slither)) {
  unavailable(
    'Slither is not installed in the isolated environment',
    `uv venv --python 3.13 .tools/slither/venv && uv pip install --python .tools/slither/venv/bin/python slither-analyzer==${PINNED.slither} crytic-compile==${PINNED.cryticCompile}`,
  );
}
const version = spawnSync(slither, ['--version'], { encoding: 'utf8' }).stdout.trim();
if (version !== PINNED.slither)
  unavailable(
    `Slither ${version} is not the pinned ${PINNED.slither}`,
    'reinstall the pinned version',
  );

const reach = run(python, [join(ROOT, 'tooling', 'security', 'slither_reachability.py')]);
const reachLine = reach.stdout
  .split('\n')
  .reverse()
  .find((line) => line.startsWith('{'));
const reachParsed = JSON.parse(reachLine ?? '{}') as { reachable?: string[] };
if (reachParsed.reachable === undefined || reachParsed.reachable.length === 0) {
  unavailable('the reachability pass failed', 'pnpm contracts:static');
}
const reachable = reachParsed.reachable;

const outFile = join(work, 'slither.json');
const analysis = run(slither, ['.', '--json', outFile]);
if (!existsSync(outFile))
  unavailable(
    'Slither produced no output (compilation or execution failed)',
    'pnpm contracts:static',
  );
const parsed = parseSlither(readFileSync(outFile, 'utf8'), new Set(reachable));
if (!parsed.ok) unavailable(`Slither did not complete: ${parsed.reason}`, 'pnpm contracts:static');
const analysed = /analyzed \((\d+) contracts with (\d+) detectors\), (\d+) result/.exec(
  analysis.stderr,
);

const inventory: Inventory = {
  schema: 'lexaegis.security.slither-findings.v1',
  note: 'The FULL, unfiltered Slither finding list for contracts/src and everything it inherits or imports. Paths are relative to contracts/. Triage: static-analysis-triage.json. This is tool output, not an audit.',
  tool: { slither: version, cryticCompile: PINNED.cryticCompile, forge: toolchain.foundry.version },
  target:
    'ProofOfReviewRegistry (contracts/src), with ReviewAuthorization, IProofOfReviewRegistry and the pinned OpenZeppelin contracts it compiles',
  contractsAnalysed: Number(analysed?.[1] ?? 0),
  detectorsRun: Number(analysed?.[2] ?? 0),
  reachableFunctions: reachable,
  findings: parsed.findings,
};
if (inventory.contractsAnalysed === 0 || inventory.detectorsRun === 0) {
  unavailable('Slither reported no analysed contracts or detectors', 'pnpm contracts:static');
}
const text = await format(JSON.stringify(inventorySchema.parse(inventory)), {
  filepath: findingsPath,
  printWidth: 100,
});
if (write) writeFileSync(findingsPath, text);
else if (!existsSync(findingsPath) || readFileSync(findingsPath, 'utf8') !== text)
  issues.push('INVENTORY_DIFFERS_FROM_COMMITTED (run with --write, then triage)');

// ---- 4: reconcile.
const triage = triageSchema.parse(JSON.parse(readFileSync(triagePath, 'utf8')));
for (const issue of reconcile(parsed.findings, suppressedLint, triage))
  issues.push(`${issue.code} ${issue.detail}`);

const byScope = (scope: 'source' | 'dependency') =>
  parsed.findings.filter((finding) => finding.scope === scope).length;
console.log(
  `forge lint: ${String(Object.keys(lintInSource).length)} diagnostic rule(s) in the source; ${String(Object.values(suppressedLint).reduce((a, b) => a + b, 0))} suppressed inline (${Object.entries(
    suppressedLint,
  )
    .map(([rule, count]) => `${rule} x${String(count)}`)
    .join(', ')})`,
);
console.log(
  `slither ${version}: ${String(inventory.contractsAnalysed)} contracts, ${String(inventory.detectorsRun)} detectors, ${String(parsed.findings.length)} findings (${String(byScope('source'))} in src, ${String(byScope('dependency'))} in dependencies), ${String(reachable.length)} reachable functions`,
);
const open = unresolved(triage);
console.log(
  `triage: ${String(triage.slither.length)} slither entries, ${String(triage.lint.length)} lint entries, ${String(open.length)} unresolved${open.length === 0 ? '' : ` (${open.join(', ')})`}`,
);
for (const issue of issues) console.log(`FAIL  ${issue}`);
process.exit(issues.length === 0 ? 0 : 1);
