import { createPublicClient, createWalletClient, http, keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registryDeploymentSchema } from '@lexaegis/sdk/registry';
import { startAnvil, type LocalChain } from '../scripts/lib/anvil';
import {
  deployRegistry,
  parseCompiled,
  runtimeMatchesCompiled,
  type DeployInput,
} from '../scripts/lib/testnet-deploy';
import { readJsonFile } from '../scripts/lib/toolchain';
import { contractsDir } from '../scripts/lib/toolchain';
import { join } from 'node:path';
import { accounts } from './harness';

/*
 * LOCAL EVIDENCE ONLY. The guarded deployment core runs against a throwaway Anvil chain with
 * the expected chain parameterised to 31337. The CLI passes only 10143; nothing here touches
 * Monad testnet or Alchemy.
 */

let local: LocalChain;
const compiled = parseCompiled(
  readJsonFile(
    join(contractsDir, 'out', 'ProofOfReviewRegistry.sol', 'ProofOfReviewRegistry.json'),
  ),
);
const template = registryDeploymentSchema.parse(
  readJsonFile(join(contractsDir, 'deployments', 'template.json')),
);

function input(over: Partial<DeployInput> = {}): DeployInput {
  const chain = {
    id: 31337,
    name: 'local',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [local.rpcUrl] } },
  };
  return {
    publicClient: createPublicClient({ chain, transport: http(local.rpcUrl) }),
    walletClient: createWalletClient({ chain, transport: http(local.rpcUrl) }),
    account: privateKeyToAccount(
      // Anvil development account 0; exists only on this throwaway chain.
      accounts.deployer.getHdKey().privateKey !== null
        ? `0x${Buffer.from(accounts.deployer.getHdKey().privateKey as Uint8Array).toString('hex')}`
        : '0x',
    ),
    expectedChainId: 31337n,
    compiled,
    creationCodeKeccak256: template.build.creationCodeKeccak256 as Hex,
    build: template.build,
    environment: 'local',
    network: 'anvil',
    maxFeeWei: 2n * 10n ** 18n,
    pinnedGenesis: null,
    existing: null,
    localTestsPassed: true,
    ...over,
  };
}

beforeAll(async () => {
  local = await startAnvil();
}, 60_000);
afterAll(async () => {
  await local.stop();
});

describe('guarded registry deployment', () => {
  it('refuses before any broadcast: untested build, wrong chain, wrong genesis, fee policy', async () => {
    const before = await createPublicClient({ transport: http(local.rpcUrl) }).getBlockNumber();
    expect(await deployRegistry(input({ localTestsPassed: false }))).toEqual({
      kind: 'refused',
      code: 'LOCAL_TESTS_NOT_PASSED',
    });
    expect(await deployRegistry(input({ expectedChainId: 10143n }))).toEqual({
      kind: 'refused',
      code: 'WRONG_CHAIN',
    });
    expect(await deployRegistry(input({ pinnedGenesis: `0x${'00'.repeat(32)}` }))).toEqual({
      kind: 'refused',
      code: 'GENESIS_MISMATCH',
    });
    expect(await deployRegistry(input({ maxFeeWei: 1n }))).toEqual({
      kind: 'refused',
      code: 'FEE_POLICY_EXCEEDED',
    });
    expect(await deployRegistry(input({ creationCodeKeccak256: `0x${'00'.repeat(32)}` }))).toEqual({
      kind: 'refused',
      code: 'BUILD_NOT_COMMITTED',
    });
    expect(await createPublicClient({ transport: http(local.rpcUrl) }).getBlockNumber()).toBe(
      before,
    );
  });

  it('deploys, verifies code, version and digest, pins genesis, then reuses instead of redeploying', async () => {
    const first = await deployRegistry(input());
    expect(first.kind).toBe('deployed');
    if (first.kind !== 'deployed' || first.record.status !== 'deployed') throw new Error('deploy');
    expect(first.record.genesisHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.record.runtimeCodeKeccak256).toMatch(/^0x[0-9a-f]{64}$/);

    const client = createPublicClient({ transport: http(local.rpcUrl) });
    const blockBefore = await client.getBlockNumber();
    const again = await deployRegistry(
      input({ existing: first.record, pinnedGenesis: first.record.genesisHash as Hex }),
    );
    expect(again).toMatchObject({ kind: 'reused' });
    expect(await client.getBlockNumber()).toBe(blockBefore);

    // A record whose code hash does not match is an explicit-change situation, never a redeploy.
    const tampered = { ...first.record, runtimeCodeKeccak256: keccak256('0x01') };
    expect(await deployRegistry(input({ existing: tampered }))).toEqual({
      kind: 'refused',
      code: 'RECORD_CODE_MISMATCH',
    });
    expect(await client.getBlockNumber()).toBe(blockBefore);
  });

  it('compares runtime code with immutable slots masked, not naively', () => {
    const code = compiled.deployedBytecode.object as Hex;
    expect(runtimeMatchesCompiled(code, compiled)).toBe(true);
    const [first] = Object.values(compiled.deployedBytecode.immutableReferences)[0] ?? [];
    if (first === undefined) throw new Error('expected an immutable reference');
    const filled =
      `${code.slice(0, 2 + first.start * 2)}${'ab'.repeat(first.length)}${code.slice(2 + (first.start + first.length) * 2)}` as Hex;
    expect(runtimeMatchesCompiled(filled, compiled)).toBe(true);
    const altered = `${code.slice(0, 4)}${code[4] === '0' ? '1' : '0'}${code.slice(5)}` as Hex;
    expect(runtimeMatchesCompiled(altered, compiled)).toBe(false);
  });
});
