import { createApplicationError } from '@lexaegis/protocol';
import { errorResponse, handleRoute, jsonResponse } from '@/server/http';
import { CHAIN } from '@/server/chain/config';
import { checkAccountUndelegated } from '@/server/chain/preflight';
import { authedRead, ready } from '@/server/chain/route-support';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The signed-in account's usable MON balance and the real funding limits. Reads only. */
export const GET = handleRoute(async (requestId, request) => {
  const auth = await authedRead(request, requestId);
  if (auth instanceof Response) return auth;
  const chain = ready(requestId);
  if (chain instanceof Response) return chain;
  try {
    const address = auth.address as `0x${string}`;
    const [balance, undelegated, block] = await Promise.all([
      chain.client.public.getBalance({ address }),
      checkAccountUndelegated(chain.client, address),
      chain.client.public.getBlockNumber(),
    ]);
    return jsonResponse(
      {
        ok: true,
        account: {
          address,
          balanceWei: balance.toString(),
          undelegated,
          observedBlock: block.toString(),
          observedAt: chain.now().toISOString(),
        },
        funding: {
          enabled: chain.settings.fundingEnabled && chain.funder !== null,
          grantWei: chain.settings.grantWei.toString(),
          faucetUrl: CHAIN.faucetUrl,
        },
      },
      200,
      requestId,
    );
  } catch {
    return errorResponse(
      createApplicationError('UNAVAILABLE', 'The network could not be reached.', requestId),
    );
  }
});
