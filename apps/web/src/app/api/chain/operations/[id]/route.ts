import { createApplicationError } from '@lexaegis/protocol';
import { z } from 'zod';
import { errorResponse, handleRoute, jsonResponse } from '@/server/http';
import { requestSchema, reconcileOperation } from '@/server/chain/operations';
import { authedJson, authedRead, failureResponse, ready } from '@/server/chain/route-support';
import { limited } from '@/server/chain/route-support';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const idSchema = z.uuid();

async function idOf(context: { params: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await context.params;
  const parsed = idSchema.safeParse(id);
  return parsed.success ? parsed.data : null;
}

/** Owner-only record. Without a request body it reports stored state; POST reconciles with chain state. */
export const GET = handleRoute(async (requestId, request, context) => {
  const auth = await authedRead(request, requestId);
  if (auth instanceof Response) return auth;
  const chain = ready(requestId);
  if (chain instanceof Response) return chain;
  const id = await idOf(context);
  if (id === null || chain.operationDeps === null) {
    return errorResponse(createApplicationError('INVALID_INPUT', 'Invalid operation.', requestId));
  }
  const result = await reconcileOperation(chain.operationDeps, auth.address, id, null);
  return result.ok
    ? jsonResponse({ ok: true, operation: result.data.operation }, 200, requestId)
    : failureResponse(result.code, requestId);
});

const reconcileBody = z.strictObject({ request: requestSchema });

/** Explicit status refresh: re-reads the chain for the stored hash. Never re-signs or re-broadcasts. */
export const POST = handleRoute(async (requestId, request, context) => {
  const auth = await authedJson(request, requestId);
  if (auth instanceof Response) return auth;
  const chain = ready(requestId);
  if (chain instanceof Response) return chain;
  const id = await idOf(context);
  const body = reconcileBody.safeParse(auth.body);
  if (id === null || !body.success || chain.operationDeps === null) {
    return errorResponse(
      createApplicationError('INVALID_INPUT', 'The request was not accepted.', requestId),
    );
  }
  const blocked = await limited(chain, `chain:refresh:${auth.address}`, 60, requestId);
  if (blocked !== null) return blocked;
  const result = await reconcileOperation(chain.operationDeps, auth.address, id, body.data.request);
  return result.ok
    ? jsonResponse(
        { ok: true, operation: result.data.operation, observation: result.data.observation },
        200,
        requestId,
      )
    : failureResponse(result.code, requestId);
});
