import { handleRoute } from '@/server/http';
import { readReceiptHistory } from '@/server/history/status';
import {
  historyJson,
  invalid,
  limitHistory,
  onlyParams,
  readyRuntime,
  unavailableBody,
} from '@/server/history/route-support';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Indexed lifecycle and the live registry result for one receipt, kept as separate objects. */
export const GET = handleRoute(async (requestId, request, context) => {
  if (onlyParams(request, []) === null) return invalid(requestId);
  const p = await context.params;
  const reviewer = typeof p.reviewer === 'string' ? p.reviewer : '';
  const commitment = typeof p.commitment === 'string' ? p.commitment : '';
  if (
    !/^0x[0-9a-f]{40}$/.test(reviewer) ||
    reviewer === `0x${'0'.repeat(40)}` ||
    !/^0x[0-9a-f]{64}$/.test(commitment) ||
    commitment === `0x${'0'.repeat(64)}`
  ) {
    return invalid(requestId);
  }
  const limited = await limitHistory(request, requestId);
  if (limited !== null) return limited;
  const ready = readyRuntime();
  if (ready === null) {
    return historyJson(request, unavailableBody(null, 'DEPLOYMENT_UNAVAILABLE'), 503, requestId);
  }
  const outcome = await readReceiptHistory(
    ready.deps,
    ready.configured,
    { reviewer, commitment },
    request.signal,
  );
  return outcome.kind === 'ok'
    ? historyJson(request, { ok: true, ...outcome.body }, 200, requestId)
    : historyJson(request, unavailableBody(outcome.health, 'HISTORY_UNAVAILABLE'), 503, requestId);
});
