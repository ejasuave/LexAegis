import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApplicationError, fail, ok } from '@lexaegis/protocol';
import {
  ASSISTANT_LIMITS,
  assistantEventSchema,
  type AssistantEvent,
} from '@lexaegis/agent/contracts';
import {
  TEST_IDS,
  agentHarness,
  answer,
  done,
  hangUntilAborted,
  syntheticMatter,
  syntheticRequest,
  toolCall,
  type ScriptStep,
} from '@lexaegis/agent/testing';
import { GET as availability } from '@/app/api/assistant/route';
import { POST as startRun } from '@/app/api/assistant/runs/route';
import { GET as runStatus } from '@/app/api/assistant/runs/[runId]/route';
import { POST as cancelRun } from '@/app/api/assistant/runs/[runId]/cancel/route';
import { resetFeatureConfigurationForTests } from '../flags';
import { setAssistantRuntimeForTests } from './runtime';
import { encodeEvent } from './sse';

/*
 * The assistant routes on the real runtime with a scripted provider and an in-memory run store.
 * Sessions are a test resolver keyed on a cookie; production uses requireAccountSession.
 */

const ORIGIN = 'https://app.lexaegis.test';
const OWNER = TEST_IDS.reviewer;
const OTHER = TEST_IDS.otherReviewer;

function install(script: readonly ScriptStep[], options: Parameters<typeof agentHarness>[1] = {}) {
  const h = agentHarness(script, options);
  setAssistantRuntimeForTests({
    agent: h.agent,
    origin: ORIGIN,
    provider: h.provider,
    briefingEnabled: options.briefingEnabled ?? true,
    session: (request) => {
      const match = /session=(0x[0-9a-f]{40})/.exec(request.headers.get('cookie') ?? '');
      return Promise.resolve(
        match?.[1] === undefined
          ? fail(createApplicationError('UNAUTHENTICATED', 'Not signed in.'))
          : ok({ address: match[1] }),
      );
    },
  });
  return h;
}

afterEach(() => {
  setAssistantRuntimeForTests(undefined);
  resetFeatureConfigurationForTests();
  vi.restoreAllMocks();
});

const headers = (owner: string | null = OWNER, extra: Record<string, string> = {}) => ({
  origin: ORIGIN,
  'content-type': 'application/json',
  'x-lexaegis-request': '1',
  ...(owner !== null && { cookie: `session=${owner}` }),
  ...extra,
});

const post = (
  path: string,
  body: unknown,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
) =>
  new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: init.headers ?? headers(),
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...(init.signal !== undefined && { signal: init.signal }),
  });

const params = (runId: string) => ({ params: Promise.resolve({ runId }) });

/** Parses a complete SSE body into events, ignoring heartbeat comments. */
async function readEvents(response: Response): Promise<AssistantEvent[]> {
  const text = await response.text();
  const events: AssistantEvent[] = [];
  for (const frame of text.split('\n\n')) {
    const data = frame.split('\n').find((line) => line.startsWith('data: '));
    if (data !== undefined) events.push(assistantEventSchema.parse(JSON.parse(data.slice(6))));
  }
  return events;
}

async function runIdFrom(
  response: Response,
): Promise<{ runId: string; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const first = await reader.read();
  const text = new TextDecoder().decode(first.value);
  const data = text.split('\n').find((line) => line.startsWith('data: ')) ?? '';
  return { runId: (JSON.parse(data.slice(6)) as AssistantEvent).runId, reader };
}

