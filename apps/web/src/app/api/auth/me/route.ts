import { getAuthService, replyResponse } from '@/server/auth/session';
import { handleRoute } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public metadata of the current backend session. Never a token. */
export const GET = handleRoute(async (requestId, request) =>
  replyResponse(
    await getAuthService().service.me(request.headers.get('cookie'), requestId),
    requestId,
  ),
);
