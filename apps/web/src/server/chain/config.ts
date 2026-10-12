import { z } from 'zod';
import { chainIdSchema, digestSchema, nonZeroAddressSchema } from '@lexaegis/protocol/v1';
import {
  MONAD_EXECUTION_DELAY_BLOCKS,
  MONAD_EXECUTION_DELAY_REVISION,
  MONAD_TESTNET_CHAIN_ID,
  chainPolicySchema,
  registryDeploymentSchema,
  uint256DecimalSchema,
  type ChainPolicy,
  type RegistryDeployment,
} from '@lexaegis/sdk/registry';
import {
  DEFAULT_MAX_FUNDING_FEE_WEI,
  DEFAULT_MAX_REGISTRY_FEE_WEI,
  parseMon,
} from '@lexaegis/sdk/transactions';
import { readFileSync } from 'node:fs';
import deploymentFile from '../../../../../contracts/deployments/monad-testnet.json';
import type { ServerConfig } from '../env';

/*
 * Monad Testnet only. Mainnet (143) and every other public chain are refused in the deployment,
 * funding and mutation paths of this chapter. Facts were rechecked against docs.monad.xyz on
 * 2026-10-09: chain 10143, MON with 18 decimals, execution delay k = 3 blocks (reserve-balance
 * page), gas charged on the gas limit, network revision MONAD_TEN.
 */

export const CHAIN = Object.freeze({
  id: MONAD_TESTNET_CHAIN_ID,
  name: 'Monad Testnet',
  currency: 'MON',
  decimals: 18,
  faucetUrl: 'https://faucet.monad.xyz',
  explorerUrl: 'https://testnet.monadvision.com',
  networkRevision: 'MONAD_TEN',
});

export const EXECUTION_DELAY_REVISION = `${MONAD_EXECUTION_DELAY_REVISION}; testnet MONAD_TEN v0.16.2`;

const LOCAL_ANVIL_CHAIN_ID = '31337';
let localChainForTests = false;

/**
 * Test seam for an isolated loopback Anvil chain (31337). Only automated tests call it, and
 * production routes resolve their chain from the committed testnet artifact, which can only be
 * Monad Testnet. Mainnet (143) and every other public chain stay refused either way.
 */
export function allowLocalAnvilChainForTests(allowed: boolean): void {
  localChainForTests = allowed;
}

export function isAllowedMutationChain(chainId: string): boolean {
  return (
    chainId === MONAD_TESTNET_CHAIN_ID || (localChainForTests && chainId === LOCAL_ANVIL_CHAIN_ID)
  );
}

/**
 * Test-only seam for the Chapter 12 browser journey: a throwaway loopback Anvil chain, run under chain
 * ID 10143, with a locally generated deployment record. It is active ONLY when the test chain flag, a
 * test mode and a record path are all set; the endpoint must still be loopback (the chain client
 * refuses anything else) and the record must still validate as a testnet record. A deployed
 * environment sets none of these, so production always uses the committed Monad Testnet artifact.
 */
export function localTestChainRequested(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    env.LEXAEGIS_TEST_CHAIN === 'local-anvil' &&
    (env.LEXAEGIS_TEST_MODE ?? '') !== '' &&
    (env.LEXAEGIS_TEST_CHAIN_DEPLOYMENT ?? '') !== ''
  );
}

/** The deployment record in force: the committed artifact, or (tests only) the local record. */
export function activeDeploymentFile(
  env: Readonly<Record<string, string | undefined>> = process.env,
): unknown {
  if (!localTestChainRequested(env)) return deploymentFile;
  try {
    return JSON.parse(
      readFileSync(/*turbopackIgnore: true*/ env.LEXAEGIS_TEST_CHAIN_DEPLOYMENT ?? '', 'utf8'),
    ) as unknown;
  } catch {
    // An unreadable test record is an invalid record, never a fallback to the public artifact.
    return null;
  }
}

/** The committed public deployment artifact, validated. A `not_deployed` record enables nothing. */
export function loadDeployment(file: unknown = activeDeploymentFile()): RegistryDeployment | null {
  const parsed = registryDeploymentSchema.safeParse(file);
  return parsed.success ? parsed.data : null;
}

export type DeploymentReadiness =
  | { readonly state: 'ready'; readonly policy: ChainPolicy; readonly genesisHash: string | null }
  | { readonly state: 'not_deployed' | 'invalid' | 'wrong_chain' };

/** A deployed testnet record becomes a chain policy; nothing else does. */
export function resolveDeployment(file: unknown = activeDeploymentFile()): DeploymentReadiness {
  const record = loadDeployment(file);
  if (record === null) return { state: 'invalid' };
  if (record.status !== 'deployed') return { state: 'not_deployed' };
  if (record.environment !== 'testnet' || !isAllowedMutationChain(record.chainId)) {
    return { state: 'wrong_chain' };
  }
  const policy = chainPolicySchema.safeParse({
    chainId: record.chainId,
    registryAddress: record.registryAddress,
    deploymentBlock: record.blockNumber,
    runtimeCodeKeccak256: record.runtimeCodeKeccak256,
    executionDelayBlocks: MONAD_EXECUTION_DELAY_BLOCKS,
    executionDelayRevision: EXECUTION_DELAY_REVISION,
  });
  return policy.success
    ? { state: 'ready', policy: policy.data, genesisHash: record.genesisHash ?? null }
    : { state: 'invalid' };
}

