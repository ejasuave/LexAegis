import { parseRpcEndpoint } from '@lexaegis/sdk/verify';
import { registryPolicySchema, type RegistryPolicy } from '@lexaegis/sdk/offline';

/*
 * Where a public issue may go. There is exactly one approved public network, and the only other
 * target is a loopback test chain that is explicitly selected and is never that network. There is no
 * flag that skips the chain check.
 */

/**
 * The approved public network: Monad Testnet. The values come from contracts/deployments/
 * monad-testnet.json (a test compares them with that file, so they cannot drift silently).
 */
export const APPROVED_PUBLIC_NETWORK = Object.freeze({
  name: 'Monad Testnet',
  chainId: '10143',
  genesisHash: '0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9',
});

export const TARGET_MODES = ['monad-testnet', 'local-loopback'] as const;
export type TargetMode = (typeof TARGET_MODES)[number];

export type TargetFailure =
  | 'POLICY_INVALID'
  | 'NETWORK_NOT_APPROVED'
  | 'ENDPOINT_REJECTED'
  | 'LOCAL_TARGET_IS_PUBLIC_NETWORK'
  | 'ENDPOINT_NOT_LOOPBACK';

export type TargetResult =
  | { readonly ok: true; readonly policy: RegistryPolicy; readonly rpcUrl: string }
  | { readonly ok: false; readonly code: TargetFailure };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function checkTarget(mode: TargetMode, policyInput: unknown, rpcUrl: string): TargetResult {
  const policy = registryPolicySchema.safeParse(policyInput);
  if (!policy.success) return { ok: false, code: 'POLICY_INVALID' };
  const isApproved =
    policy.data.chainId === APPROVED_PUBLIC_NETWORK.chainId &&
    policy.data.genesisHash === APPROVED_PUBLIC_NETWORK.genesisHash;
  if (mode === 'monad-testnet') {
    // Even a matching registry address elsewhere is refused: chain ID and genesis both must match.
    if (!isApproved) return { ok: false, code: 'NETWORK_NOT_APPROVED' };
    const endpoint = parseRpcEndpoint(rpcUrl);
    if (!endpoint.ok) return { ok: false, code: 'ENDPOINT_REJECTED' };
    return { ok: true, policy: policy.data, rpcUrl: endpoint.url };
  }
  if (isApproved || policy.data.chainId === APPROVED_PUBLIC_NETWORK.chainId)
    return { ok: false, code: 'LOCAL_TARGET_IS_PUBLIC_NETWORK' };
  const endpoint = parseRpcEndpoint(rpcUrl, { allowLoopbackHttp: true });
  if (!endpoint.ok) return { ok: false, code: 'ENDPOINT_REJECTED' };
  if (!LOOPBACK.has(new URL(endpoint.url).hostname))
    return { ok: false, code: 'ENDPOINT_NOT_LOOPBACK' };
  return { ok: true, policy: policy.data, rpcUrl: endpoint.url };
}
