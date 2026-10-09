import { handleRoute } from '@/server/http';
import {
  authorizedRead,
  authorizedWrite,
  getVaultService,
  replyResponse,
} from '@/server/vault/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function vaultIdOf(context: {
  params: Promise<Record<string, string | string[] | undefined>>;
}): Promise<string> {
  const { vaultId } = await context.params;
  return typeof vaultId === 'string' ? vaultId : '';
}

export const GET = handleRoute(async (requestId, request, context) => {
  const auth = await authorizedRead(request, requestId);
  if (auth instanceof Response) return auth;
  return replyResponse(
    await getVaultService().getHead(auth.address, await vaultIdOf(context), requestId),
    requestId,
  );
});

/** Compare-and-swap expectedRevision to an uploaded catalog reference. */
export const PUT = handleRoute(async (requestId, request, context) => {
  const auth = await authorizedWrite(request, requestId);
  if (auth instanceof Response) return auth;
  const reply = await getVaultService().putHead(
    auth.address,
    await vaultIdOf(context),
    auth.bytes,
    requestId,
  );
  return replyResponse(reply, requestId);
});
