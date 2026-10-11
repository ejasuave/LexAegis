import { join } from 'node:path';
import { keccak256, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildRegistry } from '../../tooling/src/deployment-verify/build';
import { createRpcReader } from '../../tooling/src/deployment-verify/rpc';
import { verifyDeployment, type BuildInput } from '../../tooling/src/deployment-verify/verify';
import { readToolchain, repoRoot } from '../scripts/lib/toolchain';
import { startLocalRegistry, type LocalRegistry } from './local-registry';

/*
 * LOCAL EVIDENCE ONLY. The deployment checker runs against the unchanged registry deployed on a
 * throwaway Anvil chain (31337), so the immutables it derives are compared with the values a REAL
 * constructor wrote. It is not a Monad observation; the testnet result is recorded separately by
 * `pnpm verify:deployment`. Code is replaced with `anvil_setCode` only on this local chain.
 */

let chain: LocalRegistry;
let build: BuildInput;
let record: Record<string, unknown>;
let deployedCode: Hex;

const rpc = () => createRpcReader({ url: chain.local.rpcUrl, allowLoopbackHttp: true });
const request = <T>(method: string, params: unknown[]) =>
  chain.local.transport.request(method, params) as Promise<T>;
const check = (
  over: Record<string, unknown> = {},
  policy: 'exact' | 'metadata-insensitive' = 'exact',
) =>
  verifyDeployment({
    record: { ...record, ...over },
    expectedChainId: '31337',
    build,
    rpc: rpc(),
    policy,
  });
const setCode = async (code: Hex) => {
  await request('anvil_setCode', [chain.registry, code]);
  await chain.mine();
};
const flip = (code: Hex, byteOffset: number): Hex => {
  const at = 2 + byteOffset * 2;
  return `${code.slice(0, at)}${(parseInt(code.slice(at, at + 2), 16) ^ 1).toString(16).padStart(2, '0')}${code.slice(at + 2)}` as Hex;
};

beforeAll(async () => {
  chain = await startLocalRegistry();
  await chain.mine();
  const forge = join(repoRoot, '.tools', 'foundry', `v${readToolchain().foundry.version}`, 'forge');
  const rebuilt = rebuildRegistry({ root: repoRoot, forge });
  if (rebuilt.build === 'missing' || rebuilt.build === 'invalid') throw new Error(rebuilt.detail);
  build = rebuilt.build;
  deployedCode = await request<Hex>('eth_getCode', [chain.registry, 'latest']);
  const genesis = await request<{ hash: Hex }>('eth_getBlockByNumber', ['0x0', false]);
  record = {
    schema: 'lexaegis.registry-deployment.v1',
    environment: 'local',
    network: 'anvil',
    contract: 'ProofOfReviewRegistry',
    build: {
      solc: build.expectedSettings.solc,
      evmVersion: build.expectedSettings.evmVersion,
      creationCodeKeccak256: keccak256(build.compiled.bytecode.object as Hex),
    },
    status: 'deployed',
    chainId: '31337',
    registryAddress: chain.registry.toLowerCase(),
    transactionHash: chain.deploymentTransactionHash,
    blockNumber: chain.deploymentBlock,
    runtimeCodeKeccak256: keccak256(deployedCode),
    genesisHash: genesis.hash,
  };
});
afterAll(async () => {
  await chain.stop();
});

