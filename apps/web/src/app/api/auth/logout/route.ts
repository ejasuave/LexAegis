import { getAuthService, guardedBody, replyResponse } from '@/server/auth/session';
import { handleRoute } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Revokes the backend session and clears its cookies. */
export const POST = handleRoute(async (requestId, request) => {
  const guarded = await guardedBody(request, requestId);
  if (guarded instanceof Response) return guarded;
  return replyResponse(
    await getAuthService().service.logout(request.headers.get('cookie'), requestId),
    requestId,
  );
});
