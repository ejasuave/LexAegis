import { z } from 'zod';
import { parseRpcEndpoint } from '@lexaegis/sdk/verify';
import { registryPolicySchema, type RegistryPolicy } from '@lexaegis/sdk';
import generated from './generated/default-policy.json';

/**
 * Public, build-time configuration only. It comes from this app's own VITE_ variables and the
 * generated deployment projection, never from an imported package or a LexAegis backend. Nothing
 * here is secret. Malformed values are ignored (treated as unconfigured) and never echoed.
 */

/** Public Monad Testnet JSON-RPC endpoint. Observed reachable, CORS-enabled and serving finalized blocks on 2026-10-11. */
export const DEFAULT_PUBLIC_RPC_URL = 'https://testnet-rpc.monad.xyz/';

export interface VerifierConfig {
  /** The caller-trusted registry deployment, or null when live verification is unavailable. */
  readonly policy: RegistryPolicy | null;
  readonly policySource: 'integrator' | 'default' | 'none';
  readonly rpcUrl: string;
  /** Registry-read origins this build allows. The page's Content-Security-Policy is built from the same list. */
  readonly allowedRpcOrigins: readonly string[];
  /** Where the installed policy came from, for display. */
  readonly policyNote: string;
}

const generatedSchema = z.strictObject({
  schema: z.literal('lexaegis.verifier-default-policy.v1'),
  source: z.string(),
  reason: z.string().nullable(),
  policy: registryPolicySchema.nullable(),
});

/** The default endpoint's origin plus any the integrator lists. Only valid public HTTPS origins count. */
export function parseAllowedOrigins(listed: string | undefined, defaultUrl: string): string[] {
  const origins = new Set<string>([new URL(defaultUrl).origin]);
  for (const item of (listed ?? '').split(/[\s,]+/)) {
    if (item === '') continue;
    const endpoint = parseRpcEndpoint(item);
    if (endpoint.ok) origins.add(endpoint.origin);
  }
  return [...origins];
}

export function loadVerifierConfig(
  env: Readonly<Record<string, string | undefined>>,
  defaults: unknown = generated,
): VerifierConfig {
  const rpc = parseRpcEndpoint(env.VITE_RPC_URL ?? DEFAULT_PUBLIC_RPC_URL);
  const rpcUrl = rpc.ok ? rpc.url : DEFAULT_PUBLIC_RPC_URL;
  const allowedRpcOrigins = parseAllowedOrigins(env.VITE_RPC_ALLOWED_ORIGINS, rpcUrl);

  // A deliberate integrator override: a build-time policy, never anything an imported file says.
  if (env.VITE_REGISTRY_POLICY_JSON !== undefined && env.VITE_REGISTRY_POLICY_JSON !== '') {
    try {
      const custom = registryPolicySchema.safeParse(JSON.parse(env.VITE_REGISTRY_POLICY_JSON));
      if (custom.success) {
        return {
          policy: custom.data,
          policySource: 'integrator',
          rpcUrl,
          allowedRpcOrigins,
          policyNote: 'Configured by whoever built this verifier.',
        };
      }
    } catch {
      // Fall through to "no policy": an unreadable override must not silently become the default.
    }
    return {
      policy: null,
      policySource: 'none',
      rpcUrl,
      allowedRpcOrigins,
      policyNote: 'The integrator policy is not valid, so registry checks are unavailable.',
    };
  }

  const parsed = generatedSchema.safeParse(defaults);
  if (!parsed.success || parsed.data.policy === null) {
    return {
      policy: null,
      policySource: 'none',
      rpcUrl,
      allowedRpcOrigins,
      policyNote:
        'No verified registry deployment is pinned in this build, so registry checks are unavailable.',
    };
  }
  return {
    policy: parsed.data.policy,
    policySource: 'default',
    rpcUrl,
    allowedRpcOrigins,
    policyNote: `Generated from the recorded Monad Testnet deployment (${parsed.data.source}).`,
  };
}
