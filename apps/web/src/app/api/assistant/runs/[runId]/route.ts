import { errorResponse, handleRoute, jsonResponse } from '@/server/http';
import { authed, invalid, runIdOf } from '@/server/assistant/route-support';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Owner-bound operational status: state, deadlines and counters. It never reconstructs a prompt,
 * an answer or a tool result, and there is no event replay. Another account's run and a missing
 * run are the same NOT_FOUND.
 */
export const GET = handleRoute(async (requestId, request, context) => {
  const auth = await authed(request, requestId);
  if (auth instanceof Response) return auth;
  const runId = await runIdOf(context);
  if (runId === null) return invalid(requestId);
  const status = await auth.runtime.agent.status(runId, auth.owner);
  return status.ok
    ? jsonResponse({ ok: true, metadata: status.data }, 200, requestId)
    : errorResponse({ ...status.error, requestId });
});
