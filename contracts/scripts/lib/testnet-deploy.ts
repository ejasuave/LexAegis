/**
 * Guarded Monad-testnet deployment of ProofOfReviewRegistry.
 *
 * The core is parameterised by the chain it expects so that its checks can be exercised against
 * a throwaway local chain; the CLI (../deploy-testnet.ts) only ever passes 10143. It never
 * switches provider or network, buys tokens or uses a production account, and it never
 * redeploys when a matching deployment already exists.
 */
import { keccak256, type Hex, type PublicClient, type WalletClient } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { z } from 'zod';
import {
  buildTypedData,
  hashReviewAction,
  proofOfReviewRegistryAbi as abi,
  registryDeploymentSchema,
  toAbiReviewAction,
  type RegistryDeployment,
} from '@lexaegis/sdk/registry';

export class DeployRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const refuse = (code: string): never => {
  throw new DeployRefusal(code);
};

const compiledSchema = z.looseObject({
  bytecode: z.looseObject({ object: z.string().regex(/^0x[0-9a-f]+$/) }),
  deployedBytecode: z.looseObject({
    object: z.string().regex(/^0x[0-9a-f]+$/),
    immutableReferences: z.record(
      z.string(),
      z.array(z.strictObject({ start: z.number().int(), length: z.number().int() })),
    ),
  }),
});
export type Compiled = z.infer<typeof compiledSchema>;
export const parseCompiled = (value: unknown): Compiled => compiledSchema.parse(value);

/** Runtime code equals the compiled artifact once compiler-declared immutable slots are masked. */
export function runtimeMatchesCompiled(observed: Hex, compiled: Compiled): boolean {
  const expected = compiled.deployedBytecode.object;
  if (observed.length !== expected.length) return false;
  const mask = (hex: string) => {
    const bytes = hex.slice(2).split('');
    for (const spans of Object.values(compiled.deployedBytecode.immutableReferences)) {
      for (const { start, length } of spans) {
        for (let i = start * 2; i < (start + length) * 2; i += 1) bytes[i] = '0';
      }
    }
    return bytes.join('');
  };
  return mask(observed) === mask(expected);
}

export interface DeployInput {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly account: PrivateKeyAccount;
  readonly expectedChainId: bigint;
  readonly compiled: Compiled;
  /** Expected creation-code hash from the committed template. */
  readonly creationCodeKeccak256: Hex;
  readonly build: RegistryDeployment['build'];
  readonly environment: 'testnet' | 'local';
  readonly network: string;
  readonly maxFeeWei: bigint;
  /** A previously recorded genesis hash; the first deployment pins what it observes. */
  readonly pinnedGenesis: Hex | null;
  /** An existing record. A matching deployed one is validated and reused, never replaced. */
  readonly existing: RegistryDeployment | null;
  readonly localTestsPassed: boolean;
}

export type DeployOutcome =
  | { readonly kind: 'reused' | 'deployed'; readonly record: RegistryDeployment }
  | { readonly kind: 'refused'; readonly code: string };

async function verifyDeployed(
  input: DeployInput,
  address: Hex,
  chainId: bigint,
): Promise<{ runtimeCodeKeccak256: Hex }> {
  const { publicClient, compiled } = input;
  const code = await publicClient.getCode({ address });
  if (code === undefined || code === '0x') refuse('NO_RUNTIME_CODE');
  const observed = code as Hex;
  if (!runtimeMatchesCompiled(observed, compiled)) refuse('RUNTIME_CODE_MISMATCH');
  const version = await publicClient.readContract({
    address,
    abi,
    functionName: 'protocolVersion',
  });
  if (version !== 1n) refuse('PROTOCOL_VERSION_MISMATCH');

  // The SDK digest and the deployed hashAction must agree for a synthetic action under this domain.
  const action = {
    reviewer: `0x${'11'.repeat(20)}`,
    action: 0,
    commitment: `0x${'22'.repeat(32)}`,
    replacementCommitment: `0x${'00'.repeat(32)}`,
    nonce: '0',
    deadline: '4102444800',
  };
  const typed = buildTypedData(
    { chainId: chainId.toString(), registryAddress: address.toLowerCase(), action },
    chainId.toString(),
    address.toLowerCase(),
  );
  const abiAction = toAbiReviewAction(action);
  if (!typed.ok || !abiAction.ok) return refuse('SDK_ACTION_INVALID');
  const sdk = hashReviewAction(typed.data);
  const onChain = await publicClient.readContract({
    address,
    abi,
    functionName: 'hashAction',
    args: [abiAction.data as never],
  });
  if (!sdk.ok || sdk.data.toLowerCase() !== onChain.toLowerCase()) refuse('DIGEST_MISMATCH');
  return { runtimeCodeKeccak256: keccak256(observed) };
}

