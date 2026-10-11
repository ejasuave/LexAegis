import { createApplicationError } from '@lexaegis/protocol';
import { readProvisionalState } from '@lexaegis/sdk/registry';
import { errorResponse, handleRoute } from '@/server/http';
import { getChainRuntime } from '@/server/chain/runtime';
import { publicJson } from '@/server/chain/route-support';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Latest provisional registry state for one receipt and the reviewer's action nonce, for the
 * review-approval preflight. Public and read-only: no wallet, no login, no opening. It is a live
 * provider observation at one identified block, never a confirmed or finalised state.
 */
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
  const read = await readProvisionalState(
    chain.client.live,
    chain.policy,
    {
      schema: 'lexaegis.receipt-ref.v1',
      chainId: chain.policy.chainId,
      registryAddress: chain.policy.registryAddress,
      reviewerAddress: reviewer,
      commitment,
    } as never,
    chain.now,
  );
  return publicJson(
    request,
    read.status === 'ok'
      ? {
          ok: true,
          status: 'ok',
          label: read.data.label,
          blockNumber: read.data.blockNumber,
          blockTimestamp: read.data.blockTimestamp,
          observedAt: read.data.observedAt,
          registryNonce: read.data.registryNonce,
          receiptLifecycle: read.data.receipt.receiptLifecycle,
          source: 'rpc',
        }
      : { ok: true, status: 'unknown', reason: read.reason },
    200,
    requestId,
  );
});
