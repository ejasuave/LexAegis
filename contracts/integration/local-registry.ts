/**
 * TEST HARNESS ONLY. A throwaway Anvil chain with the unchanged compiled registry deployed, plus
 * helpers that create real lifecycle records (issue, revoke, supersede) signed by Anvil's
 * development accounts. Used by the SDK and CLI interoperability tests. Local evidence only: it is
 * not a Monad deployment, and the keys exist only on this chain.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  type Hex,
  type LocalAccount,
} from 'viem';
import { foundry } from 'viem/chains';
import { toBase64Url } from '@lexaegis/protocol/portable';
import type { PreparedReviewPackage, ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import {
  buildIssueAction,
  buildRevokeAction,
  buildSupersedeAction,
  buildTypedData,
  defaultActionDeadline,
  proofOfReviewRegistryAbi as abi,
  toAbiReviewAction,
  toEip712ReviewAction,
  type BoundReviewAction,
} from '@lexaegis/sdk/registry';
import type { RegistryPolicy } from '@lexaegis/sdk/offline';
import { startAnvil, type LocalChain } from '../scripts/lib/anvil';
import { accounts, creationCode, expectOk, lower, type LocalBinding } from './harness';

const GAS = 1_000_000n;

export interface LocalRegistry {
  readonly local: LocalChain;
  readonly registry: Hex;
  readonly binding: LocalBinding;
  readonly policy: RegistryPolicy;
  readonly deploymentBlock: string;
  readonly deploymentTransactionHash: Hex;
  mine(count?: number): Promise<unknown>;
  nonceOf(address: string): Promise<string>;
  issue(prepared: PreparedReviewPackage): Promise<void>;
  revoke(reference: ReceiptReferenceV1): Promise<void>;
  supersede(previous: ReceiptReferenceV1, replacement: PreparedReviewPackage): Promise<void>;
  stop(): Promise<void>;
}

/** Deploys the registry on a fresh Anvil node and returns helpers bound to it. */
export async function startLocalRegistry(): Promise<LocalRegistry> {
  const local = await startAnvil();
  const client = () =>
    createPublicClient({ chain: foundry, transport: http(local.rpcUrl), pollingInterval: 50 });
  const walletFor = (account: LocalAccount) =>
    createWalletClient({ account, chain: foundry, transport: http(local.rpcUrl) });
  const mine = (count = 100) => local.transport.request('anvil_mine', [`0x${count.toString(16)}`]);

  const bytecode = creationCode('ProofOfReviewRegistry.sol', 'ProofOfReviewRegistry');
  const hash = await walletFor(accounts.deployer).deployContract({ abi, bytecode });
  const deployed = await client().waitForTransactionReceipt({ hash });
  if (deployed.contractAddress == null) throw new Error('no contract address');
  const registry = lower(deployed.contractAddress) as Hex;
  const binding: LocalBinding = {
    chainId: local.chainId.toString(),
    registryAddress: registry,
    reviewerAddress: lower(accounts.reviewer.address),
  };
  const genesis = await client().getBlock({ blockNumber: 0n });
  const code = await client().getCode({ address: registry });
  const policy: RegistryPolicy = {
    id: 'test.anvil-registry',
    chainId: binding.chainId,
    genesisHash: genesis.hash,
    registryAddress: registry,
    protocolVersion: '1',
    deploymentBlock: deployed.blockNumber.toString(),
    deploymentTransactionHash: hash,
    runtimeCodeKeccak256: keccak256(code ?? '0x'),
    executionDelayBlocks: 3,
    executionDelayRevision: 'local-anvil-test',
  };

  const nonceOf = async (address: string): Promise<string> =>
    (
      await client().readContract({
        address: registry,
        abi,
        functionName: 'nonceOf',
        args: [address as Hex],
      })
    ).toString();
  const deadline = async (): Promise<string> =>
    expectOk(defaultActionDeadline((await client().getBlock()).timestamp.toString()));

  async function execute(bound: BoundReviewAction): Promise<void> {
    const typedData = expectOk(buildTypedData(bound, bound.chainId, bound.registryAddress));
    const action = expectOk(toAbiReviewAction(bound.action));
    const signature = await accounts.reviewer.signTypedData(
      expectOk(toEip712ReviewAction(typedData)),
    );
    const sent = await walletFor(accounts.executor).sendTransaction({
      to: registry,
      data: encodeFunctionData({ abi, functionName: 'execute', args: [action, signature] }),
      gas: GAS,
    });
    const receipt = await client().waitForTransactionReceipt({ hash: sent });
    if (receipt.status !== 'success') throw new Error('registry action reverted');
    await mine();
  }

  return {
    local,
    registry,
    binding,
    policy,
    deploymentBlock: deployed.blockNumber.toString(),
    deploymentTransactionHash: hash,
    mine,
    nonceOf,
    issue: async (prepared) =>
      execute(
        expectOk(
          buildIssueAction(prepared, await nonceOf(binding.reviewerAddress), await deadline()),
        ),
      ),
    revoke: async (reference) =>
      execute(
        expectOk(
          buildRevokeAction(reference, await nonceOf(binding.reviewerAddress), await deadline()),
        ),
      ),
    supersede: async (previous, replacement) =>
      execute(
        expectOk(
          buildSupersedeAction(
            previous,
            replacement,
            await nonceOf(binding.reviewerAddress),
            await deadline(),
          ),
        ),
      ),
    stop: () => local.stop(),
  };
}

/** The readable export (ReviewExportV1) of a prepared package, exactly as the application writes it. */
export function exportBytes(prepared: PreparedReviewPackage): Uint8Array {
  const artifacts = prepared.artifacts();
  return new TextEncoder().encode(
    JSON.stringify({
      schema: 'lexaegis.review-export.v1',
      receiptReference: prepared.reference,
      opening: prepared.opening,
      artifacts: prepared.opening.manifest.artifacts.map((artifact) => ({
        artifactId: artifact.id,
        bytes: toBase64Url(artifacts.get(artifact.id) ?? new Uint8Array()),
      })),
    }),
  );
}
