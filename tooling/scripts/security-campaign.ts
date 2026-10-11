/**
 * pnpm contracts:campaign -- --profile <full|ci> [--seed <hex>] [--record]
 *
 * Runs the contract suites under a TEST-ONLY security profile (campaign sizes supplied as FOUNDRY_*
 * environment overrides, one invariant worker) against the unchanged registry and its pinned build
 * settings, and writes a compact evidence file. `full` is the recorded security campaign
 * (10,000 cases per fuzz property; 1,000 invariant runs at depth 256); `ci` is the bounded routine
 * profile and is recorded as `ci`, never as the full campaign. No key, signature or trace is kept.
 *
 *   --record-from <file>   record an existing evidence file in docs/build-state.json and exit
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { recordEvidence } from '../src/evidence-writer';
import { sourceFingerprint } from '../src/fingerprint';
import {
  PROFILES,
  RECORDED_SEEDS,
  profileEnvironment,
  sameBuildSettings,
  summariseCampaign,
  type ProfileName,
} from '../src/security-campaign';
import { ROOT, gitRevision, stamp } from './lib';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

interface Evidence {
  readonly schema: 'lexaegis.evidence.contract-campaign.v1';
  readonly profile: ProfileName;
  readonly seed: string;
  readonly outcome: 'pass' | 'fail';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationSeconds: number;
  readonly command: string;
  readonly sourceRevision: {
    commit: string | null;
    dirtyWorktree: boolean;
    contentFingerprint: string;
  };
  readonly contractSources: { sha256: string; files: number };
  readonly [key: string]: unknown;
}

async function record(evidence: Evidence, path: string): Promise<void> {
  const result = stamp({
    id: `contract-campaign-${evidence.profile}-${evidence.seed.slice(-8)}-${evidence.startedAt.replace(/\D/g, '').slice(0, 14)}`,
    subject: `contract-campaign-${evidence.profile}`,
    command: evidence.command,
    evidenceClass: 'offline_unit',
    outcome: evidence.outcome,
    reasonCodes: [
      evidence.outcome === 'pass' ? 'CAMPAIGN_COMPLETE' : 'CAMPAIGN_FAILED_OR_INCOMPLETE',
    ],
    evidenceRefs: [{ type: 'path', value: relative(ROOT, path) }],
    facts: {
      profile: evidence.profile,
      seed: evidence.seed,
      contractSourcesSha256: evidence.contractSources.sha256,
    },
    checkedAt: evidence.finishedAt,
  });
  // The result describes the source state the campaign RAN against, not the state at recording.
  await recordEvidence({
    root: ROOT,
    results: [{ ...result, sourceRevision: evidence.sourceRevision }],
  });
}

const recordFrom = option('--record-from');
if (recordFrom !== undefined) {
  const path = join(ROOT, recordFrom);
  await record(JSON.parse(readFileSync(path, 'utf8')) as Evidence, path);
  console.log(`recorded ${recordFrom}`);
  process.exit(0);
}

const profile = option('--profile');
if (profile !== 'full' && profile !== 'ci') {
  console.error('usage: security-campaign.ts --profile <full|ci> [--seed <hex>] [--record]');
  process.exit(2);
}
const seed = option('--seed') ?? RECORDED_SEEDS.pinned;
const sizes = PROFILES[profile];
const environment = profileEnvironment(profile, seed);
const contracts = join(ROOT, 'contracts');

function forge(forgeArgs: string[], extra: Record<string, string>, timeoutMs: number) {
  return spawnSync('pnpm', ['exec', 'tsx', 'scripts/foundry.ts', 'forge', ...forgeArgs], {
    cwd: contracts,
    encoding: 'utf8',
    env: { ...process.env, ...extra },
    maxBuffer: 512 * 1024 * 1024,
    timeout: timeoutMs,
  });
}

/** SHA-256 over the Solidity sources, tests and pinned build inputs the campaign compiled. */
function contractSources(): { sha256: string; files: number } {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(join(contracts, 'src'));
  walk(join(contracts, 'test'));
  files.push(join(contracts, 'foundry.toml'), join(contracts, 'toolchain.json'));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(contracts, file));
    hash.update('\0');
    hash.update(createHash('sha256').update(readFileSync(file)).digest());
  }
  return { sha256: hash.digest('hex'), files: files.length };
}

const revision = gitRevision();
const sourceRevision = { ...revision, contentFingerprint: sourceFingerprint(ROOT) };
const sources = contractSources();
const startedAt = new Date();

