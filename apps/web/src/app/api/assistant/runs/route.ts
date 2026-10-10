import { createApplicationError } from '@lexaegis/protocol';
import { ASSISTANT_LIMITS, assistantRequestSchema, limitCodeOf } from '@lexaegis/agent/contracts';
import { errorResponse, handleRoute, jsonResponse } from '@/server/http';
import { rejectIfDisabled } from '@/server/flags';
import { authedBody, invalid, logRun, reasonResponse } from '@/server/assistant/route-support';
import { eventStreamResponse } from '@/server/assistant/sse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * A run lasts at most 120 seconds and the request stays open for exactly that long. A host that
 * cannot hold a streaming response this long cannot run the assistant; nothing is moved to
 * untracked background work to compensate.
 */
export const maxDuration = 150;

/**
 * Starts one assistant run and streams its events as server-sent events over this POST response.
 * The body is the consented request only: no provider configuration, owner or run state is
 * accepted. Private data travels in the body, never in the URL.
 */
export const POST = handleRoute(async (requestId, request) => {
  // Only this endpoint takes the larger 128 KiB limit, counted while the bytes are read.
  const auth = await authedBody(request, requestId, ASSISTANT_LIMITS.requestBytes);
  if (auth instanceof Response) return auth;
  const parsed = assistantRequestSchema.safeParse(auth.body);
  if (!parsed.success) {
    const limit = limitCodeOf(parsed.error);
    return limit === null
      ? invalid(requestId)
      : reasonResponse(
          createApplicationError(
            'INVALID_INPUT',
            'The request is too large. Select less and try again.',
            requestId,
          ),
          limit,
        );
  }
  if (parsed.data.intent === 'brief_matter') {
    const disabled = rejectIfDisabled('matterBriefing', requestId);
    if (disabled !== null) return disabled;
  }

  // Aborted when the client disconnects, from either the request or the response stream.
  const connection = new AbortController();
  const disconnect = () => connection.abort();
  if (request.signal.aborted) disconnect();
  else request.signal.addEventListener('abort', disconnect, { once: true });

  const started = await auth.runtime.agent.start(parsed.data, {
    ownerId: auth.owner,
    signal: connection.signal,
    // Re-checked before every dispatch: a signed-out, expired or different session ends the run.
    sessionValid: async () => {
      const session = await auth.runtime.session(request);
      return session.ok && session.data.address.toLowerCase() === auth.owner;
    },
  });
  if (!started.ok) {
    logRun('assistant.run.rejected', requestId, started.error.code);
    return errorResponse({ ...started.error, requestId });
  }
  const { metadata, events } = started.data;
  if (events === null) {
    // A repeated request ID: the existing run's metadata, nothing run again, no result replayed.
    logRun('assistant.run.repeated', requestId);
    return jsonResponse({ ok: true, repeated: true, metadata }, 200, requestId);
  }
  logRun('assistant.run.started', requestId);
  return eventStreamResponse(events, { requestId, onDisconnect: disconnect });
});
