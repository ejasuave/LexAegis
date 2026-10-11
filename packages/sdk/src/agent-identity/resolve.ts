import {
  decodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toFunctionSelector,
  type Hex,
} from 'viem';
import { z } from 'zod';
import { agentIdentityRefSchema, type AgentIdentityRef } from '@lexaegis/protocol';
import { digestSchema, chainIdSchema, nonZeroAddressSchema } from '@lexaegis/protocol/v1';
import { BudgetError, LiveBudget } from '../registry/budget';
import { MONAD_EXECUTION_DELAY_BLOCKS } from '../registry/live-reader';
import { createAgentIdentityRpcClient, type AgentIdentityChainClient } from './rpc';
import type { FetchLike } from '../registry/rpc-client';

/*
 * Read-only resolution of an ERC-8004 agent reference against a registry the CALLER trusts. It
 * answers one narrow question: does the Identity Registry, at a verified checkpoint, hold this
 * agent, and what owner and URI does it show now. It never signs, connects an account, writes
 * reputation, discovers an endpoint or fetches a card. A result is an observation, not a
 * certificate of authorship, quality, human identity or qualification, and it can never alter a
 * receipt verification result.
 */

export const AGENT_IDENTITY_RESOLUTION_SCHEMA = 'lexaegis.agent-identity-resolution.v1';

/** Resolution is bounded: 15 seconds, 12 attempts (one transient retry per read inside that total). */
export const RESOLUTION_LIMITS = Object.freeze({
  totalMs: 15_000,
  maxAttempts: 12,
  perReadMs: 5_000,
});

/** The trusted deployment. A package, a card or an RPC response can never supply or change it. */
export const agentIdentityPolicySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  chainId: chainIdSchema,
  /** Block 0 hash of the configured chain. */
  genesisHash: digestSchema,
  identityRegistry: nonZeroAddressSchema,
  /** Optional pin of the proxy's runtime code. When set, any other code is unavailable. */
  proxyCodeKeccak256: digestSchema.optional(),
  executionDelayBlocks: z.number().int().min(0).max(64).default(MONAD_EXECUTION_DELAY_BLOCKS),
});
export type AgentIdentityPolicy = z.infer<typeof agentIdentityPolicySchema>;

export const RESOLUTION_REASONS = [
  'REGISTERED',
  'AGENT_NOT_FOUND',
  'REFERENCE_INVALID',
  'POLICY_INVALID',
  'NETWORK_NOT_CONFIGURED',
  'RPC_UNAVAILABLE',
  'WRONG_CHAIN',
  'GENESIS_MISMATCH',
  'FINALIZED_UNAVAILABLE',
  'REGISTRY_CODE_MISSING',
  'REGISTRY_CODE_MISMATCH',
  'ABI_UNSUPPORTED',
  'BLOCK_CHANGED',
  'RESPONSE_INVALID',
  'ABORTED',
  'BUDGET_EXHAUSTED',
] as const;
export type ResolutionReason = (typeof RESOLUTION_REASONS)[number];

export const uriObservationSchema = z.strictObject({
  captured: z.string(),
  current: z.string(),
  /** The captured reference's URI equals today's on-chain URI. A change is not tampering. */
  changed: z.boolean(),
  /** `https` URIs are the only transport a card can be fetched from. */
  transport: z.enum(['https', 'unsupported']),
});

export const agentIdentityResolutionSchema = z.strictObject({
  schema: z.literal(AGENT_IDENTITY_RESOLUTION_SCHEMA),
  status: z.enum(['registered', 'notFound', 'unavailable']),
  reason: z.enum(RESOLUTION_REASONS),
  /** The public identity tuple that was asked about. */
  reference: agentIdentityRefSchema.nullable(),
  /** Tags the result with the caller's generation so a stale answer can be discarded. */
  generation: z.number().int().min(0),
  checkpoint: z
    .strictObject({
      chainId: chainIdSchema,
      blockNumber: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
      blockHash: digestSchema,
    })
    .nullable(),
  observedAt: z.iso.datetime(),
  registry: z
    .strictObject({
      codeKeccak256: digestSchema,
      implementation: z
        .strictObject({ address: nonZeroAddressSchema, codeKeccak256: digestSchema.nullable() })
        .nullable(),
      version: z.string().max(40).nullable(),
    })
    .nullable(),
  agent: z.strictObject({ owner: nonZeroAddressSchema, uri: uriObservationSchema }).nullable(),
});
export type AgentIdentityResolutionV1 = z.infer<typeof agentIdentityResolutionSchema>;

const abi = parseAbi([
  'function getVersion() pure returns (string)',
  'function supportsInterface(bytes4) view returns (bool)',
  'function ownerOf(uint256) view returns (address)',
  'function tokenURI(uint256) view returns (string)',
]);
const NONEXISTENT_TOKEN = toFunctionSelector('ERC721NonexistentToken(uint256)');
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const MAX_URI_LENGTH = 2048;

