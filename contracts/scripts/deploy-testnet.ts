/**
 * Monad-testnet deployment of ProofOfReviewRegistry through the configured Alchemy endpoint.
 *
 *   ALCHEMY_MONAD_RPC_URL=… TESTNET_DEPLOYER_PRIVATE_KEY=… pnpm contracts:deploy:testnet
 *
 * The key and endpoint come from the environment only (never argv, source, logs or generated
 * files). The deployer is an operator-owned testnet account, separate from users' Mera keys and
 * from the funding account. Nothing is deployed unless local contract tests pass and the chain
 * is 10143. Mainnet (143) and every other chain are refused.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { registryDeploymentSchema } from '@lexaegis/sdk/registry';
import { deployRegistry, parseCompiled } from './lib/testnet-deploy';
import { contractsDir, readJsonFile, resolveFoundryTool } from './lib/toolchain';

const TESTNET_CHAIN_ID = 10143n;
const ARTIFACT = join(contractsDir, 'deployments', 'monad-testnet.json');
const DEFAULT_MAX_FEE_WEI = 2n * 10n ** 18n;

function fail(message: string): never {
  console.error(`deploy:testnet refused: ${message}`);
  process.exit(1);
}

function parseMon(text: string | undefined): bigint {
  if (text === undefined || text === '') return DEFAULT_MAX_FEE_WEI;
  const match = /^(0|[1-9][0-9]{0,6})(?:\.([0-9]{1,18}))?$/.exec(text);
  if (match === null) return fail('TESTNET_DEPLOY_MAX_FEE_MON is malformed');
  return BigInt(match[1] ?? '0') * 10n ** 18n + BigInt((match[2] ?? '').padEnd(18, '0'));
}

async function main(): Promise<void> {
  const rpcUrl = process.env.ALCHEMY_MONAD_RPC_URL;
  const key = process.env.TESTNET_DEPLOYER_PRIVATE_KEY;
  if (rpcUrl === undefined || rpcUrl === '') return fail('ALCHEMY_MONAD_RPC_URL is not set');
  if (key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    return fail('TESTNET_DEPLOYER_PRIVATE_KEY is not set or malformed');
  }
  const url = new URL(rpcUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'monad-testnet.g.alchemy.com') {
    return fail('the endpoint is not the Alchemy Monad testnet host');
  }

  console.log('Running local contract tests before any broadcast…');
  const localTestsPassed = (() => {
    try {
      execFileSync(resolveFoundryTool('forge'), ['test'], { cwd: contractsDir, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  const template = z
    .looseObject({ build: z.looseObject({ creationCodeKeccak256: z.string() }) })
    .parse(readJsonFile(join(contractsDir, 'deployments', 'template.json')));
  const existing = existsSync(ARTIFACT)
    ? registryDeploymentSchema.parse(readJsonFile(ARTIFACT))
    : null;
  const compiled = parseCompiled(
    readJsonFile(
      join(contractsDir, 'out', 'ProofOfReviewRegistry.sol', 'ProofOfReviewRegistry.json'),
    ),
  );
  const account = privateKeyToAccount(key as Hex);
  const chain = {
    id: Number(TESTNET_CHAIN_ID),
    name: 'Monad Testnet',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [] as string[] } },
  };
  // No broadcast retry: a repeated send could race a transaction that already landed.
  const transport = http(rpcUrl, { timeout: 15_000, retryCount: 0 });
  const result = await deployRegistry({
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ chain, transport }),
    account,
    expectedChainId: TESTNET_CHAIN_ID,
    compiled,
    creationCodeKeccak256: template.build.creationCodeKeccak256 as Hex,
    build: registryDeploymentSchema.parse({ ...(template as object) }).build,
    environment: 'testnet',
    network: 'monad-testnet',
    maxFeeWei: parseMon(process.env.TESTNET_DEPLOY_MAX_FEE_MON),
    pinnedGenesis:
      existing?.status === 'deployed' ? ((existing.genesisHash as Hex | null) ?? null) : null,
    existing,
    localTestsPassed,
  });
  if (result.kind === 'refused') return fail(result.code);
  if (result.kind === 'deployed') {
    writeFileSync(ARTIFACT, `${JSON.stringify(result.record, null, 2)}\n`);
  }
  console.log(
    `${result.kind}: ${result.record.status === 'deployed' ? result.record.registryAddress : ''}`,
  );
}

void main();
