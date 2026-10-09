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

async function idsOf(context: { params: Promise<Record<string, string | string[] | undefined>> }) {
  const { vaultId, objectId } = await context.params;
  return {
    vaultId: typeof vaultId === 'string' ? vaultId : '',
    objectId: typeof objectId === 'string' ? objectId : '',
  };
}

/** The exact stored envelope bytes. */
export const GET = handleRoute(async (requestId, request, context) => {
  const auth = await authorizedRead(request, requestId);
  if (auth instanceof Response) return auth;
  const ids = await idsOf(context);
  return replyResponse(
    await getVaultService().getObject(auth.address, ids.vaultId, ids.objectId, requestId),
    requestId,
  );
});

/** One immutable envelope, up to 16 MiB, counted as it streams. */
export const PUT = handleRoute(async (requestId, request, context) => {
  const auth = await authorizedWrite(request, requestId, OBJECT_BODY_LIMIT);
  if (auth instanceof Response) return auth;
  const ids = await idsOf(context);
  const reply = await getVaultService().putObject(
    auth.address,
    ids.vaultId,
    ids.objectId,
    auth.bytes,
    requestId,
  );
  return replyResponse(reply, requestId);
});
