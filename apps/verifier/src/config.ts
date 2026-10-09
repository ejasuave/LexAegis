import { chainIdSchema, evmAddressSchema } from '@lexaegis/protocol';
import type { ReceiptLookup } from '@lexaegis/sdk';

/** The chain and registry the verifier trusts; the reviewer and commitment come from the user's receipt. */
export type VerifierConfig = Partial<Pick<ReceiptLookup, 'chainId' | 'registryAddress'>>;

/**
 * Public, build-time configuration only. It is read from the verifier's own VITE_ variables and
 * never from an imported package or a LexAegis backend. Malformed values are ignored (treated as
 * unconfigured) so the page can still load; they are never echoed.
 */
export function loadVerifierConfig(
  env: Readonly<Record<string, string | undefined>>,
): VerifierConfig {
  const chainId = chainIdSchema.safeParse(env.VITE_CHAIN_ID);
  const registry = evmAddressSchema.safeParse(env.VITE_REGISTRY_ADDRESS);
  return {
    ...(chainId.success && { chainId: chainId.data }),
    ...(registry.success && { registryAddress: registry.data }),
  };
}