const config = (extra: Record<string, string>): Record<string, unknown> => {
  const result = forge(['config', '--json'], extra, 60_000);
  return JSON.parse(result.stdout) as Record<string, unknown>;
};
const baseline = config({});
const effective = config(environment);
const changedBuildSettings = sameBuildSettings(baseline, effective);
const fuzz = effective.fuzz as Record<string, unknown>;
const invariant = effective.invariant as Record<string, unknown>;

console.error(
  `campaign ${profile}: seed ${seed}, ${String(sizes.fuzzRuns)} fuzz cases, ${String(sizes.invariantRuns)} x ${String(sizes.invariantDepth)} invariant calls`,
);
const run =
  changedBuildSettings.length > 0
    ? null
    : forge(['test', '--json'], environment, sizes.timeoutMinutes * 60_000);
const finishedAt = new Date();

const jsonLine = (run?.stdout ?? '')
  .split('\n')
  .reverse()
  .find((line) => line.startsWith('{'));
const summary = summariseCampaign(jsonLine ?? '', sizes);
const issues = [
  ...changedBuildSettings.map((key) => `BUILD_SETTING_CHANGED ${key}`),
  ...(run === null ? [] : summary.issues),
  ...(run !== null && run.error !== undefined ? ['PROCESS_ERROR_OR_TIMEOUT'] : []),
  ...(run !== null && run.status !== 0 ? [`FORGE_EXIT_${String(run.status)}`] : []),
];
const outcome = issues.length === 0 && summary.totals.tests > 0 ? 'pass' : 'fail';

const versionText = forge(['--version'], {}, 60_000).stdout;
const evidence: Evidence = {
  schema: 'lexaegis.evidence.contract-campaign.v1',
  note: 'Local Foundry tests with synthetic keys against the unchanged registry source. Not live-chain evidence and not an audit.',
  profile,
  fullCampaignTarget: profile === 'full',
  seed,
  outcome,
  issues,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  durationSeconds: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
  command: `pnpm contracts:campaign -- --profile ${profile} --seed ${seed}`,
  sourceRevision,
  contractSources: sources,
  toolchain: {
    forge: /Version: (\S+)/.exec(versionText)?.[1] ?? 'unknown',
    forgeCommit: /Commit SHA: ([0-9a-f]+)/.exec(versionText)?.[1] ?? 'unknown',
    solc: String(effective.solc),
    evmVersion: String(effective.evm_version),
    node: process.version,
  },
  effective: {
    fuzzRuns: fuzz.runs,
    fuzzSeed: fuzz.seed,
    fuzzTimeoutSeconds: fuzz.timeout ?? null,
    invariantRuns: invariant.runs,
    invariantDepth: invariant.depth,
    invariantDepthMode: invariant.depth_mode,
    invariantWorkers: environment.FOUNDRY_INVARIANT_WORKERS,
    invariantFailOnRevert: invariant.fail_on_revert,
    invariantTimeoutSeconds: invariant.timeout ?? null,
    processTimeoutMinutes: sizes.timeoutMinutes,
  },
  buildSettingsUnchangedByProfile: changedBuildSettings.length === 0,
  buildSettings: Object.fromEntries(
    [
      'solc',
      'evm_version',
      'optimizer',
      'optimizer_runs',
      'via_ir',
      'bytecode_hash',
      'cbor_metadata',
      'use_literal_content',
    ].map((key) => [key, effective[key]]),
  ),
  totals: summary.totals,
  invariantCampaigns: summary.tests
    .filter((test) => test.kind === 'invariant')
    .map(({ suite, runs, calls, reverts, selectorCalls, status }) => ({
      suite,
      status,
      runs,
      calls,
      reverts,
      selectorCalls,
    })),
  fuzzProperties: summary.tests
    .filter((test) => test.kind === 'fuzz')
    .map(({ suite, name, runs, status }) => ({ suite, name, cases: runs, status })),
  notPassed: summary.tests
    .filter((test) => test.status !== 'Success')
    .map(({ suite, name, status }) => ({ suite, name, status })),
};

const directory = join(ROOT, 'docs', 'evidence');
const name = `chapter17-campaign-${profile}-${seed.slice(-8)}.json`;
const path = join(directory, name);
if (!existsSync(directory)) throw new Error('docs/evidence is missing');
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(
  `${outcome}: ${String(summary.totals.passed)}/${String(summary.totals.tests)} tests, ${String(summary.totals.fuzzCases)} fuzz cases over ${String(summary.totals.fuzzProperties)} properties, ${String(summary.totals.invariantCalls)} invariant calls over ${String(summary.totals.invariantCampaigns)} campaigns, ${String(evidence.durationSeconds)} s -> docs/evidence/${name}`,
);
for (const issue of issues) console.log(`  ${issue}`);
if (args.includes('--record')) await record(evidence, path);
process.exit(outcome === 'pass' ? 0 : 1);