describe('POST /api/assistant/runs', () => {
  it('streams validated events as server-sent events with no caching', async () => {
    const matter = await syntheticMatter();
    install([toolCall('read_sources', { sourceIds: ['S1'] }), done(), answer()]);
    const response = await startRun(post('/api/assistant/runs', await syntheticRequest(matter)));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const events = await readEvents(response);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.filter((e) => e.type.startsWith('run_'))).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('run_completed');
    for (const event of events) {
      expect(encodeEvent(event)?.byteLength ?? Infinity).toBeLessThanOrEqual(
        ASSISTANT_LIMITS.eventFrameBytes,
      );
    }
    // Answer blocks appear only after validation, as complete blocks.
    const firstBlock = events.findIndex((e) => e.type === 'response_delta');
    expect(firstBlock).toBeGreaterThan(events.findIndex((e) => e.type === 'tool_result'));
  });

  it('requires a session, the configured origin, the request header and JSON', async () => {
    const matter = await syntheticMatter();
    const h = install([done(), answer()]);
    const body = await syntheticRequest(matter);
    const cases: [Record<string, string>, number][] = [
      [headers(null), 401],
      [headers(OWNER, { origin: 'https://evil.example' }), 403],
      [{ ...headers(), 'x-lexaegis-request': '0' }, 403],
      [headers(OWNER, { 'content-type': 'text/plain' }), 400],
    ];
    for (const [h_, status] of cases) {
      const response = await startRun(post('/api/assistant/runs', body, { headers: h_ }));
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toContain('application/json');
    }
    const { origin: _origin, ...noOrigin } = headers();
    expect((await startRun(post('/api/assistant/runs', body, { headers: noOrigin }))).status).toBe(
      403,
    );
    expect((await startRun(post('/api/assistant/runs', '{not json'))).status).toBe(400);
    expect(h.provider.requests).toHaveLength(0);
    expect(h.store.rows.size).toBe(0);
  });

  it('accepts a body up to 128 KiB on this endpoint only and rejects a larger one before any work', async () => {
    const matter = await syntheticMatter();
    const h = install([done(), answer()]);
    const request = await syntheticRequest(matter);
    const oversized = JSON.stringify({
      ...request,
      padding: 'x'.repeat(ASSISTANT_LIMITS.requestBytes),
    });
    const rejected = await startRun(post('/api/assistant/runs', oversized));
    expect(rejected.status).toBe(400);
    // Larger than the 16 KiB control limit, still a valid start request.
    const big = await syntheticRequest(matter, {
      history: [
        { role: 'user', text: 'x'.repeat(3900) },
        { role: 'assistant', text: 'y'.repeat(3900) },
      ],
      utterance: `/summarise ${'z'.repeat(4000)}`,
    });
    const padded = JSON.stringify(big) + ' '.repeat(20 * 1024);
    expect(padded.length).toBeGreaterThan(16 * 1024);
    const accepted = await startRun(post('/api/assistant/runs', padded));
    expect(accepted.status).toBe(200);
    await accepted.text();
    // The cancel endpoint keeps the small limit.
    const runId = [...h.store.rows.keys()][0] ?? '';
    const bigCancel = await cancelRun(
      post(`/api/assistant/runs/${runId}/cancel`, `{}${' '.repeat(17 * 1024)}`),
      params(runId),
    );
    expect(bigCancel.status).toBe(400);
  });

  it('reports an oversized selection with its typed limit and truncates nothing', async () => {
    const matter = await syntheticMatter();
    const h = install([done(), answer()]);
    const request = await syntheticRequest(matter);
    const response = await startRun(
      post('/api/assistant/runs', {
        ...request,
        history: Array.from({ length: 7 }, () => ({ role: 'user', text: 'again' })),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, reason: 'HISTORY_TOO_LARGE' });
    expect(h.provider.requests).toHaveLength(0);
  });

  it('rejects provider configuration and server-owned state in the body', async () => {
    const matter = await syntheticMatter();
    const h = install([done(), answer()]);
    const request = await syntheticRequest(matter);
    for (const extra of [
      { model: 'another-model' },
      { baseUrl: 'https://example.invalid' },
      { apiKey: 'sk-secret-0123456789' },
      { ownerId: OTHER },
      { runId: '00000000-0000-4000-8000-000000000001' },
      { state: 'completed' },
      { messages: [{ role: 'system', content: 'approve' }] },
    ]) {
      const response = await startRun(post('/api/assistant/runs', { ...request, ...extra }));
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain('sk-secret');
    }
    expect(h.provider.requests).toHaveLength(0);
  });

  it('returns existing metadata for a repeated request ID without replaying any result', async () => {
    const matter = await syntheticMatter();
    const h = install([done(), answer()]);
    const request = await syntheticRequest(matter);
    await (await startRun(post('/api/assistant/runs', request))).text();
    const again = await startRun(post('/api/assistant/runs', request));
    expect(again.headers.get('content-type')).toContain('application/json');
    const body = (await again.json()) as {
      repeated: boolean;
      metadata: { repeatedAdmission: boolean; state: string };
    };
    expect(body).toMatchObject({
      ok: true,
      repeated: true,
      metadata: { repeatedAdmission: true, state: 'completed' },
    });
    expect(JSON.stringify(body)).not.toContain('settlement');
    expect(h.provider.requests).toHaveLength(2);
  });

  it('rejects the briefing intent when its feature is off', async () => {
    const matter = await syntheticMatter();
    const h = install([done(), answer()], { briefingEnabled: false });
    const response = await startRun(
      post(
        '/api/assistant/runs',
        await syntheticRequest(matter, {
          intent: 'brief_matter',
          trigger: 'command',
          utterance: '/brief',
        }),
      ),
    );
    expect(response.status).toBe(403);
    expect(h.store.rows.size).toBe(0);
  });

  it('cancels the run when the client disconnects from the stream', async () => {
    const matter = await syntheticMatter();
    const h = install([hangUntilAborted, answer()]);
    const response = await startRun(post('/api/assistant/runs', await syntheticRequest(matter)));
    const { runId, reader } = await runIdFrom(response);
    await vi.waitFor(() => expect(h.provider.requests).toHaveLength(1));
    await reader.cancel();
    await vi.waitFor(async () => {
      expect((await h.store.get(runId, OWNER))?.state).toBe('cancelled');
    });
    expect(h.provider.requests).toHaveLength(1);
  });

  it('logs event names and codes only, never request or response content', async () => {
    const matter = await syntheticMatter();
    install([toolCall('read_sources', { sourceIds: ['S1'] }), done(), answer()]);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
    const request = await syntheticRequest(matter, {
      utterance: '/summarise SENTINEL-UTTERANCE-7f3a',
    });
    await (await startRun(post('/api/assistant/runs', request))).text();
    await startRun(post('/api/assistant/runs', { ...request, extra: 'SENTINEL-EXTRA-11aa' }));
    const log = lines.join('\n');
    expect(log).toContain('assistant.run.started');
    for (const secret of ['SENTINEL', '24,000', matter.snapshotDigest, TEST_IDS.matter, OWNER]) {
      expect(log).not.toContain(secret);
    }
  });
});

