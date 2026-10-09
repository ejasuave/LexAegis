import { getAuthService, guardedBody, replyResponse } from '@/server/auth/session';
import { handleRoute } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Verifies the signed message and issues the rotated session cookie. */
export const POST = handleRoute(async (requestId, request) => {
  const guarded = await guardedBody(request, requestId);
  if (guarded instanceof Response) return guarded;
  const reply = await getAuthService().service.verify(
    guarded.body,
    request.headers.get('cookie'),
    requestId,
  );
  return replyResponse(reply, requestId);
});
