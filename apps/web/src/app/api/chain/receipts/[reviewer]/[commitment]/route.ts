import { createApplicationError } from '@lexaegis/protocol';
import { readLiveReceipt } from '@lexaegis/sdk/registry';
import { errorResponse } from '@/server/http';
import { handleRoute } from '@/server/http';
import { getChainRuntime } from '@/server/chain/runtime';
import { publicJson } from '@/server/chain/route-support';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public live state for the configured registry. No wallet, no login, no opening. */
export const GET = handleRoute(async (requestId, request, context) => {
  const params = await context.params;
  const reviewer = typeof params.reviewer === 'string' ? params.reviewer.toLowerCase() : '';
  const commitment = typeof params.commitment === 'string' ? params.commitment.toLowerCase() : '';
  if (!/^0x[0-9a-f]{40}$/.test(reviewer) || !/^0x[0-9a-f]{64}$/.test(commitment)) {
    return errorResponse(
      createApplicationError('INVALID_INPUT', 'Invalid receipt lookup.', requestId),
    );
  }
  const chain = getChainRuntime();
  if (chain.state !== 'ready') {
    return publicJson(
      request,
      { ok: true, status: 'unknown', reason: chain.state },
      200,
      requestId,
    );
  }
  const read = await readLiveReceipt(
    chain.client.live,
    chain.policy,
    {
      reference: {
        schema: 'lexaegis.receipt-ref.v1',
        chainId: chain.policy.chainId,
        registryAddress: chain.policy.registryAddress,
        reviewerAddress: reviewer,
        commitment,
      } as never,
    },
    chain.now,
  );
  return publicJson(
    request,
    read.status === 'ok'
      ? {
          ok: true,
          status: 'ok',
          receipt: read.data.receipt,
          registryNonce: read.data.registryNonce,
          checkpoint: read.data.checkpoint,
          // Live provider observation as of this block; not a light-client proof.
          source: 'rpc',
        }
      : { ok: true, status: 'unknown', reason: read.reason },
    200,
    requestId,
  );
});
