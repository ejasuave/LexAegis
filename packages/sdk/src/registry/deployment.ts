import { z } from 'zod';
import { chainIdSchema, digestSchema, nonZeroAddressSchema } from '@lexaegis/protocol/v1';
import { uint256DecimalSchema } from './typed-data';

export const REGISTRY_DEPLOYMENT_SCHEMA = 'lexaegis.registry-deployment.v1';
export const REGISTRY_CONTRACT_NAME = 'ProofOfReviewRegistry';

export const MONAD_TESTNET_CHAIN_ID = '10143';
export const MONAD_MAINNET_CHAIN_ID = '143';

/** Where a deployment lives. Local evidence is never testnet or mainnet evidence. */
export const deploymentEnvironmentSchema = z.enum(['local', 'testnet', 'mainnet']);
export type DeploymentEnvironment = z.infer<typeof deploymentEnvironmentSchema>;

const common = {
  schema: z.literal(REGISTRY_DEPLOYMENT_SCHEMA),
  environment: deploymentEnvironmentSchema,
  network: z.string().regex(/^[a-z0-9-]{1,40}$/),
  contract: z.literal(REGISTRY_CONTRACT_NAME),
  /** The build that was, or is to be, deployed. The constructor takes no arguments. */
  build: z.strictObject({
    solc: z.string().regex(/^\d+\.\d+\.\d+\+commit\.[0-9a-f]{8}$/),
    evmVersion: z.string().regex(/^[a-z]+$/),
    creationCodeKeccak256: digestSchema,
  }),
};

const notDeployed = z.strictObject({
  ...common,
  status: z.literal('not_deployed'),
  /** The chain a later deployment is meant for. An intention, not an observation. */
  intendedChainId: chainIdSchema,
});

const deployed = z.strictObject({
  ...common,
  status: z.literal('deployed'),
  // Observed from the chain after a deployment that actually happened.
  chainId: chainIdSchema,
  registryAddress: nonZeroAddressSchema,
  transactionHash: digestSchema,
  blockNumber: uint256DecimalSchema,
  runtimeCodeKeccak256: digestSchema,
  /** Observed genesis block hash of the chain, pinned at the first deployment. */
  genesisHash: digestSchema.optional(),
});

const PUBLIC_CHAIN_BY_ENVIRONMENT: Readonly<Record<string, string>> = {
  testnet: MONAD_TESTNET_CHAIN_ID,
  mainnet: MONAD_MAINNET_CHAIN_ID,
};

/**
 * A registry deployment record. Observed values (chain ID, address, transaction hash, block,
 * runtime-code hash) exist only on a `deployed` record; a `not_deployed` record has no field
 * for them, so they can be neither invented nor zero-filled. A record labelled testnet or
 * mainnet must carry that network's chain ID, and a local record must not.
 */
export const registryDeploymentSchema = z
  .discriminatedUnion('status', [notDeployed, deployed])
  .refine(
    (record) => {
      const chainId = record.status === 'deployed' ? record.chainId : record.intendedChainId;
      const required = PUBLIC_CHAIN_BY_ENVIRONMENT[record.environment];
      return required === undefined
        ? !Object.values(PUBLIC_CHAIN_BY_ENVIRONMENT).includes(chainId)
        : chainId === required;
    },
    { message: 'environment does not match the chain ID' },
  );
export type RegistryDeployment = z.infer<typeof registryDeploymentSchema>;