describe('deployment verification against a real local deployment', () => {
  it('rebuilds from the pinned source and resolves all seven EIP-712 immutables to the deployed values', async () => {
    const report = await check();
    expect(report).toMatchObject({
      outcome: 'match',
      exitCode: 0,
      issues: [],
      codeMatch: 'exact_match',
      codePin: { equal: true },
      checkpoint: { rechecked: true },
      deploymentTransaction: { status: 'consistent' },
    });
    // Exact: the expected code, built without reading the chain, hashes to the deployed code.
    expect(report.comparison?.full.expected.keccak256).toBe(keccak256(deployedCode));
    expect(report.build?.immutables.map((item) => item.label).sort()).toEqual([
      'EIP712._cachedChainId',
      'EIP712._cachedDomainSeparator',
      'EIP712._cachedThis',
      'EIP712._hashedName',
      'EIP712._hashedVersion',
      'EIP712._name',
      'EIP712._version',
    ]);
    expect(report.build).toMatchObject({
      reproducesRecordedCreationCode: true,
      metadataAppended: true,
      links: 0,
    });
    // The chain id immutable really is this local chain's, not a copied constant.
    expect(
      report.build?.immutables.find((item) => item.label === 'EIP712._cachedChainId')?.value,
    ).toBe(`0x${(31337).toString(16).padStart(64, '0')}`);
    for (const method of report.methods)
      expect(/send|sign|estimate|setCode|mine/i.test(method)).toBe(false);
  });

  it('the same code under another address or chain id is an immutable mismatch, not a match', async () => {
    // Same runtime placed at a different address: `_cachedThis` and the separator no longer fit.
    const elsewhere = `0x${'5e'.repeat(20)}`;
    await request('anvil_setCode', [elsewhere, deployedCode]);
    await chain.mine();
    const report = await check({ registryAddress: elsewhere });
    expect(report.outcome).toBe('mismatch');
    expect(report.issues).toEqual(
      expect.arrayContaining(['IMMUTABLE_MISMATCH', 'DEPLOYMENT_TX_INCONSISTENT']),
    );
    expect(report.comparison?.differences).toMatchObject({ executableBytes: 0 });
    expect(report.comparison?.differences.immutables).toEqual(
      expect.arrayContaining(['EIP712._cachedThis', 'EIP712._cachedDomainSeparator']),
    );
  });

  it('a one-byte change in executable code, and in an immutable, is detected on the real bytecode', async () => {
    const executable = flip(deployedCode, 10);
    await setCode(executable);
    const first = await check({ runtimeCodeKeccak256: keccak256(executable) });
    expect(first).toMatchObject({ outcome: 'mismatch', exitCode: 10, codeMatch: 'mismatch' });
    expect(first.issues).toEqual(['EXECUTABLE_MISMATCH']);
    expect(first.comparison?.differences).toMatchObject({
      executableBytes: 1,
      firstOffset: 10,
      immutables: [],
    });

    const reference = build.compiled.deployedBytecode.immutableReferences;
    const start = Object.values(reference)[0]?.[0]?.start ?? 0;
    const immutable = flip(deployedCode, start + 31);
    await setCode(immutable);
    const second = await check({ runtimeCodeKeccak256: keccak256(immutable) });
    expect(second.issues).toEqual(['IMMUTABLE_MISMATCH']);
    expect(second.comparison?.differences.executableBytes).toBe(0);

    await setCode(deployedCode);
    expect((await check()).outcome).toBe('match');
  });

  it('a changed metadata trailer alone is a metadata-only match, accepted only when asked for', async () => {
    // Replace the 12-byte solc-only trailer with a valid ipfs + solc trailer.
    const body = deployedCode.slice(0, -24);
    const other = `${body}a2646970667358221220${'cd'.repeat(32)}64736f6c63430008250033` as Hex;
    await setCode(other);
    const exact = await check({ runtimeCodeKeccak256: keccak256(other) });
    expect(exact).toMatchObject({
      outcome: 'mismatch',
      codeMatch: 'metadata_only_match',
      issues: ['METADATA_ONLY_MATCH_UNDER_EXACT_POLICY'],
    });
    const relaxed = await check({ runtimeCodeKeccak256: keccak256(other) }, 'metadata-insensitive');
    expect(relaxed).toMatchObject({ outcome: 'match', codeMatch: 'metadata_only_match' });
    expect(relaxed.comparison?.normalised?.observed.keccak256).toBe(
      relaxed.comparison?.normalised?.expected.keccak256,
    );
    // The recorded pin of the ORIGINAL code is not satisfied by a normalised match.
    const pinned = await check({}, 'metadata-insensitive');
    expect(pinned.issues).toEqual(['CODE_PIN_MISMATCH']);
    await setCode(deployedCode);
  });

  it('an address with no code, a wrong chain record and a wrong genesis are refused', async () => {
    const empty = await check({ registryAddress: `0x${'77'.repeat(20)}` });
    expect(empty.issues).toEqual(expect.arrayContaining(['NO_RUNTIME_CODE']));
    expect(empty.codeMatch).toBe('not_compared');
    expect(await check({ chainId: '10143' })).toMatchObject({
      outcome: 'invalid',
      issues: ['RECORD_NOT_EXPECTED_NETWORK'],
      methods: [],
    });
    expect(await check({ genesisHash: `0x${'00'.repeat(32)}` })).toMatchObject({
      outcome: 'mismatch',
      issues: ['GENESIS_MISMATCH'],
    });
  });

  it('an unreachable endpoint is unavailable, with nothing compared', async () => {
    const report = await verifyDeployment({
      record,
      expectedChainId: '31337',
      build,
      rpc: createRpcReader({ url: 'http://127.0.0.1:9/', allowLoopbackHttp: true }),
      policy: 'exact',
    });
    expect(report).toMatchObject({
      outcome: 'unavailable',
      exitCode: 12,
      codeMatch: 'not_compared',
      issues: ['RPC_UNAVAILABLE'],
    });
  });
});