export type AgentIdentityTransport =
  | {
      readonly kind: 'rpc';
      /** HTTPS endpoint chosen by the caller. Never taken from a package or a card. */
      readonly url: string;
      readonly fetch?: FetchLike;
      /** Test-only: permits http://127.0.0.1 for an isolated local chain. */
      readonly allowLoopbackHttp?: boolean;
    }
  | { readonly kind: 'client'; readonly client: AgentIdentityChainClient };

export interface ResolveInput {
  /** A validated reference. A missing optional reference is not a lookup: callers do not call this. */
  readonly reference: unknown;
  readonly policy: unknown;
  readonly transport: AgentIdentityTransport;
  readonly signal?: AbortSignal;
  readonly generation?: number;
  readonly now?: () => Date;
}

class Stop extends Error {
  constructor(readonly reason: ResolutionReason) {
    super(reason);
  }
}

const transportOf = (uri: string): 'https' | 'unsupported' =>
  /^https:\/\//i.test(uri) ? 'https' : 'unsupported';

/**
 * Resolves an agent reference at one coherent checkpoint (finalized minus the execution delay) of
 * the configured testnet. `notFound` means the registry's own known nonexistent-token answer;
 * missing code, an unsupported ABI, any other revert and every RPC failure are `unavailable`,
 * never `notFound`.
 *
 * @example
 * ```ts
 * import { resolveAgentIdentity } from '@lexaegis/sdk/agent-identity';
 *
 * declare const reference: unknown; // from the verified agent-configuration artifact
 * declare const policy: unknown; // the ERC-8004 deployment YOU trust
 * const result = await resolveAgentIdentity({
 *   reference,
 *   policy,
 *   transport: { kind: 'rpc', url: 'https://rpc.example.invalid/' },
 * });
 * console.log(result.status, result.reason); // "registered" | "notFound" | "unavailable"
 * ```
 */
