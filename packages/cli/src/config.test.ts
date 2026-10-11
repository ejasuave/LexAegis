import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RPC_ENV, readDeployment, resolvePolicy, resolveRpc } from './config';
import { KNOWN_DEPLOYMENTS } from './known-deployments.generated';

const directory = mkdtempSync(join(tmpdir(), 'cli-config-'));
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});
const write = (name: string, content: unknown): string => {
  const path = join(directory, name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
};

const hash = (n: string) => `0x${n.repeat(32)}`;
const REGISTRY = `0x${'33'.repeat(20)}`;
const deployed = {
  schema: 'lexaegis.registry-deployment.v1',
  environment: 'local',
  network: 'anvil',
  contract: 'ProofOfReviewRegistry',
  build: { solc: '0.8.37+commit.f401782d', evmVersion: 'osaka', creationCodeKeccak256: hash('aa') },
  status: 'deployed',
  chainId: '31337',
  registryAddress: REGISTRY,
  transactionHash: hash('bb'),
  blockNumber: '12',
  runtimeCodeKeccak256: hash('cc'),
  genesisHash: hash('dd'),
};

describe('RPC precedence', () => {
  const known = {
    policy: KNOWN_DEPLOYMENTS[0]?.policy as never,
    source: 'known-deployment' as const,
    publicRpcUrl: 'https://public.example.invalid/',
  };
  const base = { env: {}, known: null, allowLoopbackHttp: false, flag: undefined };

  it('prefers --rpc, then the environment, then a known deployment, and invents nothing', () => {
    const env = { [RPC_ENV]: 'https://env.example.invalid/' };
    expect(
      resolveRpc({ ...base, flag: 'https://flag.example.invalid/', env, known }),
    ).toMatchObject({
      value: { source: 'flag' },
    });
    expect(resolveRpc({ ...base, env, known })).toMatchObject({ value: { source: 'environment' } });
    expect(resolveRpc({ ...base, known })).toMatchObject({ value: { source: 'known-public' } });
    expect(resolveRpc(base)).toEqual({ ok: true, value: null });
  });

  it('never replaces a malformed explicit choice with the next source, and never echoes the URL', () => {
    const env = { [RPC_ENV]: 'https://env.example.invalid/' };
    const flagged = resolveRpc({
      ...base,
      flag: 'https://user:key@rpc.example.invalid/',
      env,
      known,
    });
    expect(flagged).toEqual({ ok: false, code: 'RPC_ENDPOINT_INVALID', subject: '--rpc' });
    expect(JSON.stringify(flagged)).not.toContain('key');
    expect(
      resolveRpc({ ...base, env: { [RPC_ENV]: 'http://rpc.example.invalid/' }, known }),
    ).toEqual({
      ok: false,
      code: 'RPC_ENDPOINT_INVALID',
      subject: RPC_ENV,
    });
  });

  it('accepts loopback HTTP only when explicitly allowed, and still refuses a key in the URL', () => {
    expect(resolveRpc({ ...base, flag: 'http://127.0.0.1:8545/' }).ok).toBe(false);
    expect(
      resolveRpc({ ...base, flag: 'http://127.0.0.1:8545/', allowLoopbackHttp: true }).ok,
    ).toBe(true);
    expect(
      resolveRpc({ ...base, flag: 'http://127.0.0.1:8545/?key=x', allowLoopbackHttp: true }).ok,
    ).toBe(false);
  });
});

describe('deployment pins', () => {
  it('builds a policy from a deployment record that has a genesis pin', async () => {
    const loaded = await readDeployment(write('deployment.json', deployed));
    expect(loaded).toMatchObject({
      ok: true,
      value: {
        chainId: '31337',
        registryAddress: REGISTRY,
        genesisHash: hash('dd'),
        protocolVersion: '1',
      },
    });
  });

  it('accepts a registry policy file as given', async () => {
    const policy = {
      id: 'my.policy',
      chainId: '31337',
      genesisHash: hash('dd'),
      registryAddress: REGISTRY,
      protocolVersion: '1',
      deploymentBlock: '12',
      deploymentTransactionHash: hash('bb'),
      runtimeCodeKeccak256: hash('cc'),
      executionDelayBlocks: 0,
      executionDelayRevision: 'mine',
    };
    expect(await readDeployment(write('policy.json', policy))).toEqual({ ok: true, value: policy });
  });

  it('treats a record without a genesis pin, or not deployed, as missing pins', async () => {
    const { genesisHash: _omitted, ...unpinned } = deployed;
    expect(await readDeployment(write('unpinned.json', unpinned))).toMatchObject({
      ok: false,
      code: 'DEPLOYMENT_PINS_MISSING',
    });
    const notDeployed = {
      schema: deployed.schema,
      environment: 'local',
      network: 'anvil',
      contract: deployed.contract,
      build: deployed.build,
      status: 'not_deployed',
      intendedChainId: '31337',
    };
    expect(await readDeployment(write('not-deployed.json', notDeployed))).toMatchObject({
      ok: false,
      code: 'DEPLOYMENT_PINS_MISSING',
    });
  });

  it('rejects malformed, unknown-field and oversized deployment files without echoing content', async () => {
    for (const content of ['{', '[]', JSON.stringify({ ...deployed, extra: 'x' }), 'null']) {
      const result = await readDeployment(write('bad.json', content));
      expect(result).toMatchObject({ ok: false, code: 'DEPLOYMENT_FILE_INVALID' });
    }
    expect(await readDeployment(write('big.json', ' '.repeat(70_000)))).toMatchObject({
      ok: false,
      code: 'INPUT_TOO_LARGE',
    });
    expect(await readDeployment(join(directory, 'missing.json'))).toMatchObject({
      ok: false,
      code: 'INPUT_UNREADABLE',
    });
  });

  it('a deployment that names another chain or registry than the command line is contradictory', async () => {
    const path = write('deployment.json', deployed);
    expect(
      await resolvePolicy({ chainId: '1', registryAddress: REGISTRY, deploymentPath: path }),
    ).toMatchObject({ ok: false, code: 'CONFIG_CONTRADICTORY' });
    expect(
      await resolvePolicy({
        chainId: '31337',
        registryAddress: `0x${'44'.repeat(20)}`,
        deploymentPath: path,
      }),
    ).toMatchObject({ ok: false, code: 'CONFIG_CONTRADICTORY' });
    expect(
      await resolvePolicy({ chainId: '31337', registryAddress: REGISTRY, deploymentPath: path }),
    ).toMatchObject({ ok: true, value: { source: 'deployment-file' } });
  });

  it('an arbitrary registry has no pin: the built-in deployment is used only for its exact chain and address', async () => {
    const known = KNOWN_DEPLOYMENTS[0]?.policy as { chainId: string; registryAddress: string };
    expect(
      await resolvePolicy({
        chainId: known.chainId,
        registryAddress: known.registryAddress,
        deploymentPath: undefined,
      }),
    ).toMatchObject({ ok: true, value: { source: 'known-deployment' } });
    expect(
      await resolvePolicy({
        chainId: known.chainId,
        registryAddress: REGISTRY,
        deploymentPath: undefined,
      }),
    ).toEqual({ ok: true, value: null });
    expect(
      await resolvePolicy({
        chainId: '1',
        registryAddress: known.registryAddress,
        deploymentPath: undefined,
      }),
    ).toEqual({ ok: true, value: null });
  });
});
