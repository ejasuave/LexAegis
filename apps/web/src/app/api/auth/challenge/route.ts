import { getAuthService, guardedBody, replyResponse } from '@/server/auth/session';
import { handleRoute } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Issues the server-built sign-in message for the selected address. */
export const POST = handleRoute(async (requestId, request) => {
  const guarded = await guardedBody(request, requestId);
  if (guarded instanceof Response) return guarded;
  return replyResponse(
    await getAuthService().service.challenge(guarded.body, requestId),
    requestId,
  );
});
