import { writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, keccak256, type Hex } from 'viem';
import { proofOfReviewRegistryAbi as abi } from '@lexaegis/sdk/registry';
import type { RegistryPolicy } from '@lexaegis/sdk/offline';
import { accounts, creationCode } from '../../../contracts/integration/harness';
import type { SystemChain } from './services';

/*
 * A real registry on a throwaway Anvil chain, deployed by Anvil's published development key (it exists
 * only on this chain). The chain runs under chain ID 10143 so the application's unchanged
 * configuration applies; the harness proved by node identity that it is Anvil on loopback. None of
 * this is a Monad deployment, and Anvil is no evidence of Monad gas charging or execution delay.
 */

export interface DeployedRegistry {
  readonly address: Hex;
  readonly deploymentBlock: bigint;
  readonly transactionHash: Hex;
  readonly runtimeCodeKeccak256: Hex;
  readonly genesisHash: Hex;
  readonly creationCodeKeccak256: Hex;
  readonly policy: RegistryPolicy;
}

export const chainDefinition = (id: number) =>
  ({
    id,
    name: 'Local Anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [] as string[] } },
  }) as const;

export async function deployRegistry(chain: SystemChain): Promise<DeployedRegistry> {
  const definition = chainDefinition(Number(chain.chainId));
  const transport = http(chain.local.rpcUrl);
  const publicClient = createPublicClient({ chain: definition, transport, pollingInterval: 50 });
  const wallet = createWalletClient({ account: accounts.deployer, chain: definition, transport });
  const bytecode = creationCode('ProofOfReviewRegistry.sol', 'ProofOfReviewRegistry');
  const hash = await wallet.deployContract({ abi, bytecode });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.contractAddress == null) throw new Error('no contract address');
  const address = receipt.contractAddress.toLowerCase() as Hex;
  const code = await publicClient.getCode({ address });
  const genesis = await publicClient.getBlock({ blockNumber: 0n });
  const runtimeCodeKeccak256 = keccak256(code ?? '0x');
  const policy: RegistryPolicy = {
    id: 'system.local-anvil-registry',
    chainId: chain.chainId,
    genesisHash: genesis.hash,
    registryAddress: address,
    protocolVersion: '1',
    deploymentBlock: receipt.blockNumber.toString(),
    deploymentTransactionHash: hash,
    runtimeCodeKeccak256,
    executionDelayBlocks: 3,
    executionDelayRevision: 'local-anvil-system-test',
  };
  return {
    address,
    deploymentBlock: receipt.blockNumber,
    transactionHash: hash,
    runtimeCodeKeccak256,
    genesisHash: genesis.hash,
    creationCodeKeccak256: keccak256(bytecode),
    policy,
  };
}

/** The local deployment record the application's test seam reads (a testnet-shaped record, loopback only). */
export function writeLocalDeploymentRecord(
  file: string,
  chain: SystemChain,
  registry: DeployedRegistry,
): void {
  writeFileSync(
    file,
    JSON.stringify({
      schema: 'lexaegis.registry-deployment.v1',
      environment: 'testnet',
      network: 'monad-testnet',
      contract: 'ProofOfReviewRegistry',
      build: {
        solc: '0.8.37+commit.f401782d',
        evmVersion: 'osaka',
        creationCodeKeccak256: registry.creationCodeKeccak256,
      },
      status: 'deployed',
      chainId: chain.chainId,
      registryAddress: registry.address,
      transactionHash: registry.transactionHash,
      blockNumber: registry.deploymentBlock.toString(),
      runtimeCodeKeccak256: registry.runtimeCodeKeccak256,
      genesisHash: registry.genesisHash,
    }),
  );
}

/** Mines a block at a steady pace so execution checkpoints advance while a test waits. */
export function startMiner(chain: SystemChain, everyMs = 300): () => void {
  const state = { running: true };
  void (async () => {
    while (state.running) {
      try {
        await chain.local.transport.request('anvil_mine', ['0x1']);
      } catch {
        // the chain is stopping
      }
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  })();
  return () => {
    state.running = false;
  };
}

/** Funds an address on the throwaway chain. Never used against anything but a proven local node. */
export async function fund(chain: SystemChain, address: string, wei: bigint): Promise<void> {
  await chain.local.transport.request('anvil_setBalance', [address, `0x${wei.toString(16)}`]);
}

export async function lifecycleOf(
  chain: SystemChain,
  registry: Hex,
  reviewer: string,
  commitment: string,
): Promise<readonly unknown[]> {
  const client = createPublicClient({
    chain: chainDefinition(Number(chain.chainId)),
    transport: http(chain.local.rpcUrl),
  });
  const result = await client.readContract({
    address: registry,
    abi,
    functionName: 'getReceipt',
    args: [reviewer as Hex, commitment as Hex],
  });
  return result as unknown as readonly unknown[];
}
