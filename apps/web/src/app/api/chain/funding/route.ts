import { createApplicationError } from '@lexaegis/protocol';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { errorResponse, handleRoute, jsonResponse } from '@/server/http';
import { requestTestnetFunding } from '@/server/chain/testnet-funding';
import { authedJson, limited, ready } from '@/server/chain/route-support';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** An empty object only: recipient and amount are never accepted from the client. */
const bodySchema = z.strictObject({});

export const POST = handleRoute(async (requestId, request) => {
  const auth = await authedJson(request, requestId);
  if (auth instanceof Response) return auth;
  const chain = ready(requestId);
  if (chain instanceof Response) return chain;
  if (!bodySchema.safeParse(auth.body).success) {
    return errorResponse(
      createApplicationError('INVALID_INPUT', 'The request was not accepted.', requestId),
    );
  }
  if (chain.store === null) {
    return errorResponse(
      createApplicationError('NOT_CONFIGURED', 'Database is not configured.', requestId),
    );
  }
  const blocked = await limited(chain, `chain:fund:${auth.address}`, 5, requestId);
  if (blocked !== null) return blocked;
  const result = await requestTestnetFunding(
    {
      client: chain.client,
      policy: chain.policy,
      store: chain.store,
      settings: chain.settings,
      funder: chain.funder,
      now: chain.now,
      randomId: () => randomUUID(),
    },
    auth.address,
  );
  return jsonResponse({ ok: true, funding: result }, 200, requestId);
});
