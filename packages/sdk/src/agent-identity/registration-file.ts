import { z } from 'zod';

/*
 * The ERC-8004 registration file ("agent card"), as an EXTERNAL format. Its numbers are JSON
 * numbers, unlike LexAegis artifacts, which carry decimal strings: a card cannot name an agent whose
 * ID a JSON number cannot hold exactly, and such a card is rejected, never rounded. Everything in a
 * fetched card is an untrusted self-declaration.
 * Source: https://eips.ethereum.org/EIPS/eip-8004 (registration file section, read 2026-10-11).
 */

export const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

export const DISPLAY_LIMITS = Object.freeze({ name: 120, description: 500, services: 8 });

const agentRegistrySchema = z.string().regex(/^eip155:[1-9][0-9]{0,77}:0x[0-9a-fA-F]{40}$/);

/** A non-negative integer a JSON number holds exactly. Anything larger is unsupported precision. */
const safeAgentId = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && value >= 0, 'unsupported agentId precision');

export const registrationEntrySchema = z.strictObject({
  agentId: safeAgentId,
  agentRegistry: agentRegistrySchema,
});

const serviceSchema = z.looseObject({
  name: z.string().max(200),
  endpoint: z.string().max(2048),
  version: z.string().max(100).optional(),
});

export const registrationFileSchema = z.looseObject({
  type: z.literal(REGISTRATION_TYPE),
  name: z.string().min(1).max(2000),
  description: z.string().max(10_000),
  image: z.string().max(2048).optional(),
  services: z.array(serviceSchema).max(64),
  x402Support: z.boolean(),
  active: z.boolean(),
  registrations: z.array(registrationEntrySchema).max(64),
  supportedTrust: z.array(z.string().max(100)).max(16).optional(),
});
export type RegistrationFile = z.infer<typeof registrationFileSchema>;

export interface RegistrationInput {
  /** The public HTTPS origin the card is served from. */
  readonly origin: string;
  /** The ACTUAL registration tuple, known only after a confirmed registration and read-back. */
  readonly registration?: {
    readonly agentId: number;
    readonly chainId: string;
    readonly identityRegistry: string;
  };
}

/**
 * Builds the LexAegis review assistant's card from facts that exist: its name, a bounded
 * description, its public web origin and (after a confirmed registration) its real registration
 * tuple. It advertises only the web service. No MCP, A2A, x402, validation, credential or trust
 * claim is made, and no agent ID is ever predicted: with no registration the list is empty.
 *
 * @example
 * ```ts
 * import { buildRegistrationFile } from '@lexaegis/sdk/agent-identity';
 *
 * const card = buildRegistrationFile({ origin: 'https://example.invalid' });
 * console.log(card.registrations.length); // 0 until a registration is confirmed
 * ```
 */
export function buildRegistrationFile(input: RegistrationInput): RegistrationFile {
  const origin = new URL(input.origin);
  if (origin.protocol !== 'https:' || origin.username !== '' || origin.password !== '') {
    throw new RangeError('the card needs a public https origin without credentials');
  }
  const base = origin.origin;
  const registrations =
    input.registration === undefined
      ? []
      : [
          {
            agentId: input.registration.agentId,
            agentRegistry: `eip155:${input.registration.chainId}:${input.registration.identityRegistry.toLowerCase()}`,
          },
        ];
  return registrationFileSchema.parse({
    type: REGISTRATION_TYPE,
    name: 'LexAegis review assistant',
    description:
      'Assists a person reviewing an employment settlement agreement (England and Wales): it proposes cited findings and a person decides. It gives no legal advice and its registration is not a statement about correctness or qualification.',
    image: `${base}/icon.svg`,
    services: [{ name: 'web', endpoint: `${base}/` }],
    x402Support: false,
    active: true,
    registrations,
  });
}