export async function deployRegistry(input: DeployInput): Promise<DeployOutcome> {
  try {
    const { publicClient, walletClient, account } = input;
    if (!input.localTestsPassed) refuse('LOCAL_TESTS_NOT_PASSED');
    const chainId = BigInt(await publicClient.getChainId());
    if (chainId !== input.expectedChainId) refuse('WRONG_CHAIN');

    const genesis = await publicClient.getBlock({ blockNumber: 0n });
    if (input.pinnedGenesis !== null && genesis.hash !== input.pinnedGenesis)
      refuse('GENESIS_MISMATCH');

    // A matching deployment is validated and reused. Uncertainty never triggers a redeploy.
    if (input.existing?.status === 'deployed') {
      if (input.existing.chainId !== chainId.toString()) refuse('RECORD_CHAIN_MISMATCH');
      const verified = await verifyDeployed(input, input.existing.registryAddress as Hex, chainId);
      if (verified.runtimeCodeKeccak256 !== input.existing.runtimeCodeKeccak256) {
        refuse('RECORD_CODE_MISMATCH');
      }
      return { kind: 'reused', record: input.existing };
    }

    if (keccak256(input.compiled.bytecode.object as Hex) !== input.creationCodeKeccak256) {
      refuse('BUILD_NOT_COMMITTED');
    }
    const data = input.compiled.bytecode.object as Hex;
    const gas = await publicClient.estimateGas({ account: account.address, data });
    const gasLimit = (gas * 110n + 99n) / 100n;
    const fees = await publicClient.estimateFeesPerGas();
    const maxFeePerGas = fees.maxFeePerGas;
    const ceiling = gasLimit * maxFeePerGas;
    if (ceiling > input.maxFeeWei) refuse('FEE_POLICY_EXCEEDED');
    if ((await publicClient.getBalance({ address: account.address })) < ceiling) {
      refuse('INSUFFICIENT_TEST_BALANCE');
    }

    const hash = await walletClient.sendTransaction({
      account,
      chain: null,
      data,
      gas: gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || receipt.contractAddress == null)
      refuse('DEPLOYMENT_FAILED');
    const address = (receipt.contractAddress as string).toLowerCase() as Hex;
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash) refuse('NOT_CANONICAL');

    const transaction = await publicClient.getTransaction({ hash });
    if (keccak256(transaction.input) !== input.creationCodeKeccak256)
      refuse('CREATION_CODE_MISMATCH');
    const verified = await verifyDeployed(input, address, chainId);

    const record = registryDeploymentSchema.parse({
      schema: 'lexaegis.registry-deployment.v1',
      status: 'deployed',
      environment: input.environment,
      network: input.network,
      contract: 'ProofOfReviewRegistry',
      build: input.build,
      chainId: chainId.toString(),
      registryAddress: address,
      transactionHash: hash,
      blockNumber: receipt.blockNumber.toString(),
      runtimeCodeKeccak256: verified.runtimeCodeKeccak256,
      genesisHash: genesis.hash,
    });
    return { kind: 'deployed', record };
  } catch (error) {
    if (error instanceof DeployRefusal) return { kind: 'refused', code: error.code };
    return { kind: 'refused', code: 'UNEXPECTED_FAILURE' };
  }
}
