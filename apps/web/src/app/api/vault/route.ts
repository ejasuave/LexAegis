import { handleRoute } from '@/server/http';
import {
  authorizedRead,
  authorizedWrite,
  getVaultService,
  OBJECT_BODY_LIMIT,
  replyResponse,
} from '@/server/vault/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Discover this account's vault descriptor and head, or explicit absence. */
export const GET = handleRoute(async (requestId, request) => {
  const auth = await authorizedRead(request, requestId);
  if (auth instanceof Response) return auth;
  return replyResponse(await getVaultService().discover(auth.address, requestId), requestId);
});

/** Create the descriptor and its encrypted initial catalog. Never overwrites. */
export const POST = handleRoute(async (requestId, request) => {
  const auth = await authorizedWrite(request, requestId, OBJECT_BODY_LIMIT);
  if (auth instanceof Response) return auth;
  return replyResponse(
    await getVaultService().create(auth.address, auth.bytes, requestId),
    requestId,
  );
});
