import { resolveAgentIdentity } from '@lexaegis/sdk/agent-identity';
import { handleRoute, jsonResponse } from '@/server/http';
import { getFeatureConfiguration, rejectIfDisabled } from '@/server/flags';
import { loadIdentityConfig } from '@/server/agent-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One explicit, read-only identity inspection of the CURRENT assistant: a resolution against the
 * configured testnet, or the plain fact that no registration is configured. Disabled feature: no
 * route. It reads public chain data only, takes no input from the client and caches nothing.
 */
export const GET = handleRoute(async (requestId, request) => {
  const disabled = rejectIfDisabled('agentIdentity', requestId, getFeatureConfiguration());
  if (disabled !== null) return disabled;
  const config = loadIdentityConfig(process.env);
  if (!config.configured) {
    return jsonResponse({ configured: false, reason: config.reason }, 200, requestId);
  }
  const resolution = await resolveAgentIdentity({
    reference: config.reference,
    policy: config.policy,
    transport: { kind: 'rpc', url: config.rpcUrl },
    signal: request.signal,
  });
  return jsonResponse({ configured: true, resolution }, 200, requestId);
});