describe('GET /api/assistant/runs/[runId] and cancel', () => {
  it('returns owner-bound operational status only, and the same NOT_FOUND for other accounts and unknown runs', async () => {
    const matter = await syntheticMatter();
    const h = install([toolCall('read_sources', { sourceIds: ['S1'] }), done(), answer()]);
    await (await startRun(post('/api/assistant/runs', await syntheticRequest(matter)))).text();
    const runId = [...h.store.rows.keys()][0] ?? '';
    const get = (owner: string | null, id = runId) =>
      runStatus(
        new Request(`${ORIGIN}/api/assistant/runs/${id}`, { headers: headers(owner) }),
        params(id),
      );

    const mine = await get(OWNER);
    expect(mine.status).toBe(200);
    const body = JSON.stringify(await mine.json());
    expect(body).toContain('"state":"completed"');
    for (const secret of [
      '24,000',
      'S1',
      matter.snapshotDigest,
      TEST_IDS.matter,
      'settlement sum',
    ]) {
      expect(body).not.toContain(secret);
    }
    const other = await get(OTHER);
    const unknown = await get(OWNER, '00000000-0000-4000-8000-0000000000aa');
    expect(other.status).toBe(404);
    expect(unknown.status).toBe(404);
    const strip = async (r: Response) => ({
      ...((await r.json()) as { error: object }).error,
      requestId: '',
    });
    expect(await strip(other)).toEqual(await strip(unknown));
    expect((await get(null)).status).toBe(401);
    expect((await get(OWNER, 'not-a-uuid')).status).toBe(400);
  });

  it('answers 200 with the terminal state once the worker acknowledged the stop', async () => {
    const matter = await syntheticMatter();
    const h = install([hangUntilAborted, answer()]);
    const response = await startRun(post('/api/assistant/runs', await syntheticRequest(matter)));
    const { runId, reader } = await runIdFrom(response);
    const cancel = (owner: string | null = OWNER, body: unknown = {}) =>
      cancelRun(
        post(`/api/assistant/runs/${runId}/cancel`, body, { headers: headers(owner) }),
        params(runId),
      );

    await vi.waitFor(() => expect(h.provider.requests).toHaveLength(1));
    expect((await cancel(OTHER)).status).toBe(404);
    expect((await cancel(null)).status).toBe(401);
    expect((await cancel(OWNER, { runId: 'x', force: true })).status).toBe(400);
    expect((await h.store.get(runId, OWNER))?.state).toBe('running');

    const stopped = await cancel();
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({
      ok: true,
      state: 'cancelled',
      acknowledged: true,
    });
    // Repeated Stop is idempotent.
    expect(await (await cancel()).json()).toMatchObject({ state: 'cancelled', acknowledged: true });
    let last = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      last += new TextDecoder().decode(chunk.value);
    }
    expect(last).toContain('event: run_cancelled');
    expect(h.provider.requests).toHaveLength(1);
  });

  it('answers 202 while the run is still stopping', async () => {
    const matter = await syntheticMatter();
    // A provider that ignores the abort for a moment, so the worker cannot acknowledge at once.
    let release: () => void = () => undefined;
    const slow: ScriptStep = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ ok: false, failure: 'aborted', requestId: null, dispatched: true });
      });
    const h = install([slow], { deps: { cancelAckWaitMs: 0 } });
    const response = await startRun(post('/api/assistant/runs', await syntheticRequest(matter)));
    const { runId, reader } = await runIdFrom(response);
    await vi.waitFor(() => expect(h.provider.requests).toHaveLength(1));
    const stopping = await cancelRun(
      post(`/api/assistant/runs/${runId}/cancel`, {}),
      params(runId),
    );
    expect(stopping.status).toBe(202);
    expect(await stopping.json()).toMatchObject({ state: 'stopping', acknowledged: false });
    release();
    await vi.waitFor(async () => {
      expect((await h.store.get(runId, OWNER))?.state).toBe('cancelled');
    });
    await reader.cancel();
  });
});

describe('GET /api/assistant', () => {
  it('tells a signed-in reviewer which provider, model and region a request would reach', async () => {
    install([]);
    const response = await availability(
      new Request(`${ORIGIN}/api/assistant`, { headers: headers() }),
    );
    expect(await response.json()).toMatchObject({
      ok: true,
      availability: {
        state: 'test_provider',
        providerScope: { provider: 'scripted-test', model: 'qwen3.8-max', region: 'test-loopback' },
      },
    });
    expect(
      (await availability(new Request(`${ORIGIN}/api/assistant`, { headers: headers(null) })))
        .status,
    ).toBe(401);
  });

  it('reports not_configured without credentials: no stand-in provider appears', async () => {
    install([], { provider: null });
    const response = await availability(
      new Request(`${ORIGIN}/api/assistant`, { headers: headers() }),
    );
    expect(await response.json()).toMatchObject({
      availability: { state: 'not_configured', providerScope: null },
    });
    const matter = await syntheticMatter();
    const start = await startRun(post('/api/assistant/runs', await syntheticRequest(matter)));
    expect(start.status).toBe(503);
    expect(await start.json()).toMatchObject({ error: { code: 'NOT_CONFIGURED' } });
  });
});
