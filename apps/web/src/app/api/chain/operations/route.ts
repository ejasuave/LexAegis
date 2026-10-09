import { createApplicationError } from '@lexaegis/protocol';
import { z } from 'zod';
import { errorResponse, handleRoute, jsonResponse } from '@/server/http';
import {
  createOperation,
  idempotencyKeySchema,
  requestSchema,
  toRecord,
} from '@/server/chain/operations';
import {
  authedJson,
  authedRead,
  failureResponse,
  limited,
  ready,
} from '@/server/chain/route-support';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.strictObject({ idempotencyKey: idempotencyKeySchema, request: requestSchema });

/** Reserves an operation after a fresh preflight. Public action data only. */
export const POST = handleRoute(async (requestId, request) => {
  const auth = await authedJson(request, requestId);
  if (auth instanceof Response) return auth;
  const chain = ready(requestId);
  if (chain instanceof Response) return chain;
  if (chain.operationDeps === null)
    return errorResponse(
      createApplicationError('NOT_CONFIGURED', 'Database is not configured.', requestId),
    );
  const blocked = await limited(chain, `chain:op:${auth.address}`, 30, requestId);
  if (blocked !== null) return blocked;
  const body = bodySchema.safeParse(auth.body);
  if (!body.success)
    return errorResponse(
      createApplicationError('INVALID_INPUT', 'The request was not accepted.', requestId),
    );
  const created = await createOperation(
    chain.operationDeps,
    auth.address,
    body.data.idempotencyKey,
    body.data.request,
  );
  return created.ok
    ? jsonResponse({ ok: true, ...created.data }, 200, requestId)
    : failureResponse(created.code, requestId);
});

/** The owner's unresolved operations, so a reload or a recovered account can reconnect them. */
export const GET = handleRoute(async (requestId, request) => {
  const auth = await authedRead(request, requestId);
  if (auth instanceof Response) return auth;
  const chain = ready(requestId);
  if (chain instanceof Response) return chain;
  if (chain.operationDeps === null)
    return errorResponse(
      createApplicationError('NOT_CONFIGURED', 'Database is not configured.', requestId),
    );
  const rows = await chain.operationDeps.store.listUnresolved(auth.address);
  return jsonResponse(
    { ok: true, operations: rows.map((row) => toRecord(row, chain.policy)) },
    200,
    requestId,
  );
});
