/**
 * pnpm verify:explorer [-- --submit | --status]
 *
 * Source verification of the EXISTING Monad testnet registry on the explorer's Sourcify service
 * (the route Monad documents for Foundry on testnet; no API key). It deploys nothing, needs no
 * key or wallet signature and sends no blockchain transaction.
 *
 *   (no flag)   dry run: build the exact payload preview in an isolated copy of the project, check
 *               it against the allowlist (registry and pinned OpenZeppelin Solidity sources plus
 *               compiler settings only) and scan it for credentials. Nothing leaves the machine.
 *   --submit    after the same checks pass, submit with the pinned `forge verify-contract`, then
 *               read the service's status for this exact chain and address (bounded to 5 minutes).
 *   --status    only read the service's status.
 *
 * The compiler settings are the recorded deployment build's: the source is not flattened or
 * reformatted and no metadata setting is changed to force acceptance. "Submitted" is not verified;
 * only a match reported by the service for this chain and address is. Exit codes: 0 verified,
 * 1 not verified or refused by the allowlist, 3 pending or unavailable.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { recordEvidence } from '../src/evidence-writer';
import {
  checkOutgoing,
  explorerOutcome,
  sourcifyStatusSchema,
  type SourcifyStatus,
} from '../src/explorer-verify';
import { scanSecrets } from '../src/secrets';
import { ROOT, gitRevision, stamp } from './lib';

const VERIFIER_URL = 'https://sourcify-api-monad.blockvision.org/';
const EXPLORER_PAGE = 'https://testnet.monadvision.com/address/';
const GUIDE = 'https://docs.monad.xyz/guides/verify-smart-contract/foundry';
const CONTRACT = 'src/ProofOfReviewRegistry.sol:ProofOfReviewRegistry';
const POLL = { everyMs: 15_000, totalMs: 5 * 60_000 };

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const submit = args.includes('--submit');
const statusOnly = args.includes('--status');

const contracts = join(ROOT, 'contracts');
const record = JSON.parse(
  readFileSync(join(contracts, 'deployments', 'monad-testnet.json'), 'utf8'),
) as {
  status: string;
  chainId: string;
  registryAddress: string;
  build: { solc: string };
};
if (record.status !== 'deployed' || record.chainId !== '10143') {
  console.error('the deployment record is not a deployed Monad testnet registry');
  process.exit(1);
}
const expected = { chainId: record.chainId, address: record.registryAddress };
const toolchain = JSON.parse(readFileSync(join(contracts, 'toolchain.json'), 'utf8')) as {
  foundry: { version: string };
};
const forge = join(ROOT, '.tools', 'foundry', `v${toolchain.foundry.version}`, 'forge');

async function readStatus(): Promise<SourcifyStatus | null> {
  try {
    const response = await fetch(
      `${VERIFIER_URL}v2/contract/${expected.chainId}/${expected.address}`,
      {
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      },
    );
    // The service answers 404 with a body whose match fields are null when it holds nothing.
    if (response.status !== 200 && response.status !== 404) return null;
    const parsed = sourcifyStatusSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const startedAt = new Date();
let outgoing: ReturnType<typeof checkOutgoing> | null = null;
let payloadSha256: string | null = null;
let submission: { exitCode: number | null; summary: string } | null = null;
const issues: string[] = [];

if (!statusOnly) {
  if (!existsSync(forge)) {
    console.error('NOT YET: the pinned Foundry is not installed (pnpm contracts:toolchain)');
    process.exit(3);
  }
  // An isolated copy that holds ONLY sources and build settings: no .env, broadcast log,
  // deployment record, test or cache exists in it, so none can be picked up.
  const work = join(ROOT, '.tools', 'explorer-verify', 'work');
  rmSync(dirname(work), { recursive: true, force: true });
  const project = join(work, 'contracts');
  mkdirSync(project, { recursive: true });
  cpSync(join(contracts, 'src'), join(project, 'src'), { recursive: true });
  cpSync(join(contracts, 'script'), join(project, 'script'), { recursive: true });
  for (const file of ['foundry.toml', 'toolchain.json'])
    cpSync(join(contracts, file), join(project, file));
  symlinkSync(join(contracts, 'node_modules'), join(project, 'node_modules'));
  symlinkSync(join(ROOT, 'node_modules'), join(work, 'node_modules'));
  const verifyArgs = [
    'verify-contract',
    expected.address,
    CONTRACT,
    '--chain',
    expected.chainId,
    '--verifier',
    'sourcify',
    '--verifier-url',
    VERIFIER_URL,
  ];
  const run = (extra: string[], timeout: number) =>
    spawnSync(forge, [...verifyArgs, ...extra], {
      cwd: project,
      encoding: 'utf8',
      timeout,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });

  const preview = run(['--show-standard-json-input'], 5 * 60_000);
  outgoing = checkOutgoing(preview.stdout);
  issues.push(...outgoing.issues);
  payloadSha256 = createHash('sha256').update(preview.stdout).digest('hex');
  // Credential scan over the exact outgoing sources, written out on their own.
  const scanDir = join(work, 'outgoing');
  for (const [path, { content }] of Object.entries(
    (
      JSON.parse(preview.stdout || '{"sources":{}}') as {
        sources: Record<string, { content: string }>;
      }
    ).sources,
  )) {
    const target = join(scanDir, path.replace(/^node_modules\//, 'dependencies/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const findings = existsSync(scanDir) ? scanSecrets(scanDir, {}) : [];
  for (const finding of findings) issues.push(`CREDENTIAL_PATTERN ${finding.rule} ${finding.file}`);

  console.log(
    `outgoing payload: ${String(outgoing.sources.length)} Solidity sources, ${String(outgoing.sources.reduce((sum, source) => sum + source.bytes, 0))} bytes, sha256 ${payloadSha256}`,
  );
  for (const source of outgoing.sources)
    console.log(`  ${source.path} (${String(source.bytes)} bytes)`);
  console.log(`settings: ${JSON.stringify({ ...outgoing.settings, outputSelection: undefined })}`);
  console.log(`allowlist and credential scan: ${issues.length === 0 ? 'pass' : 'FAIL'}`);
  for (const issue of issues) console.log(`  ${issue}`);

  if (submit && issues.length === 0) {
    const sent = run([], 5 * 60_000);
    const text = `${sent.stdout}\n${sent.stderr}`;
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.includes('ERROR'));
    submission = { exitCode: sent.status, summary: lines.slice(-6).join(' | ').slice(0, 600) };
    console.log(`submission: forge exit ${String(sent.status)}: ${submission.summary}`);
  }
}

// A read of the service's own answer is the only source of the result.
let status = await readStatus();
if (submit && issues.length === 0) {
  const deadline = Date.now() + POLL.totalMs;
  while (explorerOutcome(status, expected) !== 'verified' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL.everyMs));
    status = await readStatus();
  }
}
const observed = explorerOutcome(status, expected);
const outcome =
  issues.length > 0 ? 'refused' : observed === 'not_verified' && submit ? 'pending' : observed;
const finishedAt = new Date();
console.log(
  `explorer status for chain ${expected.chainId} address ${expected.address}: ${outcome}${status === null ? '' : ` (match ${String(status.match)}, creation ${String(status.creationMatch)}, runtime ${String(status.runtimeMatch)})`}`,
);

if (submit || statusOnly) {
  const revision = gitRevision();
  const evidence = {
    schema: 'lexaegis.evidence.explorer-verification.v1',
    note: 'Explorer source verification is code correspondence reported by a third-party service. It is separate from the bytecode comparison (pnpm verify:deployment), cannot override it, and is not a security audit.',
    command: `pnpm verify:explorer -- ${submit ? '--submit' : '--status'}`,
    checkedAt: finishedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    verificationCommit: revision.commit,
    dirtyWorktree: revision.dirtyWorktree,
    guide: {
      url: GUIDE,
      readOn: '2026-10-11',
      route: 'Foundry with the Sourcify verifier; no API key; chain 10143',
    },
    verifier: 'Sourcify (MonadVision / BlockVision instance)',
    verifierUrl: VERIFIER_URL,
    explorerPage: `${EXPLORER_PAGE}${expected.address}`,
    chainId: expected.chainId,
    address: expected.address,
    compiler: record.build.solc,
    tool: { forge: toolchain.foundry.version },
    outgoing:
      outgoing === null
        ? null
        : {
            sha256: payloadSha256,
            sources: outgoing.sources,
            settings: { ...outgoing.settings, outputSelection: undefined },
            allowlistIssues: issues,
          },
    submission,
    polling: submit
      ? { everySeconds: POLL.everyMs / 1000, limitSeconds: POLL.totalMs / 1000 }
      : null,
    outcome,
    serviceStatus: status,
  };
  const path = join(
    ROOT,
    'docs',
    'evidence',
    `chapter17-explorer-verification-${finishedAt.toISOString().slice(0, 10)}.json`,
  );
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  console.error(`evidence: ${relative(ROOT, path)}`);
  await recordEvidence({
    root: ROOT,
    results: [
      stamp({
        id: `explorer-verification-${finishedAt.toISOString().replace(/\D/g, '').slice(0, 14)}`,
        subject: 'explorer-verification',
        command: evidence.command,
        evidenceClass: 'live_testnet',
        outcome:
          outcome === 'verified'
            ? 'pass'
            : outcome === 'pending'
              ? 'pending'
              : outcome === 'unavailable'
                ? 'unknown'
                : 'fail',
        reasonCodes: [`EXPLORER_${outcome.toUpperCase()}`],
        evidenceRefs: [
          { type: 'path', value: relative(ROOT, path) },
          { type: 'url', value: evidence.explorerPage },
        ],
        facts: {
          verifier: 'sourcify',
          matchLevel: status?.match ?? 'none',
          address: expected.address,
        },
        checkedAt: finishedAt.toISOString(),
      }),
    ],
  });
}
process.exit(
  outcome === 'verified' ? 0 : outcome === 'refused' || outcome === 'not_verified' ? 1 : 3,
);
