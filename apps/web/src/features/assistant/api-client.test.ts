import { describe, expect, it } from 'vitest';
import { syntheticMatter, syntheticRequest } from '@lexaegis/agent/testing';
import { createAssistantTransport, type FetchLike } from './api-client';
import type { SseItem } from './sse-reader';

const RUN = '11111111-2222-4333-8444-555555555555';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

function recording(respond: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(respond(url, init));
  };
  return { calls, transport: createAssistantTransport(fetchImpl) };
}

describe('assistant runtime client', () => {
  it('sends private data only in a same-origin POST body, never in a URL', async () => {
    const matter = await syntheticMatter();
    const request = await syntheticRequest(matter);
    const stream = new Response('id: 1\nevent: x\ndata: {"a":1}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
    const { calls, transport } = recording((url) =>
      url === '/api/assistant/runs'
        ? stream
        : json({ ok: true, state: 'cancelled', acknowledged: true }),
    );
    const started = await transport.start(request, new AbortController().signal);
    expect(started.kind).toBe('stream');
    const items: SseItem[] = [];
    if (started.kind === 'stream') for await (const item of started.events) items.push(item);
    expect(items).toEqual([{ kind: 'event', data: '{"a":1}' }]);
    await transport.cancel(RUN);
    await transport.status(RUN);

    expect(calls.map((call) => call.url)).toEqual([
      '/api/assistant/runs',
      `/api/assistant/runs/${RUN}/cancel`,
      `/api/assistant/runs/${RUN}`,
    ]);
    for (const { url } of calls) {
      expect(url).not.toMatch(/[?#]/);
      expect(url).not.toContain(matter.refs.total.quote);
      expect(url).not.toContain(request.matterId);
    }
    const [start, cancel, status] = calls;
    expect(start?.init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    expect(start?.init?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-lexaegis-request': '1',
    });
    const sent = start?.init?.body;
    expect(JSON.parse(typeof sent === 'string' ? sent : '')).toEqual(request);
    expect(cancel?.init).toMatchObject({ method: 'POST', body: '{}' });
    expect(status?.init?.method).toBeUndefined();
  });

  it('maps a repeated admission, typed failures and an unreachable service without guessing', async () => {
    const matter = await syntheticMatter();
    const request = await syntheticRequest(matter);
    const signal = new AbortController().signal;
    const metadata = {
      schema: 'lexaegis.agent-run-metadata.v1',
      runId: RUN,
      clientRequestId: request.clientRequestId,
      state: 'completed',
      outcome: 'completed',
      cancelRequested: false,
      repeatedAdmission: true,
      createdAt: '2026-10-10T09:05:11.000Z',
      updatedAt: '2026-10-10T09:05:12.000Z',
      deadlineAt: '2026-10-10T09:07:11.000Z',
      usage: {
        provenance: 'none',
        providerAttempts: 0,
        toolExecutions: 0,
        reservedInputTokens: 0,
        reservedOutputTokens: 0,
        inputEstimate: 'none',
        reportedInputTokens: null,
        reportedOutputTokens: null,
      },
    };
    const repeated = recording(() => json({ ok: true, repeated: true, metadata }));
    expect(await repeated.transport.start(request, signal)).toMatchObject({
      kind: 'repeated',
      metadata: { repeatedAdmission: true },
    });

    const limited = recording(() =>
      json(
        {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'The request is too large. Select less and try again.',
            requestId: 'r1',
          },
          reason: 'CONTEXT_TOO_LARGE',
        },
        400,
      ),
    );
    expect(await limited.transport.start(request, signal)).toEqual({
      kind: 'error',
      code: 'INVALID_INPUT',
      message: 'The request is too large. Select less and try again.',
      reason: 'CONTEXT_TOO_LARGE',
    });

    const signedOut = recording(() =>
      json(
        {
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Not signed in.', requestId: 'r2' },
        },
        401,
      ),
    );
    expect(await signedOut.transport.availability()).toMatchObject({
      ok: false,
      code: 'UNAUTHENTICATED',
    });

    const html = recording(() => new Response('<html>502</html>', { status: 502 }));
    expect(await html.transport.status(RUN)).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
    const down = createAssistantTransport(() => Promise.reject(new TypeError('network')));
    expect(await down.start(request, signal)).toMatchObject({ kind: 'error', code: 'UNAVAILABLE' });
    expect(await down.cancel(RUN)).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
    // A success body that does not match the contract is not trusted as a state.
    const odd = recording(() => json({ ok: true, state: 'approved', acknowledged: true }));
    expect(await odd.transport.cancel(RUN)).toMatchObject({ ok: false });
  });
});
