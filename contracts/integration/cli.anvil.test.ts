import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256 } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PreparedReviewPackage } from '@lexaegis/protocol/v1';
import { toBase64Url } from '@lexaegis/protocol/portable';
import { consumerBinary, installConsumer, packPackages } from '../../tooling/src/packed-consumer';
import { creationCode, prepareLocalPackage } from './harness';
import { exportBytes, startLocalRegistry, type LocalRegistry } from './local-registry';

/** A URL that carries a credential, assembled at run time so no credential-shaped literal sits in the source. */
const withKey = (host: string, key = 'key'): string =>
  ['https://user', key].join(':') + '@' + host + '/';

/*
 * LOCAL COMPATIBILITY EVIDENCE ONLY. The CLI is built, packed and installed into a fresh directory
 * outside the monorepo (no workspace links, no path aliases, no repository source), then run as a
 * spawned process through its public binary against the unchanged compiled registry on an isolated
 * Anvil chain (31337). Lifecycle results come from real contract reads; only failure branches use
 * a controlled proxy. A recording proxy sits between the CLI and the node so every outbound RPC
 * method and body can be audited. Not Monad evidence, not package publication.
 */

const repository = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOWED_METHODS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call']);

interface Recorded {
  readonly method: string;
  readonly body: string;
}
type Mode = 'pass' | 'wrong-chain' | 'hang';

let chain: LocalRegistry;
let scratch: string;
let binary: string;
let consumer: string;
let proxy: Server;
let proxyUrl = '';
let mode: Mode = 'pass';
const recorded: Recorded[] = [];
const hung: (() => void)[] = [];

