/**
 * pnpm verify:deployment [-- options]
 *
 * READ-ONLY check that the registry deployed on Monad testnet is the code this repository's pinned
 * source compiles to. It rebuilds the registry in a temporary directory with the recorded settings,
 * resolves every immutable from the deployment context (never from the observed bytes), reads the
 * runtime code at one canonical checkpoint (finalized minus the execution delay, re-checked), and
 * compares every byte. It also reads the deployment transaction and receipt back.
 *
 * It loads no key, signs nothing and sends nothing. The deployment record, the build and the
 * endpoint are this repository's and the operator's: nothing is taken from a review package.
 *
 *   --manifest <path>     deployment record (default contracts/deployments/monad-testnet.json)
 *   --rpc-env <NAME>      environment variable holding the endpoint (default ALCHEMY_MONAD_RPC_URL)
 *   --env-file <path>     load that variable from a local env file (the value is never printed)
 *   --public-rpc          use the public Monad testnet endpoint instead (corroboration)
 *   --policy <p>          exact (default) | metadata-insensitive
 *   --json                print the report as JSON
 *   --evidence            write docs/evidence/chapter17-deployment-verify-<provider>-<date>.json
 *   --record              also append the result to docs/build-state.json (needs --evidence)
 *
 * Exit codes: 0 the code matches under the chosen policy; 10 mismatch (code, immutable, link, code
 * pin, chain identity or deployment transaction); 11 invalid configuration or artifact (record,
 * unreproducible build, unresolved immutable or link); 12 network or evidence unavailable; 2 usage.
 * Limits: 10 s per call, one retry of a transient failure, 60 s for the whole live check.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { recordEvidence } from '../src/evidence-writer';
import { rebuildRegistry } from '../src/deployment-verify/build';
import {
  LIVE_LIMITS,
  RpcUnavailable,
  createRpcReader,
  type RpcReader,
} from '../src/deployment-verify/rpc';
import {
  EXIT,
  verifyDeployment,
  type DeploymentReport,
  type Policy,
} from '../src/deployment-verify/verify';
import { ROOT, gitRevision, stamp } from './lib';

const MONAD_TESTNET_CHAIN_ID = '10143';
const PUBLIC_TESTNET_RPC = 'https://testnet-rpc.monad.xyz/';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const flag = (name: string) => args.includes(name);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const known = new Set([
  '--manifest',
  '--rpc-env',
  '--env-file',
  '--public-rpc',
  '--policy',
  '--json',
  '--evidence',
  '--record',
]);
const usage = (message: string): never => {
  console.error(
    `${message}\nusage: pnpm verify:deployment [-- --manifest <path>] [--rpc-env <NAME>] [--env-file <path>] [--public-rpc] [--policy exact|metadata-insensitive] [--json] [--evidence] [--record]`,
  );
  process.exit(EXIT.USAGE);
};
for (const arg of args) if (arg.startsWith('--') && !known.has(arg)) usage(`unknown option ${arg}`);
const policyText = option('--policy') ?? 'exact';
if (policyText !== 'exact' && policyText !== 'metadata-insensitive') usage('unknown policy');
const policy = policyText as Policy;
if (flag('--record') && !flag('--evidence')) usage('--record needs --evidence');

const manifestPath = join(
  ROOT,
  option('--manifest') ?? join('contracts', 'deployments', 'monad-testnet.json'),
);
const envFile = option('--env-file');
if (envFile !== undefined) {
  if (!existsSync(join(ROOT, envFile))) usage('the env file does not exist');
  process.loadEnvFile(join(ROOT, envFile));
}
const rpcEnv = option('--rpc-env') ?? 'ALCHEMY_MONAD_RPC_URL';
const url = flag('--public-rpc') ? PUBLIC_TESTNET_RPC : (process.env[rpcEnv] ?? '');

const toolchain = JSON.parse(readFileSync(join(ROOT, 'contracts', 'toolchain.json'), 'utf8')) as {
  foundry: { version: string };
};
const forge = join(ROOT, '.tools', 'foundry', `v${toolchain.foundry.version}`, 'forge');

const startedAt = new Date();
const rebuilt = rebuildRegistry({ root: ROOT, forge });
function readRecord(): unknown {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}
const record = readRecord();

/** With no usable endpoint the build can still be checked, but there is no live evidence. */
function reader(): RpcReader {
  try {
    if (url === '') throw new RpcUnavailable('RPC_ENDPOINT_INVALID');
    return createRpcReader({ url });
  } catch {
    return {
      endpoint: 'not configured',
      methods: [],
      call: () => Promise.reject(new RpcUnavailable('RPC_ENDPOINT_INVALID')),
    };
  }
}
const report: DeploymentReport = await verifyDeployment({
  record,
  expectedChainId: MONAD_TESTNET_CHAIN_ID,
  build: rebuilt.build,
  rpc: reader(),
  policy,
});
const finishedAt = new Date();

