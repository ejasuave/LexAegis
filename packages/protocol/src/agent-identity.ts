import { z } from 'zod';
import {
  chainIdSchema,
  decimalAtMost,
  nonZeroAddressSchema,
  unsignedDecimalSchema,
} from './v1/primitives';

/*
 * The optional ERC-8004 reference carried inside the committed agent-configuration artifact. It
 * names a registry entry; it proves nothing about the assistant's output, the reviewer or anyone's
 * qualification, and it freezes only these fields, never the mutable card the URI points to. The
 * identity registry is a different contract from the review registry.
 */

export const AGENT_IDENTITY_STANDARD = 'erc-8004';
/** The only network newly produced references may name (Monad testnet). */
export const AGENT_IDENTITY_CHAIN_ID = '10143';
export const MAX_CARD_URI_LENGTH = 512;

const UINT256_MAX = 2n ** 256n - 1n;

/** A decimal string within uint256, zero allowed. Never routed through a JavaScript number. */
export const agentIdSchema = unsignedDecimalSchema.refine(
  (value) => decimalAtMost(value, UINT256_MAX),
  { message: 'agentId exceeds uint256' },
);

/**
 * A public HTTPS URI with no credentials, query or fragment (where matter data or tokens could
 * hide), bounded in length. The reference is not fetched from here.
 */
export const cardUriSchema = z
  .string()
  .max(MAX_CARD_URI_LENGTH)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === '' &&
        url.hostname.includes('.') &&
        url.href === value
      );
    } catch {
      return false;
    }
  }, 'cardUri must be a normalised public https URI without credentials, query or fragment');

export const agentIdentityRefSchema = z.strictObject({
  standard: z.literal(AGENT_IDENTITY_STANDARD),
  chainId: chainIdSchema,
  identityRegistry: nonZeroAddressSchema,
  agentId: agentIdSchema,
  cardUri: cardUriSchema,
});
export type AgentIdentityRef = z.infer<typeof agentIdentityRefSchema>;

/** What a producer may write into a new artifact: the same shape, on the configured testnet only. */
export const producibleAgentIdentitySchema = agentIdentityRefSchema.refine(
  (reference) => reference.chainId === AGENT_IDENTITY_CHAIN_ID,
  { message: 'new references must name the configured testnet', path: ['chainId'] },
);
