import {
  fetchAgentCard,
  resolveAgentIdentity,
  extractAgentIdentity,
  type AgentCardObservationV1,
  type AgentIdentityRef,
  type AgentIdentityPolicy,
  type AgentIdentityResolutionV1,
  type CardTransport,
} from '@lexaegis/sdk/agent-identity';
import type { FetchLike } from '@lexaegis/sdk/verify';
import { readBoundedFile } from './files';
import { MAX_SMALL_FILE_BYTES, type ResolvedRpc } from './config';
import { KNOWN_DEPLOYMENTS } from './known-deployments.generated';

/*
 * Optional agent-identity sidecar. It never changes the core result or its exit code: a missing
 * reference, an unsupported network, a notFound answer or a card failure are explicit, non-fatal
 * sidecar results. The reference is read only from the agent-configuration artifact's bytes after
 * the core integrity check matched; the registry policy and endpoint are the CALLER's.
 */

export const IDENTITY_ENVELOPE_SCHEMA = 'lexaegis.cli-result-agent-identity.v1';

export type SidecarStatus =
  | 'not_evaluated'
  | 'not_included'
  | 'malformed'
  | 'unsupported_version'
  | 'unavailable'
  | 'resolved';

export interface SidecarResult {
  readonly status: SidecarStatus;
  readonly reason: string | null;
  readonly reference: AgentIdentityRef | null;
  /** Current registry observation. Distinct from the captured reference and from the receipt's not_found. */
  readonly resolution: AgentIdentityResolutionV1 | null;
  /** Remote self-declarations, present only when --fetch-agent-card was given and succeeded or failed. */
  readonly card: AgentCardObservationV1 | null;
}

const result = (
  status: SidecarStatus,
  reason: string | null,
  parts: Partial<Pick<SidecarResult, 'reference' | 'resolution' | 'card'>> = {},
): SidecarResult => ({ status, reason, reference: null, resolution: null, card: null, ...parts });

/** The documented testnet Identity Registry, with the genesis pin from the verified deployment record. */
function builtInPolicy(): AgentIdentityPolicy | null {
  const known = KNOWN_DEPLOYMENTS[0]?.policy as
    { chainId?: string; genesisHash?: string } | undefined;
  if (known?.chainId !== '10143' || typeof known.genesisHash !== 'string') return null;
  return {
    id: 'lexaegis.monad-testnet.erc8004',
    chainId: '10143',
    genesisHash: known.genesisHash,
    identityRegistry: '0x8004a818bfb912233c491871b3d84c89a494bd9e',
    executionDelayBlocks: 3,
  };
}

async function loadPolicy(
  path: string | undefined,
  reference: AgentIdentityRef,
): Promise<AgentIdentityPolicy | 'invalid' | null> {
  if (path !== undefined) {
    const file = await readBoundedFile(path, MAX_SMALL_FILE_BYTES);
    if (!file.ok) return 'invalid';
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(file.bytes),
      ) as AgentIdentityPolicy;
    } catch {
      return 'invalid';
    }
  }
  const builtin = builtInPolicy();
  return builtin !== null &&
    builtin.chainId === reference.chainId &&
    builtin.identityRegistry === reference.identityRegistry
    ? builtin
    : null;
}

export interface SidecarInput {
  /** The agent-configuration artifacts of the package, exact bytes, in manifest order. */
  readonly agentConfigs: readonly Uint8Array[];
  /** True only when the core manifest and every artifact matched. */
  readonly coreIntact: boolean;
  readonly rpc: ResolvedRpc | null;
  readonly allowLoopbackHttp: boolean;
  readonly policyPath: string | undefined;
  readonly fetchCard: boolean;
  readonly cardOrigins: readonly string[];
  readonly cardTransport: CardTransport | null;
  readonly signal: AbortSignal;
  readonly fetch?: FetchLike;
}

export async function runIdentitySidecar(input: SidecarInput): Promise<SidecarResult> {
  if (!input.coreIntact) return result('not_evaluated', 'CORE_INTEGRITY_NOT_ESTABLISHED');
  let found: AgentIdentityRef | null = null;
  let sawMalformed = false;
  let sawUnsupported = false;
  for (const bytes of input.agentConfigs) {
    const extraction = extractAgentIdentity(bytes);
    if (extraction.status === 'included') {
      found = extraction.reference;
      break;
    }
    sawMalformed ||= extraction.status === 'malformed';
    sawUnsupported ||= extraction.status === 'unsupported_version';
  }
  if (found === null) {
    if (sawMalformed) return result('malformed', 'AGENT_CONFIG_IDENTITY_MALFORMED');
    if (sawUnsupported) return result('unsupported_version', 'AGENT_CONFIG_VERSION_UNSUPPORTED');
    return result(
      'not_included',
      input.agentConfigs.length === 0 ? 'NO_AGENT_CONFIG_ARTIFACT' : 'NO_IDENTITY_REFERENCE',
    );
  }
  if (input.rpc === null) return result('unavailable', 'RPC_NOT_CONFIGURED', { reference: found });
  const policy = await loadPolicy(input.policyPath, found);
  if (policy === 'invalid')
    return result('unavailable', 'AGENT_POLICY_INVALID', { reference: found });
  if (policy === null)
    return result('unavailable', 'NETWORK_UNSUPPORTED_NO_POLICY', { reference: found });

  const resolution = await resolveAgentIdentity({
    reference: found,
    policy,
    transport: {
      kind: 'rpc',
      url: input.rpc.url,
      ...(input.fetch !== undefined && { fetch: input.fetch }),
      ...(input.allowLoopbackHttp && { allowLoopbackHttp: true }),
    },
    signal: input.signal,
  });
  let card: AgentCardObservationV1 | null = null;
  if (input.fetchCard) {
    card = await fetchAgentCard({
      optIn: true,
      resolution,
      allowedOrigins: input.cardOrigins,
      transport: input.cardTransport,
      signal: input.signal,
    });
  }
  return result('resolved', resolution.reason, { reference: found, resolution, card });
}
