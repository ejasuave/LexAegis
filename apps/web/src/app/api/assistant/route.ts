import { handleRoute, jsonResponse } from '@/server/http';
import { authed } from '@/server/assistant/route-support';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What a signed-in reviewer may know before any disclosure: whether an assistant provider is
 * configured and verified, and which provider, model and endpoint region a request would reach.
 * No endpoint URL, workspace identifier or credential is returned.
 */
export const GET = handleRoute(async (requestId, request) => {
  const auth = await authed(request, requestId);
  if (auth instanceof Response) return auth;
  const availability = await auth.runtime.agent.availability();
  return jsonResponse(
    { ok: true, availability: { ...availability, briefingEnabled: auth.runtime.briefingEnabled } },
    200,
    requestId,
  );
});
