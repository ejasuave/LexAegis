import { describe, expect, it } from 'vitest';
import type { ProviderRequest } from '../runtime/provider';
import { providerTool } from '../runtime/tool-schemas';
import {
  PROVIDER_RESPONSE_LIMIT_BYTES,
  configFingerprint,
  createQwenProvider,
  requestBody,
  validateQwenBaseUrl,
  validateTestBaseUrl,
  type FetchLike,
  type QwenProviderConfig,
} from './qwen-client';

const KEY = 'sk-test-canary-0123456789';
const endpoint = validateQwenBaseUrl(
  'https://ws-abc123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
);
if (!endpoint.ok) throw new Error(endpoint.reason);
const config: QwenProviderConfig = {
  id: 'qwen',
  apiKey: KEY,
  endpoint,
  model: 'qwen3.8-max',
  outputMode: 'json_schema',
};

const request = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  purpose: 'final',
  messages: [{ role: 'user', content: 'synthetic' }],
  maxCompletionTokens: 2048,
  timeoutMs: 25_000,
  signal: new AbortController().signal,
  ...overrides,
});

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

const completion = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-synthetic-1',
  model: 'qwen3.8-max-0902',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', ...message } }],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  ...extra,
});

function recording(respond: (init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond(init);
  };
  return { calls, fetchImpl };
}

describe('endpoint validation', () => {
  it('accepts the documented workspace and legacy hosts and derives the region', () => {
    for (const region of [
      'ap-southeast-1',
      'us-east-1',
      'cn-beijing',
      'cn-hongkong',
      'eu-central-1',
      'ap-northeast-1',
    ]) {
      expect(
        validateQwenBaseUrl(`https://ws1.${region}.maas.aliyuncs.com/compatible-mode/v1`),
      ).toMatchObject({
        ok: true,
        region,
        completionsUrl: `https://ws1.${region}.maas.aliyuncs.com/compatible-mode/v1/chat/completions`,
      });
    }
    expect(
      validateQwenBaseUrl('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/'),
    ).toMatchObject({
      ok: true,
      region: 'ap-southeast-1',
    });
    expect(validateQwenBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1')).toMatchObject({
      region: 'cn-beijing',
    });
  });

  it('rejects other hosts, schemes, paths, ports, queries and embedded credentials', () => {
    const cases: [string, string][] = [
      ['http://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'NOT_HTTPS'],
      ['https://example.com/compatible-mode/v1', 'HOST_NOT_ALLOWED'],
      [
        'https://ws1.ap-southeast-1.maas.aliyuncs.com.evil.example/compatible-mode/v1',
        'HOST_NOT_ALLOWED',
      ],
      ['https://ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', 'HOST_NOT_ALLOWED'],
      ['https://ws1.mars-north-9.maas.aliyuncs.com/compatible-mode/v1', 'HOST_NOT_ALLOWED'],
      ['https://api.openai.com/v1', 'HOST_NOT_ALLOWED'],
      ['https://dashscope-intl.aliyuncs.com/v1', 'PATH_NOT_ALLOWED'],
      [
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
        'PATH_NOT_ALLOWED',
      ],
      ['https://dashscope-intl.aliyuncs.com:8443/compatible-mode/v1', 'PORT_NOT_ALLOWED'],
      ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1?x=1', 'QUERY_NOT_ALLOWED'],
      ['https://user:pw@dashscope-intl.aliyuncs.com/compatible-mode/v1', 'CREDENTIALS_IN_URL'],
      ['not a url', 'INVALID_URL'],
    ];
    for (const [url, reason] of cases)
      expect(validateQwenBaseUrl(url)).toEqual({ ok: false, reason });
  });

  it('accepts a test endpoint only on plain loopback with a port', () => {
    expect(validateTestBaseUrl('http://127.0.0.1:4010/compatible-mode/v1')).toMatchObject({
      ok: true,
      region: 'test-loopback',
    });
    for (const url of [
      'http://localhost:4010/compatible-mode/v1',
      'http://192.168.1.4:4010/compatible-mode/v1',
      'https://127.0.0.1:4010/compatible-mode/v1',
      'http://127.0.0.1/compatible-mode/v1',
      'http://127.0.0.1:4010/other',
    ]) {
      expect(validateTestBaseUrl(url).ok).toBe(false);
    }
    // A loopback URL is never a valid Qwen endpoint.
    expect(validateQwenBaseUrl('http://127.0.0.1:4010/compatible-mode/v1').ok).toBe(false);
  });

  it('gives a different fingerprint for a different endpoint, model or output mode', () => {
    const other = validateQwenBaseUrl('https://ws1.us-east-1.maas.aliyuncs.com/compatible-mode/v1');
    if (!other.ok) throw new Error(other.reason);
    const prints = new Set([
      configFingerprint(config),
      configFingerprint({ ...config, model: 'qwen3.8-max-0902' }),
      configFingerprint({ ...config, outputMode: 'json_object' }),
      configFingerprint({ ...config, endpoint: other }),
    ]);
    expect(prints.size).toBe(4);
    expect([...prints].join('')).not.toContain('ws-abc123');
  });
});

