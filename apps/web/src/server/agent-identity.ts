import 'server-only';
import { AGENT_IDENTITY_CHAIN_ID, type AgentIdentityRef } from '@lexaegis/protocol';
import type { AgentIdentityPolicy } from '@lexaegis/sdk/agent-identity';
import { TESTNET_IDENTITY_REGISTRY, publicOrigin } from './agent-card';

/** Genesis block hash of Monad testnet, pinned from contracts/deployments/monad-testnet.json. */
export const TESTNET_GENESIS_HASH =
  '0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9';

type Env = Readonly<Record<string, string | undefined>>;

export type IdentityConfig =
  | {
      readonly configured: false;
      readonly reason: 'NO_REGISTRATION_CONFIGURED' | 'NO_PUBLIC_CARD' | 'UNSUPPORTED_AGENT_ID';
    }
  | {
      readonly configured: true;
      readonly reference: AgentIdentityRef;
      readonly policy: AgentIdentityPolicy;
      readonly rpcUrl: string;
    };

/**
 * The CURRENT assistant's identity configuration, from operator environment only: nothing a client,
 * a model or a card says reaches it. With no confirmed agent ID the assistant simply has no
 * registration to look up, and no network request is made.
 */
export function loadIdentityConfig(env: Env): IdentityConfig {
  const raw = env.AGENT_IDENTITY_AGENT_ID;
  if (raw === undefined || raw === '')
    return { configured: false, reason: 'NO_REGISTRATION_CONFIGURED' };
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw))
    return { configured: false, reason: 'UNSUPPORTED_AGENT_ID' };
  const origin = publicOrigin(env.NEXT_PUBLIC_APP_ORIGIN);
  const cardUri =
    env.AGENT_IDENTITY_CARD_URI ?? (origin === null ? null : `${origin}/api/agent-card`);
  if (cardUri === null) return { configured: false, reason: 'NO_PUBLIC_CARD' };
  return {
    configured: true,
    reference: {
      standard: 'erc-8004',
      chainId: AGENT_IDENTITY_CHAIN_ID,
      identityRegistry: TESTNET_IDENTITY_REGISTRY,
      agentId: raw,
      cardUri,
    },
    policy: {
      id: 'lexaegis.monad-testnet.erc8004',
      chainId: AGENT_IDENTITY_CHAIN_ID,
      genesisHash: TESTNET_GENESIS_HASH,
      identityRegistry: TESTNET_IDENTITY_REGISTRY,
      executionDelayBlocks: 3,
    },
    rpcUrl: env.AGENT_IDENTITY_RPC_URL ?? 'https://testnet-rpc.monad.xyz/',
  };
}
