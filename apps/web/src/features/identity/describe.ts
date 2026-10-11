import { z } from 'zod';
import { agentIdentityResolutionSchema } from '@lexaegis/sdk/agent-identity';

/*
 * What the assistant identity line may say. It describes the CURRENT assistant configuration, never
 * the identity recorded with a particular review, and a registry record is never described as
 * verification, a licence, authorship, correctness or qualification.
 */

export const identityPayloadSchema = z.union([
  z.strictObject({ configured: z.literal(false), reason: z.string().max(60) }),
  z.strictObject({ configured: z.literal(true), resolution: agentIdentityResolutionSchema }),
]);
export type IdentityPayload = z.infer<typeof identityPayloadSchema>;

export type IdentityView =
  | {
      readonly kind: 'registered';
      readonly agentId: string;
      readonly registry: string;
      readonly network: string;
      readonly blockNumber: string;
      readonly observedAt: string;
      readonly owner: string;
      /** A card link only when the on-chain URI is a plain public https URL; otherwise null. */
      readonly cardLink: string | null;
      readonly uriChanged: boolean;
    }
  | {
      readonly kind: 'not_registered';
      readonly reason:
        | 'NO_REGISTRATION_CONFIGURED'
        | 'NO_PUBLIC_CARD'
        | 'UNSUPPORTED_AGENT_ID'
        | 'AGENT_NOT_FOUND';
    }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly reason: string };

/** Reasons that mean a required target is demonstrably not usable here, as opposed to "could not check". */
const DEPENDENCY_REASONS: ReadonlySet<string> = new Set([
  'REGISTRY_CODE_MISSING',
  'REGISTRY_CODE_MISMATCH',
  'ABI_UNSUPPORTED',
  'NETWORK_NOT_CONFIGURED',
  'GENESIS_MISMATCH',
  'WRONG_CHAIN',
]);

function isPlainHttps(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hostname.includes('.')
    );
  } catch {
    return false;
  }
}

export function toView(payload: IdentityPayload): IdentityView {
  if (!payload.configured) {
    const reason = payload.reason;
    return {
      kind: 'not_registered',
      reason:
        reason === 'NO_PUBLIC_CARD' || reason === 'UNSUPPORTED_AGENT_ID'
          ? reason
          : 'NO_REGISTRATION_CONFIGURED',
    };
  }
  const { resolution } = payload;
  if (
    resolution.status === 'registered' &&
    resolution.agent !== null &&
    resolution.reference !== null &&
    resolution.checkpoint !== null
  ) {
    const uri = resolution.agent.uri.current;
    return {
      kind: 'registered',
      agentId: resolution.reference.agentId,
      registry: resolution.reference.identityRegistry,
      network: `Monad testnet (${resolution.checkpoint.chainId})`,
      blockNumber: resolution.checkpoint.blockNumber,
      observedAt: resolution.observedAt,
      owner: resolution.agent.owner,
      cardLink: isPlainHttps(uri) ? uri : null,
      uriChanged: resolution.agent.uri.changed,
    };
  }
  if (resolution.status === 'notFound')
    return { kind: 'not_registered', reason: 'AGENT_NOT_FOUND' };
  return DEPENDENCY_REASONS.has(resolution.reason)
    ? { kind: 'unavailable', reason: resolution.reason }
    : { kind: 'unknown', reason: resolution.reason };
}

export interface IdentityText {
  readonly headline: string;
  readonly detail: string;
}

/** Plain, non-overclaiming wording. Registered means a current registry record was observed. */
export function describeView(view: IdentityView | 'checking' | 'idle'): IdentityText {
  if (view === 'idle')
    return {
      headline: 'Agent identity not checked',
      detail: 'Choose Check to read the registry once.',
    };
  if (view === 'checking')
    return {
      headline: 'Checking agent identity…',
      detail: 'Reading the registry. Nothing is assumed.',
    };
  switch (view.kind) {
    case 'registered':
      return {
        headline: `Registered: agent ${view.agentId}`,
        detail: `Identity Registry ${view.registry} on ${view.network}, read at block ${view.blockNumber} (${view.observedAt}). A current registry record exists; it is not a verification of the assistant, its advice or anyone's qualification.${view.uriChanged ? ' The registered card address differs from the one configured.' : ''}`,
      };
    case 'not_registered':
      return {
        headline: 'Not registered',
        detail:
          view.reason === 'AGENT_NOT_FOUND'
            ? 'The registry reports no such agent.'
            : 'No agent registration is configured for this assistant.',
      };
    case 'unavailable':
      return {
        headline: 'Agent identity unavailable on this network',
        detail: `A required registry is not usable here (${view.reason}).`,
      };
    case 'unknown':
      return {
        headline: 'Unable to check agent identity',
        detail: `The check could not finish (${view.reason}). This does not mean the agent is unregistered.`,
      };
  }
}
