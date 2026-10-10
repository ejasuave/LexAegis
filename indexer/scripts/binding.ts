import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/*
 * Deployment binding for the indexer. Built only from the Chapter 6 deployment record and the
 * generated registry ABI. It has no credentials and performs no network access.
 */

export const PROJECTION_VERSION = 'lexaegis.history-projection.v1';
export const HYPERSYNC_URL_MONAD_TESTNET = 'https://10143.hypersync.xyz';
export const MAX_REORG_DEPTH = 200;
export const INDEXED_EVENTS = [
  'ReceiptIssued',
  'ReceiptRevoked',
  'ReceiptSuperseded',
  'NonceInvalidated',
] as const;

const here = dirname(fileURLToPath(import.meta.url));
export const indexerRoot = resolve(here, '..');
export const repoRoot = resolve(indexerRoot, '..');

const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const digest = z.string().regex(/^0x[0-9a-f]{64}$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);

/** A deployed record, or a local test record. Anything else cannot bind live ingestion. */
export const bindingInputSchema = z.strictObject({
  mode: z.enum(['hypersync', 'local-rpc']),
  chainId: decimal,
  registryAddress: address,
  startBlock: decimal,
  genesisHash: digest,
  runtimeCodeKeccak256: digest,
  deploymentTransactionHash: digest,
  rpcUrl: z.string().optional(),
});
export type BindingInput = z.infer<typeof bindingInputSchema>;

const deploymentFileSchema = z.looseObject({
  status: z.literal('deployed'),
  environment: z.literal('testnet'),
  chainId: z.literal('10143'),
  registryAddress: address,
  transactionHash: digest,
  blockNumber: decimal,
  runtimeCodeKeccak256: digest,
  genesisHash: digest,
});

export interface AbiEntry {
  readonly type: string;
  readonly name?: string;
}

/** Stable JSON: keys sorted, no whitespace. Used only to fingerprint public configuration. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : 1,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256Hex = (text: string): string =>
  `0x${createHash('sha256').update(text).digest('hex')}`;

export function loadTestnetBinding(): BindingInput {
  const raw: unknown = JSON.parse(
    readFileSync(resolve(repoRoot, 'contracts/deployments/monad-testnet.json'), 'utf8'),
  );
  const parsed = deploymentFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('DEPLOYMENT_RECORD_INVALID: no verified testnet deployment record');
  }
  const d = parsed.data;
  return {
    mode: 'hypersync',
    chainId: d.chainId,
    registryAddress: d.registryAddress,
    startBlock: d.blockNumber,
    genesisHash: d.genesisHash,
    runtimeCodeKeccak256: d.runtimeCodeKeccak256,
    deploymentTransactionHash: d.transactionHash,
  };
}

export function validateBinding(input: BindingInput): BindingInput {
  const b = bindingInputSchema.parse(input);
  if (b.chainId === '143') throw new Error('MAINNET_REFUSED: chain 143 is not indexed');
  if (b.mode === 'hypersync' && b.chainId !== '10143') {
    throw new Error('SOURCE_NETWORK_MISMATCH: HyperSync source is Monad Testnet 10143 only');
  }
  if (b.mode === 'local-rpc') {
    if (b.chainId === '10143') {
      throw new Error('SOURCE_NETWORK_MISMATCH: a loopback source cannot claim chain 10143');
    }
    const url = new URL(b.rpcUrl ?? '');
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('LOCAL_SOURCE_NOT_LOOPBACK');
    }
    if (url.username || url.password) throw new Error('LOCAL_SOURCE_HAS_CREDENTIALS');
  }
  if (BigInt(b.startBlock) <= 0n && b.mode === 'hypersync') {
    throw new Error('START_BLOCK_INVALID: must be the deployment block');
  }
  return b;
}

export function eventAbi(abi: readonly AbiEntry[]): readonly AbiEntry[] {
  const wanted = new Set<string>(INDEXED_EVENTS);
  return abi.filter((e) => e.type === 'event' && e.name !== undefined && wanted.has(e.name));
}

export interface PublicBinding {
  readonly projectionVersion: string;
  readonly mode: BindingInput['mode'];
  readonly chainId: string;
  readonly genesisHash: string;
  readonly registryAddress: string;
  readonly startBlock: string;
  readonly runtimeCodeKeccak256: string;
  readonly deploymentTransactionHash: string;
  readonly abiSha256: string;
  readonly maxReorgDepth: number;
  readonly configFingerprint: string;
}

export function publicBinding(input: BindingInput, abi: readonly AbiEntry[]): PublicBinding {
  const b = validateBinding(input);
  const abiSha256 = sha256Hex(canonicalJson(eventAbi(abi)));
  const body = {
    projectionVersion: PROJECTION_VERSION,
    mode: b.mode,
    chainId: b.chainId,
    genesisHash: b.genesisHash,
    registryAddress: b.registryAddress,
    startBlock: b.startBlock,
    runtimeCodeKeccak256: b.runtimeCodeKeccak256,
    deploymentTransactionHash: b.deploymentTransactionHash,
    abiSha256,
    maxReorgDepth: MAX_REORG_DEPTH,
  };
  return { ...body, configFingerprint: sha256Hex(canonicalJson(body)) };
}

export function renderConfigYaml(b: BindingInput): string {
  const source =
    b.mode === 'hypersync'
      ? `    hypersync_config:\n      url: ${HYPERSYNC_URL_MONAD_TESTNET}\n`
      : `    rpc:\n      - url: ${b.rpcUrl ?? ''}\n        for: sync\n`;
  const events = INDEXED_EVENTS.map((e) => `      - event: ${e}`).join('\n');
  return `# GENERATED by indexer/scripts/generate-config.ts from contracts/deployments. Do not edit.
name: lexaegis-history
description: Read-only projection of ProofOfReviewRegistry lifecycle events.
ecosystem: evm
schema: ./schema.graphql
handlers: src/handlers
address_format: lowercase
rollback_on_reorg: true
save_full_history: false
field_selection:
  transaction_fields:
    - hash
    - from
contracts:
  - name: ProofOfReviewRegistry
    abi_file_path: ./abi/ProofOfReviewRegistry.json
    events:
${events}
chains:
  - id: ${b.chainId}
    start_block: ${b.startBlock}
    max_reorg_depth: ${MAX_REORG_DEPTH}
${source}    contracts:
      - name: ProofOfReviewRegistry
        address: ${b.registryAddress}
`;
}

export function renderBindingModule(p: PublicBinding): string {
  return `// GENERATED by indexer/scripts/generate-config.ts. Do not edit. Public values only.
export const BINDING = ${JSON.stringify(p, null, 2)} as const;
`;
}
