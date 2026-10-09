import { createApplicationError } from '@lexaegis/protocol';
import { z } from 'zod';
import { errorResponse, handleRoute, jsonResponse } from '@/server/http';
import { requestSchema, submitOperation } from '@/server/chain/operations';
import { authedJson, failureResponse, limited, ready } from '@/server/chain/route-support';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.strictObject({
  request: requestSchema,
  quote: z.unknown(),
  // 4 KiB of raw bytes at most: 8192 hex characters plus the prefix.
  signedTransaction: z.string().regex(/^0x[0-9a-f]{2,8192}$/),
});

/** Carries the user-signed transaction to Alchemy. The server never signs it. */
export const POST = handleRoute(async (requestId, request, context) => {
  const auth = await authedJson(request, requestId);
  if (auth instanceof Response) return auth;
  const chain = ready(requestId);
  if (chain instanceof Response) return chain;
  const { id } = await context.params;
  const parsedId = z.uuid().safeParse(id);
  const body = bodySchema.safeParse(auth.body);
  if (!parsedId.success || !body.success || chain.operationDeps === null) {
    return errorResponse(
      createApplicationError('INVALID_INPUT', 'The request was not accepted.', requestId),
    );
  }
  const blocked = await limited(chain, `chain:submit:${auth.address}`, 20, requestId);
  if (blocked !== null) return blocked;
  const result = await submitOperation(chain.operationDeps, auth.address, parsedId.data, body.data);
  return result.ok
    ? jsonResponse({ ok: true, ...result.data }, 200, requestId)
    : failureResponse(result.code, requestId);
});