export async function resolveAgentIdentity(
  input: ResolveInput,
): Promise<AgentIdentityResolutionV1> {
  const generation = input.generation ?? 0;
  const observedAt = (input.now ?? (() => new Date()))().toISOString();
  const result = (
    status: AgentIdentityResolutionV1['status'],
    reason: ResolutionReason,
    parts: Partial<
      Pick<AgentIdentityResolutionV1, 'reference' | 'checkpoint' | 'registry' | 'agent'>
    > = {},
  ): AgentIdentityResolutionV1 => ({
    schema: AGENT_IDENTITY_RESOLUTION_SCHEMA,
    status,
    reason,
    reference: null,
    generation,
    checkpoint: null,
    observedAt,
    registry: null,
    agent: null,
    ...parts,
  });

  if (input.signal?.aborted === true) return result('unavailable', 'ABORTED');
  const reference = agentIdentityRefSchema.safeParse(input.reference);
  if (!reference.success) return result('unavailable', 'REFERENCE_INVALID');
  const policy = agentIdentityPolicySchema.safeParse(input.policy);
  if (!policy.success)
    return result('unavailable', 'POLICY_INVALID', { reference: reference.data });
  const ref: AgentIdentityRef = reference.data;
  const trusted = policy.data;
  // Identity is resolved on the configured network only: a reference for another chain or registry
  // is not looked up elsewhere, and a mainnet success could never stand in for it.
  if (ref.chainId !== trusted.chainId || ref.identityRegistry !== trusted.identityRegistry) {
    return result('unavailable', 'NETWORK_NOT_CONFIGURED', { reference: ref });
  }

  const budget = new LiveBudget(
    {
      totalMs: RESOLUTION_LIMITS.totalMs,
      maxAttempts: RESOLUTION_LIMITS.maxAttempts,
      perReadMs: RESOLUTION_LIMITS.perReadMs,
    },
    input.signal,
  );
  try {
    const client =
      input.transport.kind === 'rpc'
        ? createAgentIdentityRpcClient({
            url: input.transport.url,
            budget,
            ...(input.transport.fetch !== undefined && { fetch: input.transport.fetch }),
            ...(input.transport.allowLoopbackHttp === true && { allowLoopbackHttp: true }),
          })
        : input.transport.client;

    if (String(await client.getChainId()) !== trusted.chainId) {
      return result('unavailable', 'WRONG_CHAIN', { reference: ref });
    }
    const genesis = await client.getBlock({ blockNumber: 0n });
    if (genesis === null || genesis.hash.toLowerCase() !== trusted.genesisHash) {
      return result('unavailable', 'GENESIS_MISMATCH', { reference: ref });
    }
    const finalized = await client.getBlock({ blockTag: 'finalized' });
    if (finalized === null)
      return result('unavailable', 'FINALIZED_UNAVAILABLE', { reference: ref });
    const selected = finalized.number - BigInt(trusted.executionDelayBlocks);
    if (selected < 0n) return result('unavailable', 'FINALIZED_UNAVAILABLE', { reference: ref });
    const block = await client.getBlock({ blockNumber: selected });
    if (block === null || block.number !== selected) {
      return result('unavailable', 'RESPONSE_INVALID', { reference: ref });
    }
    const checkpoint = {
      chainId: trusted.chainId,
      blockNumber: selected.toString(),
      blockHash: block.hash.toLowerCase(),
    };
    const failed = (
      reason: ResolutionReason,
      registry: AgentIdentityResolutionV1['registry'] = null,
    ) => result('unavailable', reason, { reference: ref, checkpoint, registry });

    const address = trusted.identityRegistry as Hex;
    const code = await client.getCode({ address, blockNumber: selected });
    if (code === undefined || code === '0x') return failed('REGISTRY_CODE_MISSING');
    const codeHash = keccak256(code);
    if (trusted.proxyCodeKeccak256 !== undefined && codeHash !== trusted.proxyCodeKeccak256) {
      return failed('REGISTRY_CODE_MISMATCH');
    }
    // Proxy and version observations, recorded but never used alone to certify behaviour.
    const slot = await client.getStorageAt({
      address,
      slot: IMPLEMENTATION_SLOT,
      blockNumber: selected,
    });
    const implementationAddress = slot === undefined ? null : `0x${slot.slice(26)}`;
    let implementation: NonNullable<AgentIdentityResolutionV1['registry']>['implementation'] = null;
    if (implementationAddress !== null && !/^0x0{40}$/.test(implementationAddress)) {
      const implementationCode = await client.getCode({
        address: implementationAddress as Hex,
        blockNumber: selected,
      });
      implementation = {
        address: implementationAddress,
        codeKeccak256:
          implementationCode === undefined || implementationCode === '0x'
            ? null
            : keccak256(implementationCode),
      };
    }
    const versionRead = await client.read({
      to: address,
      data: encodeFunctionData({ abi, functionName: 'getVersion' }),
      blockNumber: selected,
    });
    if (versionRead.kind === 'revert') return failed('ABI_UNSUPPORTED');
    let version: string;
    try {
      [version] = decodeAbiParameters([{ type: 'string' }], versionRead.data);
    } catch {
      return failed('ABI_UNSUPPORTED');
    }
    const registry = { codeKeccak256: codeHash, implementation, version: version.slice(0, 40) };

    const agentId = BigInt(ref.agentId);
    const owner = await client.read({
      to: address,
      data: encodeFunctionData({ abi, functionName: 'ownerOf', args: [agentId] }),
      blockNumber: selected,
    });
    if (owner.kind === 'revert') {
      // Only the implementation's own nonexistent-token answer is "not found".
      return owner.data !== null && owner.data.toLowerCase().startsWith(NONEXISTENT_TOKEN)
        ? result('notFound', 'AGENT_NOT_FOUND', { reference: ref, checkpoint, registry })
        : failed('ABI_UNSUPPORTED', registry);
    }
    let ownerAddress: string;
    let uri: string;
    try {
      [ownerAddress] = decodeAbiParameters([{ type: 'address' }], owner.data);
      const uriRead = await client.read({
        to: address,
        data: encodeFunctionData({ abi, functionName: 'tokenURI', args: [agentId] }),
        blockNumber: selected,
      });
      if (uriRead.kind === 'revert') return failed('ABI_UNSUPPORTED', registry);
      [uri] = decodeAbiParameters([{ type: 'string' }], uriRead.data);
    } catch {
      return failed('RESPONSE_INVALID', registry);
    }
    if (/^0x0{40}$/.test(ownerAddress.toLowerCase()) || uri.length > MAX_URI_LENGTH) {
      return failed('RESPONSE_INVALID', registry);
    }
    // One coherent checkpoint: the block must be unchanged after the reads.
    const after = await client.getBlock({ blockNumber: selected });
    if (after === null || after.hash.toLowerCase() !== checkpoint.blockHash)
      return failed('BLOCK_CHANGED', registry);

    return result('registered', 'REGISTERED', {
      reference: ref,
      checkpoint,
      registry,
      agent: {
        owner: ownerAddress.toLowerCase(),
        uri: {
          captured: ref.cardUri,
          current: uri,
          changed: uri !== ref.cardUri,
          transport: transportOf(uri),
        },
      },
    });
  } catch (error) {
    if (error instanceof BudgetError) {
      return result('unavailable', error.failure === 'ABORTED' ? 'ABORTED' : 'BUDGET_EXHAUSTED', {
        reference: ref,
      });
    }
    if (error instanceof Stop) return result('unavailable', error.reason, { reference: ref });
    return result('unavailable', 'RPC_UNAVAILABLE', { reference: ref });
  } finally {
    budget.dispose();
  }
}