/** Public subset only: chain, address, deployment block/hash, protocol version, explorer. */
export function publicChainInfo(
  readiness: DeploymentReadiness,
  file: unknown = activeDeploymentFile(),
) {
  const record = loadDeployment(file);
  return {
    chainId: CHAIN.id,
    name: CHAIN.name,
    currency: CHAIN.currency,
    explorerUrl: CHAIN.explorerUrl,
    protocolVersion: '1',
    ...(readiness.state === 'ready' &&
      record?.status === 'deployed' && {
        registryAddress: record.registryAddress,
        deploymentBlock: record.blockNumber,
        deploymentTransactionHash: record.transactionHash,
      }),
  };
}

// ---- Closed application schemas ------------------------------------------------------------------

const hash32 = digestSchema;
const address = nonZeroAddressSchema;
const decimal = uint256DecimalSchema;

export const OPERATION_KINDS = ['execute', 'invalidate_nonce'] as const;
export const operationKindSchema = z.enum(OPERATION_KINDS);

/** Public review action data only. Never an approved flag, opening, label or file name. */
export const actionPreflightSchema = z.strictObject({
  operationId: z.uuid(),
  kind: operationKindSchema,
  chainId: chainIdSchema,
  registryAddress: address,
  account: address,
  /** Registry action nonce (distinct from the EOA transaction nonce). */
  registryNonce: decimal,
  commitment: hash32.nullable(),
  actionDigest: hash32.nullable(),
  lifecycleBefore: z.enum(['not_found', 'active', 'revoked', 'superseded']).nullable(),
  observedBlock: decimal,
  observedAt: z.iso.datetime(),
});
export type ActionPreflight = z.infer<typeof actionPreflightSchema>;

export const transactionQuoteSchema = z.strictObject({
  operationId: z.uuid(),
  account: address,
  chainId: chainIdSchema,
  registryAddress: address,
  calldataHash: hash32,
  actionDigest: hash32.nullable(),
  value: z.literal('0'),
  type: z.literal('eip1559'),
  /** EOA transaction nonce. */
  transactionNonce: decimal,
  gasLimit: decimal,
  maxFeePerGas: decimal,
  maxPriorityFeePerGas: decimal,
  expectedFeeWei: decimal,
  maxFeeWei: decimal,
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type TransactionQuote = z.infer<typeof transactionQuoteSchema>;

export const SUBMISSION_PHASES = [
  'reserved',
  'quoted',
  'submitting',
  'submitted',
  'pending',
  'included',
  'confirmed',
  'reverted',
  'replaced',
  'unknown',
  'cancelled',
] as const;
export const submissionPhaseSchema = z.enum(SUBMISSION_PHASES);
export type SubmissionPhase = z.infer<typeof submissionPhaseSchema>;

export const submissionRecordSchema = z.strictObject({
  operationId: z.uuid(),
  kind: operationKindSchema,
  phase: submissionPhaseSchema,
  chainId: chainIdSchema,
  registryAddress: address,
  account: address,
  commitment: hash32.nullable(),
  registryNonce: decimal,
  transactionNonce: decimal.nullable(),
  transactionHash: hash32.nullable(),
  blockNumber: decimal.nullable(),
  blockHash: hash32.nullable(),
  chargedFeeWei: decimal.nullable(),
  executedViaAnotherTransaction: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type SubmissionRecord = z.infer<typeof submissionRecordSchema>;

export const fundingResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('confirmed'),
    transactionHash: hash32,
    amountWei: decimal,
    balanceWei: decimal,
    chargedFeeWei: decimal,
  }),
  z.strictObject({
    status: z.literal('pending'),
    transactionHash: hash32,
    amountWei: decimal,
  }),
  z.strictObject({
    status: z.enum([
      'unavailable',
      'disabled',
      'already_funded',
      'cooldown',
      'budget_exhausted',
      'funder_low',
      'account_delegated',
      'failed',
      'unknown',
    ]),
    faucetUrl: z.literal(CHAIN.faucetUrl),
    retryAfter: z.iso.datetime().optional(),
  }),
]);
export type FundingResult = z.infer<typeof fundingResultSchema>;

// ---- Bounded settings ---------------------------------------------------------------------------

export interface ChainSettings {
  readonly fundingEnabled: boolean;
  readonly grantWei: bigint;
  readonly dailyBudgetWei: bigint;
  readonly fundingMaxFeeWei: bigint;
  readonly registryMaxFeeWei: bigint;
  readonly cooldownMs: number;
}

export const DEFAULT_GRANT_WEI = 2n * 10n ** 17n;
export const DEFAULT_DAILY_BUDGET_WEI = 10n * 10n ** 18n;

export function resolveSettings(config: ServerConfig): ChainSettings {
  const mon = (value: string | undefined, fallback: bigint) =>
    value === undefined ? fallback : (parseMon(value) ?? fallback);
  return {
    fundingEnabled: config.funding.enabled === 'true',
    grantWei: mon(config.funding.grantMon, DEFAULT_GRANT_WEI),
    dailyBudgetWei: mon(config.funding.dailyBudgetMon, DEFAULT_DAILY_BUDGET_WEI),
    fundingMaxFeeWei: mon(config.funding.maxFeeMon, DEFAULT_MAX_FUNDING_FEE_WEI),
    registryMaxFeeWei: mon(config.registryFee.maxFeeMon, DEFAULT_MAX_REGISTRY_FEE_WEI),
    cooldownMs: 24 * 60 * 60 * 1000,
  };
}
