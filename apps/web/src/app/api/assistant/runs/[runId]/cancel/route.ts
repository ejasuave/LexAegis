import { z } from 'zod';
import { errorResponse, handleRoute, jsonResponse } from '@/server/http';
import { authedBody, invalid, logRun, runIdOf } from '@/server/assistant/route-support';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const emptyBody = z.strictObject({});

/**
 * Stop. Returns 202 while the run is stopping and 200 with the actual terminal state once the
 * worker has acknowledged. Repeating it is harmless. Stopping cannot retract text already sent to
 * the provider, and a request already submitted may still be billed.
 */
export const POST = handleRoute(async (requestId, request, context) => {
  const auth = await authedBody(request, requestId);
  if (auth instanceof Response) return auth;
  const runId = await runIdOf(context);
  if (runId === null || !emptyBody.safeParse(auth.body).success) return invalid(requestId);
  const cancelled = await auth.runtime.agent.cancel({ runId, ownerId: auth.owner }, request.signal);
  if (!cancelled.ok) return errorResponse({ ...cancelled.error, requestId });
  logRun('assistant.run.cancel', requestId, cancelled.data.state);
  return jsonResponse(
    { ok: true, ...cancelled.data },
    cancelled.data.acknowledged ? 200 : 202,
    requestId,
  );
});
