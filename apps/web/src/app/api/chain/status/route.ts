import { readChainCheckpoint } from '@lexaegis/sdk/registry';
import { getChainRuntime } from '@/server/chain/runtime';
import { publicChainInfo, resolveDeployment } from '@/server/chain/config';
import { handleRoute } from '@/server/http';
import { publicJson } from '@/server/chain/route-support';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public network and deployment readiness with the latest execution checkpoint. */
export const GET = handleRoute(async (requestId, request) => {
  const chain = getChainRuntime();
  const info = publicChainInfo(resolveDeployment());
  if (chain.state !== 'ready') {
    return publicJson(request, { ok: true, status: chain.state, chain: info }, 200, requestId);
  }
  const checkpoint = await readChainCheckpoint(chain.client.live, chain.policy, chain.now);
  return publicJson(
    request,
    checkpoint.status === 'ok'
      ? { ok: true, status: 'ready', chain: info, checkpoint: checkpoint.data }
      : { ok: true, status: 'unknown', reason: checkpoint.reason, chain: info },
    200,
    requestId,
  );
});