describe('request construction', () => {
  it('disables thinking, search, streaming and parallel calls, and uses max_completion_tokens', () => {
    const body = requestBody('qwen3.8-max', request({ tools: [providerTool('get_status')] }));
    expect(body).toMatchObject({
      model: 'qwen3.8-max',
      stream: false,
      temperature: 0,
      max_completion_tokens: 2048,
      enable_thinking: false,
      enable_search: false,
      parallel_tool_calls: false,
    });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('extra_body');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('keeps tools off the structured round and requests a strict schema', () => {
    const body = requestBody(
      'qwen3.8-max',
      request({
        responseFormat: { mode: 'json_schema', name: 'aegis_answer', schema: { type: 'object' } },
      }),
    );
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('parallel_tool_calls');
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'aegis_answer', strict: true, schema: { type: 'object' } },
    });
    expect(
      requestBody('m', request({ responseFormat: { mode: 'json_object' } })).response_format,
    ).toEqual({
      type: 'json_object',
    });
  });

  it('sends native tool-call messages with matching tool_call_id values', () => {
    const body = requestBody(
      'qwen3.8-max',
      request({
        messages: [
          { role: 'system', content: 'policy' },
          { role: 'user', content: 'question' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [{ id: 'call_9', name: 'get_status', arguments: '{"scope":"matter"}' }],
          },
          { role: 'tool', toolCallId: 'call_9', content: '{"handle":"T1"}' },
        ],
      }),
    );
    expect(body.messages).toEqual([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_9',
            type: 'function',
            function: { name: 'get_status', arguments: '{"scope":"matter"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_9', content: '{"handle":"T1"}' },
    ]);
  });

  it('posts once to the fixed URL with no redirects, a bearer key and the abort signal', async () => {
    const { calls, fetchImpl } = recording(() => reply(completion({ content: 'ok' })));
    const provider = createQwenProvider(config, fetchImpl);
    expect(provider.descriptor).toMatchObject({
      id: 'qwen',
      region: 'ap-southeast-1',
      model: 'qwen3.8-max',
    });
    expect(JSON.stringify(provider.descriptor)).not.toContain('ws-abc123');
    const result = await provider.complete(request());
    expect(result).toMatchObject({ ok: true, content: 'ok', finishReason: 'stop' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(endpoint.completionsUrl);
    expect(calls[0]?.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('response handling', () => {
  it('captures request ID, returned model, finish reason and actual usage, and discards reasoning', async () => {
    const { fetchImpl } = recording(() =>
      reply(completion({ content: '{"a":1}', reasoning_content: 'private chain of thought' })),
    );
    const result = await createQwenProvider(config, fetchImpl).complete(request());
    expect(result).toEqual({
      ok: true,
      requestId: 'chatcmpl-synthetic-1',
      returnedModel: 'qwen3.8-max-0902',
      finishReason: 'stop',
      content: '{"a":1}',
      toolCalls: [],
      usage: { promptTokens: 11, completionTokens: 7 },
    });
    expect(JSON.stringify(result)).not.toContain('chain of thought');
  });

  it('leaves usage unknown when the provider reports none, and keeps length distinct from stop', async () => {
    const body = completion({ content: '{"trunc' }, { usage: undefined });
    (body.choices[0] as { finish_reason: string }).finish_reason = 'length';
    const { fetchImpl } = recording(() => reply(body));
    expect(await createQwenProvider(config, fetchImpl).complete(request())).toMatchObject({
      ok: true,
      finishReason: 'length',
      usage: null,
    });
  });

  it('returns native tool calls as unparsed requests', async () => {
    const { fetchImpl } = recording(() =>
      reply(
        completion({
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read_sources', arguments: '{"sourceIds":["S1"]}' },
            },
          ],
        }),
      ),
    );
    expect(await createQwenProvider(config, fetchImpl).complete(request())).toMatchObject({
      ok: true,
      toolCalls: [{ id: 'call_1', name: 'read_sources', arguments: '{"sourceIds":["S1"]}' }],
    });
  });

  it('classifies failures without retrying or exposing the body, key or URL', async () => {
    const cases: [number, unknown, string][] = [
      [401, { error: { code: 'InvalidApiKey', message: `bad key ${KEY}` } }, 'authentication'],
      [403, { error: { code: 'AccessDenied' } }, 'authentication'],
      [429, { error: { code: 'Throttling.RateQuota' } }, 'rate_limit'],
      [
        400,
        { error: { code: 'InvalidParameter', message: 'response_format unsupported' } },
        'capability',
      ],
      [404, { error: { code: 'ModelNotFound' } }, 'capability'],
      [400, { error: { code: 'DataInspectionFailed' } }, 'refusal'],
      [504, 'gateway timeout', 'timeout'],
      [500, { error: { code: 'InternalError' } }, 'transport'],
    ];
    for (const [status, body, failure] of cases) {
      const { calls, fetchImpl } = recording(() => reply(body, status));
      const result = await createQwenProvider(config, fetchImpl).complete(request());
      expect(result).toEqual({ ok: false, failure, requestId: null, dispatched: true });
      expect(calls).toHaveLength(1);
      const text = JSON.stringify(result);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain('aliyuncs');
    }
  });

  it('treats a refusal, a content filter and malformed JSON as failures', async () => {
    for (const [body, failure] of [
      [completion({ content: null, refusal: 'I cannot help with that.' }), 'refusal'],
      [
        {
          ...completion({ content: 'x' }),
          choices: [{ finish_reason: 'content_filter', message: { content: '' } }],
        },
        'refusal',
      ],
      ['<html>not json</html>', 'malformed_output'],
      [{ id: 'x', choices: [] }, 'malformed_output'],
      [
        completion({
          content: null,
          tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: { a: 1 } } }],
        }),
        'malformed_output',
      ],
    ] as const) {
      const { fetchImpl } = recording(() => reply(body));
      expect(await createQwenProvider(config, fetchImpl).complete(request())).toMatchObject({
        ok: false,
        failure,
      });
    }
  });

  it('abandons a response larger than 128 KiB before parsing it', async () => {
    const huge = JSON.stringify(completion({ content: 'x'.repeat(PROVIDER_RESPONSE_LIMIT_BYTES) }));
    const variants: Record<string, string>[] = [{}, { 'content-length': String(huge.length) }];
    for (const headers of variants) {
      const { fetchImpl } = recording(() => reply(huge, 200, headers));
      expect(await createQwenProvider(config, fetchImpl).complete(request())).toMatchObject({
        ok: false,
        failure: 'malformed_output',
      });
    }
  });

  it('reports a redirect or network error as transport, possibly billed', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.reject(new TypeError('redirect mode is set to error'));
    expect(await createQwenProvider(config, fetchImpl).complete(request())).toEqual({
      ok: false,
      failure: 'transport',
      requestId: null,
      dispatched: true,
    });
  });
});

describe('cancellation and timeout', () => {
  const hanging: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });

  it('does not dispatch an already cancelled request', async () => {
    const { calls, fetchImpl } = recording(() => reply(completion({ content: 'late' })));
    const controller = new AbortController();
    controller.abort();
    expect(
      await createQwenProvider(config, fetchImpl).complete(request({ signal: controller.signal })),
    ).toEqual({
      ok: false,
      failure: 'aborted',
      requestId: null,
      dispatched: false,
    });
    expect(calls).toHaveLength(0);
  });

  it('aborts an in-flight request and reports it as aborted, possibly billed', async () => {
    const controller = new AbortController();
    const pending = createQwenProvider(config, hanging).complete(
      request({ signal: controller.signal }),
    );
    controller.abort();
    expect(await pending).toEqual({
      ok: false,
      failure: 'aborted',
      requestId: null,
      dispatched: true,
    });
  });

  it('enforces the per-attempt timeout as a timeout, not a cancellation', async () => {
    expect(
      await createQwenProvider(config, hanging).complete(request({ timeoutMs: 20 })),
    ).toMatchObject({
      ok: false,
      failure: 'timeout',
    });
  });
});
