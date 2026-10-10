import { handleRoute } from '@/server/http';
import { readHealth } from '@/server/history/status';
import {
  historyJson,
  limitHistory,
  onlyParams,
  invalid,
  readyRuntime,
  unavailableBody,
} from '@/server/history/route-support';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public, read-only index health. No passkey, vault or matter identifier. */
export const GET = handleRoute(async (requestId, request) => {
  if (onlyParams(request, []) === null) return invalid(requestId);
  const limited = await limitHistory(request, requestId);
  if (limited !== null) return limited;
  const ready = readyRuntime();
  if (ready === null) {
    return historyJson(request, unavailableBody(null, 'DEPLOYMENT_UNAVAILABLE'), 503, requestId);
  }
  const { health } = await readHealth(ready.deps, ready.configured, request.signal);
  return historyJson(
    request,
    { ok: true, health },
    health.availability === 'available' || health.indexConsistency !== 'unknown' ? 200 : 503,
    requestId,
  );
});
