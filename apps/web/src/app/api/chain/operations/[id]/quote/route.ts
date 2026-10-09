import { createApplicationError } from '@lexaegis/protocol';
import { z } from 'zod';
import { errorResponse, handleRoute, jsonResponse } from '@/server/http';
import { quoteOperation, requestSchema } from '@/server/chain/operations';
import { authedJson, failureResponse, limited, ready } from '@/server/chain/route-support';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.strictObject({
  request: requestSchema,
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]{130}$/)
    .nullable(),
});

/** Exact-calldata simulation and fee quote for an operation the caller owns. */
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
  const blocked = await limited(chain, `chain:quote:${auth.address}`, 30, requestId);
  if (blocked !== null) return blocked;
  const quoted = await quoteOperation(
    chain.operationDeps,
    auth.address,
    parsedId.data,
    body.data.request,
    body.data.signature as `0x${string}` | null,
  );
  return quoted.ok
    ? jsonResponse({ ok: true, ...quoted.data }, 200, requestId)
    : failureResponse(quoted.code, requestId);
});