const revision = gitRevision();
const evidence = {
  schema: 'lexaegis.evidence.deployment-verification.v1',
  note: 'Read-only comparison of deployed runtime code with the pinned source. An RPC observation depends on the endpoint that answered; it is not a consensus proof, and a match is code correspondence, not a security audit.',
  command: `pnpm verify:deployment${flag('--public-rpc') ? ' -- --public-rpc' : ''}${policy === 'exact' ? '' : ` --policy ${policy}`}`,
  checkedAt: finishedAt.toISOString(),
  durationSeconds: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
  verificationCommit: revision.commit,
  dirtyWorktree: revision.dirtyWorktree,
  toolchain: { forge: rebuilt.forgeVersion, node: process.version },
  contractSources: rebuilt.sources,
  rebuild: rebuilt.detail,
  limits: LIVE_LIMITS,
  endpointSource: flag('--public-rpc')
    ? 'public Monad testnet endpoint'
    : `environment variable ${rpcEnv}`,
  report,
};

if (flag('--json')) {
  console.log(JSON.stringify(evidence, null, 2));
} else {
  const { comparison, checkpoint, deploymentTransaction } = report;
  console.log(
    `deployment verification: ${report.outcome.toUpperCase()} (exit ${String(report.exitCode)}), policy ${policy}`,
  );
  if (report.record !== null)
    console.log(
      `  record      ${report.record.network} chain ${report.record.chainId} registry ${report.record.registryAddress}`,
    );
  console.log(
    `  endpoint    ${report.endpoint ?? 'none'} (${evidence.endpointSource}); methods ${[...new Set(report.methods)].join(', ') || 'none'}`,
  );
  if (report.build !== null)
    console.log(
      `  build       ${report.build.compiler}; reproduces the recorded creation code: ${String(report.build.reproducesRecordedCreationCode)}; ${String(report.build.immutables.length)} immutables resolved; ${String(report.build.links)} links`,
    );
  if (checkpoint !== null)
    console.log(
      `  checkpoint  block ${checkpoint.blockNumber} ${checkpoint.blockHash} (finalized ${checkpoint.finalizedBlock}); re-checked: ${String(checkpoint.rechecked)}`,
    );
  if (comparison !== null) {
    console.log(
      `  code        ${report.codeMatch}; observed ${String(comparison.full.observed.bytes)} bytes keccak256 ${comparison.full.observed.keccak256}; expected ${String(comparison.full.expected.bytes)} bytes keccak256 ${comparison.full.expected.keccak256}`,
    );
  }
  if (report.codePin !== null)
    console.log(`  code pin    recorded hash equals observed: ${String(report.codePin.equal)}`);
  if (deploymentTransaction !== null)
    console.log(
      `  deployment  transaction ${deploymentTransaction.status}; sender ${deploymentTransaction.sender ?? 'unknown'}; ${deploymentTransaction.creation}`,
    );
  for (const issue of report.issues) console.log(`  issue       ${issue}`);
  if (rebuilt.build === 'missing' || rebuilt.build === 'invalid')
    console.log(`  build       ${rebuilt.detail}`);
}

if (flag('--evidence')) {
  const provider = flag('--public-rpc') ? 'public' : 'alchemy';
  const name = `chapter17-deployment-verify-${provider}-${finishedAt.toISOString().slice(0, 10)}.json`;
  const path = join(ROOT, 'docs', 'evidence', name);
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  console.error(`evidence: ${relative(ROOT, path)}`);
  if (flag('--record')) {
    await recordEvidence({
      root: ROOT,
      results: [
        stamp({
          id: `deployment-verify-${provider}-${finishedAt.toISOString().replace(/\D/g, '').slice(0, 14)}`,
          subject: 'deployment-verification',
          command: evidence.command,
          evidenceClass: 'live_testnet',
          outcome:
            report.outcome === 'match'
              ? 'pass'
              : report.outcome === 'mismatch'
                ? 'fail'
                : report.outcome === 'unavailable'
                  ? 'unknown'
                  : 'blocked',
          reasonCodes:
            report.issues.length === 0
              ? [`CODE_${report.codeMatch.toUpperCase()}`]
              : report.issues.slice(0, 12),
          evidenceRefs: [{ type: 'path', value: relative(ROOT, path) }],
          facts: {
            codeMatch: report.codeMatch,
            endpoint: report.endpoint ?? 'none',
            checkpointBlock: report.checkpoint?.blockNumber ?? 'none',
            registryAddress: report.record?.registryAddress ?? 'none',
          },
          checkedAt: finishedAt.toISOString(),
        }),
      ],
    });
  }
}
process.exit(report.exitCode);
