/**
 * LOCAL-ONLY deployment and smoke check of ProofOfReviewRegistry.
 *
 *   pnpm contracts:deploy:local                                  start a throwaway Anvil and use it
 *   pnpm contracts:deploy:local --rpc-url http://127.0.0.1:8545  use a local node already running
 *
 * It refuses any RPC target that is not an http loopback address and any chain that is a public
 * network, so it cannot broadcast to Monad testnet or mainnet. The deployer is an unlocked
 * account of the local node; no key is read, stored or printed. The record it writes is labelled
 * "local" and goes to the git-ignored contracts/deployments/local directory: it is local
 * evidence and never a testnet or mainnet deployment record.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'prettier';
import { decodeFunctionResult, encodeFunctionData, keccak256, type Hex } from 'viem';
import { z } from 'zod';
import type { ChainTransport } from '@lexaegis/sdk';
import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  decodeReceipt,
  proofOfReviewRegistryAbi as abi,
  registryDeploymentSchema,
  type RegistryDeployment,
} from '@lexaegis/sdk/registry';
import { startAnvil, type LocalChain } from './lib/anvil';
import {
  assertLoopbackUrl,
  createLocalTransport,
  LocalOnlyError,
  requireLocalChain,
} from './lib/local-rpc';
import { contractsDir, readJsonFile, resolveFoundryTool, ToolchainError } from './lib/toolchain';

const SCRIPT = 'script/DeployRegistry.s.sol';

const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);

const broadcastSchema = z.looseObject({
  transactions: z
    .array(
      z.looseObject({
        hash: hashSchema,
        transactionType: z.literal('CREATE'),
        contractName: z.literal('ProofOfReviewRegistry'),
        contractAddress: addressSchema,
      }),
    )
    .length(1),
});

const receiptSchema = z.looseObject({
  status: z.literal('0x1'),
  blockNumber: hexSchema,
  contractAddress: addressSchema,
});
const transactionSchema = z.looseObject({ input: hexSchema, to: z.null() });
const templateSchema = z.looseObject({
  build: z.strictObject({
    solc: z.string(),
    evmVersion: z.string(),
    creationCodeKeccak256: hashSchema,
  }),
});

function hex(value: string): Hex {
  return hexSchema.parse(value) as Hex;
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`smoke check failed: ${message}`);
}

async function call(transport: ChainTransport, to: string, data: Hex): Promise<Hex> {
  return hex(z.string().parse(await transport.request('eth_call', [{ to, data }, 'latest'])));
}

function rpcUrlArgument(): string | null {
  const index = process.argv.indexOf('--rpc-url');
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined) throw new LocalOnlyError('--rpc-url needs a value.');
  return assertLoopbackUrl(value);
}

async function deploy(rpcUrl: string, transport: ChainTransport): Promise<RegistryDeployment> {
  const chainId = await requireLocalChain(transport);
  const [sender] = z
    .array(addressSchema)
    .min(1)
    .parse(await transport.request('eth_accounts', []));
  if (sender === undefined) throw new Error('the local node exposes no unlocked account');

  execFileSync(
    resolveFoundryTool('forge'),
    ['script', SCRIPT, '--rpc-url', rpcUrl, '--broadcast', '--unlocked', '--sender', sender],
    { cwd: contractsDir, stdio: ['ignore', 'ignore', 'inherit'] },
  );

  const run = broadcastSchema.parse(
    readJsonFile(
      join(
        contractsDir,
        'broadcast',
        'DeployRegistry.s.sol',
        chainId.toString(),
        'run-latest.json',
      ),
    ),
  );
  const [created] = run.transactions;
  if (created === undefined) throw new Error('no deployment transaction was recorded');
  const registryAddress = created.contractAddress.toLowerCase();

  // Everything below is observed from the node, not copied from the script's own output.
  const receipt = receiptSchema.parse(
    await transport.request('eth_getTransactionReceipt', [created.hash]),
  );
  check(receipt.contractAddress.toLowerCase() === registryAddress, 'receipt address differs');
  const transaction = transactionSchema.parse(
    await transport.request('eth_getTransactionByHash', [created.hash]),
  );
  const { build } = templateSchema.parse(
    readJsonFile(join(contractsDir, 'deployments', 'template.json')),
  );
  check(
    keccak256(hex(transaction.input)) === build.creationCodeKeccak256,
    'deployed creation code is not the committed build; run "pnpm contracts:artifacts"',
  );

  const code = hex(
    z.string().parse(await transport.request('eth_getCode', [registryAddress, 'latest'])),
  );
  check(code.length > 2, 'no code at the deployed address');

  const version = decodeFunctionResult({
    abi,
    functionName: 'protocolVersion',
    data: await call(
      transport,
      registryAddress,
      encodeFunctionData({ abi, functionName: 'protocolVersion' }),
    ),
  });
  check(version === 1n, 'protocolVersion is not 1');

  const [, name, domainVersion, domainChainId, verifyingContract] = decodeFunctionResult({
    abi,
    functionName: 'eip712Domain',
    data: await call(
      transport,
      registryAddress,
      encodeFunctionData({ abi, functionName: 'eip712Domain' }),
    ),
  });
  check(
    name === EIP712_DOMAIN_NAME && domainVersion === EIP712_DOMAIN_VERSION,
    'unexpected EIP-712 domain',
  );
  check(domainChainId === chainId, 'domain chain ID differs from the node');
  check(verifyingContract.toLowerCase() === registryAddress, 'domain verifying contract differs');

  // A fresh registry holds nothing: an arbitrary lookup decodes as NotFound.
  const probe = {
    schema: 'lexaegis.receipt-ref.v1',
    chainId: chainId.toString(),
    registryAddress,
    reviewerAddress: sender.toLowerCase(),
    commitment: `0x${'01'.repeat(32)}`,
  };
  const empty = decodeReceipt(
    probe,
    await call(
      transport,
      registryAddress,
      encodeFunctionData({
        abi,
        functionName: 'getReceipt',
        args: [hex(probe.reviewerAddress), hex(probe.commitment)],
      }),
    ),
  );
  check(empty.ok && empty.data.receiptLifecycle === 'not_found', 'a fresh registry is not empty');

  return registryDeploymentSchema.parse({
    schema: 'lexaegis.registry-deployment.v1',
    status: 'deployed',
    environment: 'local',
    network: 'anvil',
    contract: 'ProofOfReviewRegistry',
    build,
    chainId: chainId.toString(),
    registryAddress,
    transactionHash: created.hash,
    blockNumber: BigInt(receipt.blockNumber).toString(),
    runtimeCodeKeccak256: keccak256(code),
  });
}

let started: LocalChain | null = null;
try {
  const supplied = rpcUrlArgument();
  started = supplied === null ? await startAnvil() : null;
  const rpcUrl = supplied ?? started?.rpcUrl;
  if (rpcUrl === undefined) throw new Error('no local RPC endpoint');

  const record = await deploy(rpcUrl, started?.transport ?? createLocalTransport(rpcUrl));
  const directory = join(contractsDir, 'deployments', 'local');
  const path = join(
    directory,
    `anvil-${record.status === 'deployed' ? record.chainId : 'unknown'}.json`,
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, await format(JSON.stringify(record), { parser: 'json' }));

  console.log('LOCAL deployment and smoke check passed (not a testnet or mainnet deployment).');
  console.log(JSON.stringify(record, null, 2));
  if (started !== null)
    console.log('The throwaway Anvil chain has been stopped; the address above no longer exists.');
} catch (error) {
  if (error instanceof LocalOnlyError || error instanceof ToolchainError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  // Stops only an Anvil process this script started.
  await started?.stop();
}
