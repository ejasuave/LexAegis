import 'server-only';
import { AGENT_IDENTITY_CHAIN_ID } from '@lexaegis/protocol';
import { buildRegistrationFile, type RegistrationFile } from '@lexaegis/sdk/agent-identity';

/** The Identity Registry the registration targets: the documented Monad testnet deployment. */
export const TESTNET_IDENTITY_REGISTRY = '0x8004a818bfb912233c491871b3d84c89a494bd9e';

type Env = Readonly<Record<string, string | undefined>>;

export type CardOutcome =
  | { readonly status: 200; readonly card: RegistrationFile }
  | {
      readonly status: 404;
      readonly reason: 'DISABLED' | 'NO_PUBLIC_ORIGIN' | 'UNSUPPORTED_AGENT_ID';
    };

/** A card is only served from a real public https origin: localhost is not a published card. */
export function publicOrigin(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? '');
    const ipLiteral = /^[0-9.]+$/.test(url.hostname) || url.hostname.includes(':');
    return url.protocol === 'https:' &&
      url.hostname.includes('.') &&
      !ipLiteral &&
      url.username === ''
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/**
 * Builds the card from operator configuration. The registration tuple appears only when the
 * operator has recorded a confirmed agent ID (AGENT_IDENTITY_AGENT_ID); it is never predicted. An
 * ID a JSON number cannot hold exactly makes the card unavailable rather than rounded.
 */
export function agentCardOutcome(env: Env, enabled: boolean): CardOutcome {
  if (!enabled) return { status: 404, reason: 'DISABLED' };
  const origin = publicOrigin(env.NEXT_PUBLIC_APP_ORIGIN);
  if (origin === null) return { status: 404, reason: 'NO_PUBLIC_ORIGIN' };
  const raw = env.AGENT_IDENTITY_AGENT_ID;
  if (raw === undefined || raw === '')
    return { status: 200, card: buildRegistrationFile({ origin }) };
  const agentId = /^(?:0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(agentId)) return { status: 404, reason: 'UNSUPPORTED_AGENT_ID' };
  return {
    status: 200,
    card: buildRegistrationFile({
      origin,
      registration: {
        agentId,
        chainId: AGENT_IDENTITY_CHAIN_ID,
        identityRegistry: TESTNET_IDENTITY_REGISTRY,
      },
    }),
  };
}