async function startProxy(target: string): Promise<void> {
  proxy = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let method = '(unparsed)';
        try {
          method = (JSON.parse(body) as { method?: string }).method ?? '(none)';
        } catch {
          // recorded as unparsed
        }
        recorded.push({ method, body });
        if (mode === 'hang') {
          hung.push(() => response.destroy());
          return; // never answered: the CLI must be interruptible
        }
        const upstream = await fetch(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        let text = await upstream.text();
        if (mode === 'wrong-chain' && method === 'eth_chainId') {
          text = text.replace(/"result":"0x[0-9a-f]+"/, '"result":"0x1"');
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(text);
      })();
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  proxyUrl = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}/`;
}

interface Outcome {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: CliJson;
}

const baseEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.PROOF_OF_REVIEW_RPC_URL;
  return env;
};

/** Runs the installed binary. Asynchronous on purpose: the recording proxy lives in this process. */
function cli(args: string[], env: NodeJS.ProcessEnv = baseEnv()): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { cwd: consumer, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      let json: CliJson = NO_JSON;
      try {
        json = JSON.parse(stdout) as CliJson;
      } catch {
        // text mode
      }
      resolve({ status: code ?? -1, stdout, stderr, json });
    });
  });
}

/** Failure context for an assertion message: codes only, never content. */
const explain = (outcome: Outcome): string =>
  JSON.stringify({
    exit: outcome.json.exit,
    error: outcome.json.error,
    issues: outcome.json.report?.issues,
    stderr: outcome.stderr.slice(0, 300),
  });

/** Counts the RPC requests made while `action` runs. */
async function requestsDuring<T>(action: () => Promise<T>): Promise<{ result: T; count: number }> {
  const before = recorded.length;
  const result = await action();
  return { result, count: recorded.length - before };
}

function setFirstArtifact(exportJson: { artifacts: { bytes: string }[] }, bytes: Uint8Array): void {
  const entry = exportJson.artifacts[0];
  if (entry === undefined) throw new Error('export has no artifacts');
  entry.bytes = toBase64Url(bytes);
}

const write = (name: string, content: Uint8Array | string): string => {
  const path = join(scratch, name);
  writeFileSync(path, content);
  return path;
};

let policyFile: string;
let deploymentFile: string;
const live = (extra: string[] = [], rpc: string | null = proxyUrl): string[] => [
  '--chain-id',
  '31337',
  '--registry',
  chain.registry,
  '--deployment',
  policyFile,
  ...(rpc === null ? [] : ['--rpc', rpc]),
  '--allow-loopback-http',
  '--json',
  ...extra,
];

let first: PreparedReviewPackage; // not found, then active, then superseded
let second: PreparedReviewPackage; // replaces first
let third: PreparedReviewPackage; // issued, then revoked
const files: Record<string, { file: string; reference: string }> = {};
const pkg = (name: string): { file: string; reference: string } => {
  const found = files[name];
  if (found === undefined) throw new Error(`package ${name} was not prepared`);
  return found;
};

interface CliReport {
  readonly mode: string;
  readonly referenceOrigin: string;
  readonly manifestIntegrity: string;
  readonly artifactIntegrity: string;
  readonly registryIdentity: string;
  readonly receiptBinding: string;
  readonly chainStatus: string;
  readonly signerAcceptance: string;
  readonly registryPolicyId: string | null;
  readonly checkpoint: { readonly chainId: string } | null;
  readonly issues: readonly { readonly code: string }[];
}
interface CliJson {
  readonly command: string;
  readonly exit: { readonly code: number; readonly meaning: string };
  readonly filesEvaluated: boolean;
  readonly signerRequirements: string;
  readonly rpcSource: string | null;
  readonly report: CliReport | null;
  readonly error: {
    readonly source: string;
    readonly code: string;
    readonly subject?: string;
  } | null;
}
const NO_JSON: CliJson = {
  command: 'none',
  exit: { code: -1, meaning: 'unparsed' },
  filesEvaluated: false,
  signerRequirements: '',
  rpcSource: null,
  report: null,
  error: null,
};

function files_(name: string, prepared: PreparedReviewPackage) {
  files[name] = {
    file: write(`${name}.export.json`, exportBytes(prepared)),
    reference: write(`${name}.reference.json`, JSON.stringify(prepared.reference)),
  };
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'cli-anvil-'));
  consumer = join(scratch, 'consumer');
  const tarballs = join(scratch, 'tarballs');
  mkdirSync(consumer);
  mkdirSync(tarballs);

  // A fresh, separate install of the three packed packages: the thing a user would have.
  const packed = packPackages(repository, tarballs, ['protocol', 'sdk', 'cli'], true);
  installConsumer(repository, consumer, packed);
  binary = consumerBinary(consumer);

  chain = await startLocalRegistry();
  await startProxy(chain.local.rpcUrl);
  policyFile = write('policy.json', JSON.stringify(chain.policy));
  deploymentFile = write(
    'deployment.json',
    JSON.stringify({
      schema: 'lexaegis.registry-deployment.v1',
      environment: 'local',
      network: 'anvil',
      contract: 'ProofOfReviewRegistry',
      build: {
        solc: '0.8.37+commit.f401782d',
        evmVersion: 'osaka',
        creationCodeKeccak256: keccak256(
          creationCode('ProofOfReviewRegistry.sol', 'ProofOfReviewRegistry'),
        ),
      },
      status: 'deployed',
      chainId: chain.policy.chainId,
      registryAddress: chain.registry,
      transactionHash: chain.deploymentTransactionHash,
      blockNumber: chain.deploymentBlock,
      runtimeCodeKeccak256: chain.policy.runtimeCodeKeccak256,
      genesisHash: chain.policy.genesisHash,
    }),
  );

  first = await prepareLocalPackage('legal', chain.binding, null);
  files_('first', first);
  await chain.mine();
}, 300_000);

afterAll(async () => {
  for (const release of hung) release();
  proxy.close();
  await chain.stop();
  rmSync(scratch, { recursive: true, force: true });
});

describe('proof-of-review against real local registry records (installed from tarballs)', () => {
  it('exit 13: verified not_found in the correct registry, from a real read', async () => {
    const run = await cli([
      'verify',
      pkg('first').file,
      ...live(['--expected-reference', pkg('first').reference]),
    ]);
    expect(run.status, explain(run)).toBe(13);
    expect(run.json).toMatchObject({
      command: 'verify',
      exit: { code: 13, meaning: 'not_found' },
      filesEvaluated: true,
      signerRequirements: 'not_evaluated',
      rpcSource: 'flag',
      report: {
        referenceOrigin: 'independent',
        manifestIntegrity: 'match',
        artifactIntegrity: 'match',
        registryIdentity: 'match',
        chainStatus: 'not_found',
        signerAcceptance: 'unknown',
      },
    });
  });

  it('exit 0: an active receipt and matching files; exit 0 says nothing about the signer', async () => {
    await chain.issue(first);
    await chain.mine();
    const independent = await cli([
      'verify',
      pkg('first').file,
      ...live(['--expected-reference', pkg('first').reference]),
    ]);
    expect(independent.status, explain(independent)).toBe(0);
    expect(independent.json.report).toMatchObject({
      referenceOrigin: 'independent',
      chainStatus: 'active',
      receiptBinding: 'match',
      registryIdentity: 'match',
      signerAcceptance: 'unknown',
    });
    expect(independent.json.report?.checkpoint?.chainId).toBe('31337');
    // No independent reference: still checked, honestly labelled, never presented as protection.
    const declared = await cli(['verify', pkg('first').file, ...live()]);
    expect(declared.status, explain(declared)).toBe(0);
    expect(declared.json.report?.referenceOrigin).toBe('file-declared');
    expect(declared.json.report?.issues.map((issue: { code: string }) => issue.code)).toContain(
      'EXPECTATION_FROM_FILE',
    );
    expect(JSON.stringify(declared.json)).not.toMatch(/"valid"/);
  });

  it('status: active record only, files explicitly not evaluated, reviewer does not certify the account', async () => {
    const run = await cli([
      'status',
      '--reviewer',
      chain.binding.reviewerAddress,
      '--commitment',
      first.reference.commitment,
      ...live(),
    ]);
    expect(run.status, explain(run)).toBe(0);
    expect(run.json).toMatchObject({
      command: 'status',
      filesEvaluated: false,
      signerRequirements: 'not_evaluated',
      report: { mode: 'reference-only', chainStatus: 'active', signerAcceptance: 'unknown' },
    });
    const text = await cli([
      'status',
      '--reviewer',
      chain.binding.reviewerAddress,
      '--commitment',
      first.reference.commitment,
      ...live().filter((item) => item !== '--json'),
    ]);
    expect(text.status, explain(text)).toBe(0);
    expect(text.stdout).toContain('not evaluated (no package was supplied)');
    expect(text.stdout).toContain('does not certify the account');
    // eslint-disable-next-line no-control-regex
    expect(text.stdout.replace(/\n/g, '')).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('exit 12: superseded; the replacement is read separately and the original stays superseded', async () => {
    second = await prepareLocalPackage('legal-revised', chain.binding, first.reference);
    files_('second', second);
    await chain.supersede(first.reference, second);
    await chain.mine();
    const original = await cli([
      'verify',
      pkg('first').file,
      ...live(['--expected-reference', pkg('first').reference]),
    ]);
    expect(original.status, explain(original)).toBe(12);
    expect(original.json.report?.chainStatus).toBe('superseded');
    const replacement = await cli([
      'verify',
      pkg('second').file,
      ...live(['--expected-reference', pkg('second').reference]),
    ]);
    expect(replacement.status, explain(replacement)).toBe(0);
    expect(replacement.json.report).toMatchObject({
      chainStatus: 'active',
      receiptBinding: 'match',
    });
  });

  it('exit 11: revoked', async () => {
    third = await prepareLocalPackage('legal', chain.binding, null);
    files_('third', third);
    await chain.issue(third);
    await chain.revoke(third.reference);
    await chain.mine();
    const run = await cli([
      'verify',
      pkg('third').file,
      ...live(['--expected-reference', pkg('third').reference]),
    ]);
    expect(run.status, explain(run)).toBe(11);
    expect(run.json.report).toMatchObject({ chainStatus: 'revoked', artifactIntegrity: 'match' });
    // Revoking the replacement elsewhere never reactivates a superseded receipt: still 12.
    expect(
      (
        await cli([
          'verify',
          pkg('first').file,
          ...live(['--expected-reference', pkg('first').reference]),
        ])
      ).status,
    ).toBe(12);
  });

  it('exit 10 and no request: changed bytes, incomplete package, wrong expected reference', async () => {
    const exportJson = JSON.parse(readFileSync(pkg('first').file, 'utf8')) as {
      artifacts: { artifactId: string; bytes: string }[];
    };
    const changed = structuredClone(exportJson);
    setFirstArtifact(changed, new Uint8Array([1, 2, 3, 4]));
    const incomplete = structuredClone(exportJson);
    incomplete.artifacts.pop();

    const cases: [string, string[], string][] = [
      [
        'changed bytes',
        [
          write('changed.json', JSON.stringify(changed)),
          ...live(['--expected-reference', pkg('first').reference]),
        ],
        'ARTIFACT_LENGTH_MISMATCH',
      ],
      [
        'incomplete package',
        [
          write('incomplete.json', JSON.stringify(incomplete)),
          ...live(['--expected-reference', pkg('first').reference]),
        ],
        'ARTIFACT_SET_MISMATCH',
      ],
      [
        'wrong reference',
        [pkg('second').file, ...live(['--expected-reference', pkg('third').reference])],
        'COMMITMENT_MISMATCH',
      ],
    ];
    for (const [name, args, code] of cases) {
      const { result, count } = await requestsDuring(() => cli(['verify', ...args]));
      expect(result.status, name).toBe(10);
      expect(count, `${name}: no request after a local failure`).toBe(0);
      expect(JSON.stringify(result.json), name).toContain(code);
      expect(result.json.report?.chainStatus ?? 'unknown', name).toBe('unknown');
    }
  });

  it('keeps distinct SDK codes: a file that is not a review export is not a mismatch', async () => {
    const notExport = write(
      'not-export.json',
      JSON.stringify({ schema: 'lexaegis.encrypted-review-export.v1' }),
    );
    const run = await cli(['verify', notExport, ...live()]);
    expect(run.status, explain(run)).toBe(10);
    expect(run.json.error).toMatchObject({
      source: 'export',
      code: 'WRONG_FORMAT_ENCRYPTED_BACKUP',
    });
    expect(run.json.report).toBeNull();
  });

  it('exit 20: unreachable RPC keeps local integrity and is never read as not_found', async () => {
    const run = await cli([
      'verify',
      pkg('first').file,
      ...live(['--expected-reference', pkg('first').reference], 'http://127.0.0.1:1/'),
    ]);
    expect(run.status, explain(run)).toBe(20);
    expect(run.json.report).toMatchObject({
      manifestIntegrity: 'match',
      artifactIntegrity: 'match',
      chainStatus: 'unknown',
    });
    expect(run.json.report?.issues.map((issue: { code: string }) => issue.code)).toContain(
      'LIVE_RPC_UNAVAILABLE',
    );
  });

  it('exit 20: wrong chain, wrong registry code and an empty registry are identity failures, never statuses', async () => {
    mode = 'wrong-chain';
    const wrongChain = await cli([
      'verify',
      pkg('first').file,
      ...live(['--expected-reference', pkg('first').reference]),
    ]);
    mode = 'pass';
    expect(wrongChain.status, explain(wrongChain)).toBe(20);
    expect(wrongChain.json.report).toMatchObject({
      registryIdentity: 'mismatch',
      chainStatus: 'unknown',
    });

    const wrongCodeFile = write(
      'wrong-code.json',
      JSON.stringify({ ...chain.policy, runtimeCodeKeccak256: `0x${'ab'.repeat(32)}` }),
    );
    const wrongCode = await cli([
      'verify',
      pkg('first').file,
      ...live(['--expected-reference', pkg('first').reference]).map((item) =>
        item === policyFile ? wrongCodeFile : item,
      ),
    ]);
    expect(wrongCode.status, explain(wrongCode)).toBe(20);
    expect(wrongCode.json.report).toMatchObject({
      registryIdentity: 'mismatch',
      chainStatus: 'unknown',
    });

    // A registry address with no code at all (status needs no package).
    const empty = `0x${'77'.repeat(20)}`;
    const emptyPolicy = write(
      'empty.json',
      JSON.stringify({ ...chain.policy, registryAddress: empty }),
    );
    const emptyRun = await cli([
      'status',
      '--chain-id',
      '31337',
      '--registry',
      empty,
      '--reviewer',
      chain.binding.reviewerAddress,
      '--commitment',
      first.reference.commitment,
      '--deployment',
      emptyPolicy,
      '--rpc',
      proxyUrl,
      '--allow-loopback-http',
      '--json',
    ]);
    expect(emptyRun.status, explain(emptyRun)).toBe(20);
    expect(emptyRun.json.report).toMatchObject({
      registryIdentity: 'mismatch',
      chainStatus: 'unknown',
    });
  });

  it('exit 20: missing deployment pins fail closed; an arbitrary responding address is not identity', async () => {
    const noDeployment = await cli([
      'verify',
      pkg('first').file,
      '--chain-id',
      '31337',
      '--registry',
      chain.registry,
      '--rpc',
      proxyUrl,
      '--allow-loopback-http',
      '--json',
    ]);
    expect(noDeployment.status, explain(noDeployment)).toBe(20);
    expect(noDeployment.json.error).toMatchObject({
      source: 'cli',
      code: 'DEPLOYMENT_PINS_MISSING',
    });
    expect(noDeployment.json.report).toMatchObject({
      manifestIntegrity: 'match',
      chainStatus: 'unknown',
    });

    const unpinned = JSON.parse(readFileSync(deploymentFile, 'utf8')) as Record<string, unknown>;
    delete unpinned.genesisHash;
    const noGenesis = await cli([
      'verify',
      pkg('first').file,
      ...live().map((item) =>
        item === policyFile ? write('unpinned.json', JSON.stringify(unpinned)) : item,
      ),
    ]);
    expect(noGenesis.status, explain(noGenesis)).toBe(20);
    expect(noGenesis.json.error?.code).toBe('DEPLOYMENT_PINS_MISSING');

    const noRpc = await cli([
      'verify',
      pkg('first').file,
      '--chain-id',
      '31337',
      '--registry',
      chain.registry,
      '--deployment',
      policyFile,
      '--json',
    ]);
    expect(noRpc.status, explain(noRpc)).toBe(20);
    expect(noRpc.json.error?.code).toBe('RPC_NOT_CONFIGURED');
  });

  it('accepts a deployment record (not just a policy) with a genesis pin', async () => {
    const run = await cli([
      'verify',
      pkg('first').file,
      ...live(['--expected-reference', pkg('first').reference]).map((item) =>
        item === policyFile ? deploymentFile : item,
      ),
    ]);
    expect(run.status, explain(run)).toBe(12);
    expect(run.json.report?.registryPolicyId).toBe('deployment-file.31337');
  });

  it('exit 2: usage errors, contradictory configuration and unreadable paths, with parseable JSON', async () => {
    const empty = await requestsDuring(async () => {
      const outcomes = [
        await cli(['verify', '--json']),
        await cli(['frobnicate', '--json']),
        await cli([
          'verify',
          pkg('first').file,
          '--chain-id',
          'abc',
          '--registry',
          chain.registry,
          '--json',
        ]),
        await cli([
          'verify',
          pkg('first').file,
          '--chain-id',
          '31337',
          '--registry',
          '0x12',
          '--json',
        ]),
        await cli(['verify', pkg('first').file, ...live(['--private-key', 'x'])]),
        await cli(['verify', join(scratch, 'does-not-exist'), ...live()]),
        await cli(['verify', scratch, ...live()]),
        // --deployment for another chain than the command line: contradictory, not reconciled.
        await cli([
          'verify',
          pkg('first').file,
          ...live().map((item) =>
            item === policyFile
              ? write('other-chain.json', JSON.stringify({ ...chain.policy, chainId: '1' }))
              : item,
          ),
        ]),
        // An expected reference for another registry than the command line.
        await cli([
          'verify',
          pkg('first').file,
          ...live([
            '--expected-reference',
            write(
              'other-registry.json',
              JSON.stringify({ ...first.reference, registryAddress: `0x${'66'.repeat(20)}` }),
            ),
          ]),
        ]),
        await cli([
          'status',
          ...live(),
          '--reviewer',
          'nope',
          '--commitment',
          first.reference.commitment,
        ]),
      ];
      return outcomes;
    });
    for (const outcome of empty.result) {
      expect(outcome.status, explain(outcome)).toBe(2);
      expect(outcome.json.exit).toEqual({ code: 2, meaning: 'usage' });
      expect(outcome.json.report).toBeNull();
    }
    expect(empty.count, 'no request is made for a usage or configuration error').toBe(0);
    expect(empty.result[7]?.json.error).toMatchObject({ code: 'CONFIG_CONTRADICTORY' });
    expect(empty.result[8]?.json.error).toMatchObject({ code: 'CONFIG_CONTRADICTORY' });
    // Usage errors in text mode go to stderr and name the problem, never a value.
    const text = await cli(['verify', '--chain-id', 'secret-value']);
    expect(text.status, explain(text)).toBe(2);
    expect(text.stdout).toBe('');
    expect(text.stderr).not.toContain('secret-value');
  });

  it('bounds input: an oversized package is exit 10 without reading, a FIFO or directory is exit 2', async () => {
    const big = join(scratch, 'big.json');
    writeFileSync(big, '');
    truncateSync(big, 49 * 1024 * 1024);
    const oversized = await cli(['verify', big, ...live()]);
    expect(oversized.status, explain(oversized)).toBe(10);
    expect(oversized.json.error).toMatchObject({ source: 'export', code: 'INPUT_TOO_LARGE' });
    const fifo = join(scratch, 'fifo');
    spawnSync('mkfifo', [fifo]);
    const run = await requestsDuring(() => cli(['verify', fifo, ...live()]));
    expect(run.result.status).toBe(2);
    expect(run.result.json.error?.code).toBe('INPUT_NOT_A_REGULAR_FILE');
    expect(run.count).toBe(0);
  });

  it('RPC precedence: --rpc, then PROOF_OF_REVIEW_RPC_URL; a malformed choice is never replaced', async () => {
    const withoutRpc = [
      'verify',
      pkg('third').file,
      '--chain-id',
      '31337',
      '--registry',
      chain.registry,
      '--deployment',
      policyFile,
      '--allow-loopback-http',
      '--json',
    ];
    const environment = (url: string): NodeJS.ProcessEnv => ({
      ...baseEnv(),
      PROOF_OF_REVIEW_RPC_URL: url,
    });
    const fromEnvironment = await cli(withoutRpc, environment(proxyUrl));
    expect(fromEnvironment.status, explain(fromEnvironment)).toBe(11);
    expect(fromEnvironment.json.rpcSource).toBe('environment');
    // The explicit flag wins over a dead environment value.
    const flagWins = await cli(
      [...withoutRpc, '--rpc', proxyUrl],
      environment('http://127.0.0.1:1/'),
    );
    expect(flagWins.status, explain(flagWins)).toBe(11);
    expect(flagWins.json.rpcSource).toBe('flag');
    // A malformed environment value is an error, not silently skipped.
    expect((await cli(withoutRpc, environment('http://example.invalid/'))).status).toBe(2);
    // A malformed flag is not replaced by a good environment value, and the URL is never echoed.
    const bad = await cli(
      [...withoutRpc, '--rpc', withKey('rpc.example.invalid', 'topsecret')],
      environment(proxyUrl),
    );
    expect(bad.status, explain(bad)).toBe(2);
    expect(bad.json.error).toMatchObject({ code: 'RPC_ENDPOINT_INVALID', subject: '--rpc' });
    expect(bad.stdout + bad.stderr).not.toContain('topsecret');
    // Without --allow-loopback-http, plain HTTP to a local node is refused even for a good value.
    expect(
      (
        await cli(
          withoutRpc.filter((item) => item !== '--allow-loopback-http'),
          environment(proxyUrl),
        )
      ).status,
    ).toBe(2);
  });

  it('error precedence: usage (2) beats integrity (10), and integrity (10) beats an untrusted chain (20)', async () => {
    const changed = JSON.parse(readFileSync(pkg('first').file, 'utf8')) as {
      artifacts: { bytes: string }[];
    };
    setFirstArtifact(changed, new Uint8Array([9]));
    const badFile = write('precedence.json', JSON.stringify(changed));
    const withBadRpc = await requestsDuring(() =>
      cli(['verify', badFile, ...live([], withKey('rpc.example.invalid'))]),
    );
    expect(withBadRpc.result.status, explain(withBadRpc.result)).toBe(2);
    // No deployment pin AND a changed package: the package failure is reported, not the missing pin.
    const noPin = await requestsDuring(() =>
      cli(['verify', badFile, '--chain-id', '31337', '--registry', chain.registry, '--json']),
    );
    expect(noPin.result.status, explain(noPin.result)).toBe(10);
    expect(withBadRpc.count + noPin.count).toBe(0);
  });

  it('exit 130: SIGTERM cancels an in-flight read promptly and nothing is left running', async () => {
    mode = 'hang';
    const child = spawn(
      binary,
      ['verify', pkg('third').file, ...live(['--expected-reference', pkg('third').reference])],
      { cwd: consumer, env: baseEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => resolve(code)),
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const started = Date.now();
    child.kill('SIGTERM');
    const code = await Promise.race([
      exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
    ]);
    mode = 'pass';
    for (const release of hung.splice(0)) release();
    expect(code).toBe(130);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(JSON.parse(stdout)).toMatchObject({
      exit: { code: 130, meaning: 'interrupted' },
      error: { code: 'INTERRUPTED' },
    });
  }, 30_000);

  it('only the four read-only RPC methods were ever sent, with no private or signing data', () => {
    expect(recorded.length).toBeGreaterThan(20);
    for (const request of recorded)
      expect(ALLOWED_METHODS.has(request.method), request.method).toBe(true);
    const everything = recorded
      .map((request) => request.body)
      .join('\n')
      .toLowerCase();
    for (const forbidden of [
      'eth_send',
      'eth_sign',
      'eth_accounts',
      'personal_',
      'eth_requestaccounts',
    ]) {
      expect(everything).not.toContain(forbidden);
    }
    // Public parameters only: nothing from inside the package ever left the process.
    const exportFile = JSON.parse(readFileSync(pkg('first').file, 'utf8')) as {
      opening: {
        blindingNonce: string;
        manifest: { artifacts: { sha256: string; label: string | null }[] };
      };
      artifacts: { bytes: string }[];
    };
    const secrets = [
      exportFile.opening.blindingNonce,
      ...exportFile.opening.manifest.artifacts.map((artifact) => artifact.sha256),
      ...exportFile.opening.manifest.artifacts.flatMap((artifact) =>
        artifact.label === null ? [] : [artifact.label],
      ),
      ...exportFile.artifacts.map((artifact) => artifact.bytes.slice(0, 24)),
      'SYNTHETIC',
      'first.export.json',
      scratch,
    ];
    for (const secret of secrets) {
      expect(everything.includes(secret.toLowerCase()), 'a private value reached the RPC').toBe(
        false,
      );
    }
  });
});
