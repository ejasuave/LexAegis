import { handleRoute } from '@/server/http';
import { readHistoryPage } from '@/server/history/status';
import {
  historyJson,
  invalid,
  limitHistory,
  onlyParams,
  parseLimit,
  readyRuntime,
  unavailableBody,
} from '@/server/history/route-support';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REVIEWER = /^0x[0-9a-f]{40}$/;

/** One reviewer's completed actions, newest nonce first, behind an anchored cursor. */
export const GET = handleRoute(async (requestId, request, context) => {
  const params = onlyParams(request, ['cursor', 'limit']);
  const raw = (await context.params).reviewer;
  const reviewer = typeof raw === 'string' ? raw : '';
  const limit = params === null ? null : parseLimit(params.get('limit'));
  if (
    params === null ||
    limit === null ||
    !REVIEWER.test(reviewer) ||
    reviewer === `0x${'0'.repeat(40)}`
  ) {
    return invalid(requestId);
  }
  const limited = await limitHistory(request, requestId);
  if (limited !== null) return limited;
  const ready = readyRuntime();
  if (ready === null) {
    return historyJson(request, unavailableBody(null, 'DEPLOYMENT_UNAVAILABLE'), 503, requestId);
  }
  const outcome = await readHistoryPage(
    ready.deps,
    ready.configured,
    { reviewer, cursor: params.get('cursor'), limit },
    request.signal,
  );
  switch (outcome.kind) {
    case 'ok':
      return historyJson(request, { ok: true, ...outcome.page }, 200, requestId);
    case 'reset':
      return historyJson(request, { ok: false, ...outcome.body }, 409, requestId);
    case 'unavailable':
      return historyJson(
        request,
        unavailableBody(outcome.health, 'HISTORY_UNAVAILABLE'),
        503,
        requestId,
      );
    case 'invalid_input':
      return invalid(requestId);
  }
});
