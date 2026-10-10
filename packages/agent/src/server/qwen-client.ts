import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { OutputMode, ProviderId } from '../contracts';
import type {
  ChatMessage,
  ChatProvider,
  ProviderFailure,
  ProviderRequest,
  ProviderResult,
} from '../runtime/provider';

/*
 * Text-only adapter for the Qwen OpenAI-compatible Chat Completions API. One operator-configured
 * endpoint and model; no caller can choose either. No SDK, no implicit retry, no redirect, no
 * streaming upstream, no web search, no thinking mode and no parallel tool calls. Errors carry a
 * class only: never a response body, a prompt, the endpoint URL, a header or a workspace ID.
 */

export const PROVIDER_RESPONSE_LIMIT_BYTES = 128 * 1024;

const REGIONS = [
  'ap-southeast-1',
  'us-east-1',
  'cn-beijing',
  'cn-hongkong',
  'eu-central-1',
  'ap-northeast-1',
] as const;

/** Hosts from the provider documentation read on 2026-10-10 (page dated 28 September 2026). */
const WORKSPACE_HOST = new RegExp(
  `^[a-z0-9][a-z0-9-]{0,62}\\.(${REGIONS.join('|')})\\.maas\\.aliyuncs\\.com$`,
);
const LEGACY_HOSTS: Readonly<Record<string, string>> = {
  'dashscope.aliyuncs.com': 'cn-beijing',
  'dashscope-intl.aliyuncs.com': 'ap-southeast-1',
  'cn-hongkong.dashscope.aliyuncs.com': 'cn-hongkong',
};
const COMPATIBLE_PATH = '/compatible-mode/v1';

export type EndpointFailure =
  | 'INVALID_URL'
  | 'NOT_HTTPS'
  | 'CREDENTIALS_IN_URL'
  | 'PORT_NOT_ALLOWED'
  | 'HOST_NOT_ALLOWED'
  | 'PATH_NOT_ALLOWED'
  | 'QUERY_NOT_ALLOWED';

export interface ValidEndpoint {
  /** The exact chat-completions URL requests go to. Never logged or returned to a client. */
  readonly completionsUrl: string;
  /** Region identifier from the host. It names an endpoint, not where data is processed. */
  readonly region: string;
  readonly host: string;
}

export type EndpointCheck =
  | ({ readonly ok: true } & ValidEndpoint)
  | { readonly ok: false; readonly reason: EndpointFailure };

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

const pathOk = (url: URL) =>
  url.pathname === COMPATIBLE_PATH || url.pathname === `${COMPATIBLE_PATH}/`;

/** Validates the operator's base URL against the documented provider hosts and path. */
export function validateQwenBaseUrl(raw: string): EndpointCheck {
  const url = parse(raw);
  if (url === null) return { ok: false, reason: 'INVALID_URL' };
  if (url.protocol !== 'https:') return { ok: false, reason: 'NOT_HTTPS' };
  if (url.username !== '' || url.password !== '')
    return { ok: false, reason: 'CREDENTIALS_IN_URL' };
  if (url.port !== '') return { ok: false, reason: 'PORT_NOT_ALLOWED' };
  if (url.search !== '' || url.hash !== '') return { ok: false, reason: 'QUERY_NOT_ALLOWED' };
  const host = url.hostname.toLowerCase();
  const region = WORKSPACE_HOST.exec(host)?.[1] ?? LEGACY_HOSTS[host];
  if (region === undefined) return { ok: false, reason: 'HOST_NOT_ALLOWED' };
  if (!pathOk(url)) return { ok: false, reason: 'PATH_NOT_ALLOWED' };
  return {
    ok: true,
    completionsUrl: `https://${host}${COMPATIBLE_PATH}/chat/completions`,
    region,
    host,
  };
}

/**
 * The loopback endpoint of a scripted test provider. Plain HTTP on 127.0.0.1 only; it is accepted
 * solely in the explicit scripted test mode and always reports the region "test-loopback".
 */
export function validateTestBaseUrl(raw: string): EndpointCheck {
  const url = parse(raw);
  if (url === null) return { ok: false, reason: 'INVALID_URL' };
  if (url.username !== '' || url.password !== '')
    return { ok: false, reason: 'CREDENTIALS_IN_URL' };
  if (url.search !== '' || url.hash !== '') return { ok: false, reason: 'QUERY_NOT_ALLOWED' };
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '')
    return { ok: false, reason: 'HOST_NOT_ALLOWED' };
  if (!pathOk(url)) return { ok: false, reason: 'PATH_NOT_ALLOWED' };
  return {
    ok: true,
    completionsUrl: `http://127.0.0.1:${url.port}${COMPATIBLE_PATH}/chat/completions`,
    region: 'test-loopback',
    host: `127.0.0.1:${url.port}`,
  };
}

export interface QwenProviderConfig {
  readonly id: ProviderId;
  readonly apiKey: string;
  readonly endpoint: ValidEndpoint;
  readonly model: string;
  readonly outputMode: OutputMode;
}

/** A changed endpoint, model or output mode is a different configuration and needs new verification. */
export function configFingerprint(
  config: Pick<QwenProviderConfig, 'id' | 'endpoint' | 'model' | 'outputMode'>,
): string {
  return `0x${createHash('sha256')
    .update(
      [config.id, config.endpoint.host, COMPATIBLE_PATH, config.model, config.outputMode].join(
        '\n',
      ),
    )
    .digest('hex')}`;
}

// Only the fields the runtime uses are read. Anything else, including reasoning text, is discarded.
const completionSchema = z.object({
  id: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().max(40).nullish(),
        message: z.object({
          content: z.string().nullish(),
          refusal: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1).max(200),
                type: z.literal('function'),
                function: z.object({ name: z.string().min(1).max(200), arguments: z.string() }),
              }),
            )
            .nullish(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().min(0),
      completion_tokens: z.number().int().min(0),
    })
    .nullish(),
});

const errorSchema = z.object({
  error: z.object({ code: z.string().max(120).nullish(), type: z.string().max(120).nullish() }),
});

function wireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool')
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content ?? '',
      ...(message.toolCalls.length > 0 && {
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      }),
    };
  }
  return { role: message.role, content: message.content };
}

/** The exact request body. Non-standard parameters sit at the top level, as raw HTTP requires. */
export function requestBody(model: string, request: ProviderRequest): Record<string, unknown> {
  const format = request.responseFormat;
  return {
    model,
    messages: request.messages.map(wireMessage),
    stream: false,
    temperature: 0,
    max_completion_tokens: request.maxCompletionTokens,
    enable_thinking: false,
    enable_search: false,
    ...(request.tools !== undefined &&
      request.tools.length > 0 && {
        tools: request.tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
        parallel_tool_calls: false,
      }),
    ...(format !== undefined && {
      response_format:
        format.mode === 'json_schema'
          ? {
              type: 'json_schema',
              json_schema: { name: format.name, strict: true, schema: format.schema },
            }
          : { type: 'json_object' },
    }),
  };
}

/** Reads at most `limit` bytes. A larger body is abandoned, never parsed in part. */
async function readBounded(response: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

function classifyStatus(status: number, body: unknown): ProviderFailure {
  const parsed = errorSchema.safeParse(body);
  const code = parsed.success
    ? `${parsed.data.error.code ?? ''} ${parsed.data.error.type ?? ''}`.toLowerCase()
    : '';
  if (/inspection|content_filter|moderation/.test(code)) return 'refusal';
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'transport';
  // 400, 404, 422 and the rest: the model, a parameter or a schema was not accepted.
  return 'capability';
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function createQwenProvider(
  config: QwenProviderConfig,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): ChatProvider {
  const descriptor = Object.freeze({
    id: config.id,
    model: config.model,
    region: config.endpoint.region,
    outputMode: config.outputMode,
    fingerprint: configFingerprint(config),
  });

  async function complete(request: ProviderRequest): Promise<ProviderResult> {
    const failed = (
      failure: ProviderFailure,
      dispatched: boolean,
      requestId: string | null = null,
    ) => ({ ok: false, failure, requestId, dispatched }) as const;
    if (request.signal.aborted) return failed('aborted', false);
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = AbortSignal.any([request.signal, timeout]);
    const interrupted = () => (request.signal.aborted ? 'aborted' : 'timeout');

    let response: Response;
    try {
      response = await fetchImpl(config.endpoint.completionsUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(requestBody(config.model, request)),
        redirect: 'error',
        cache: 'no-store',
        signal,
      });
    } catch {
      // The request may have reached the provider before it failed, so it may be billed.
      return failed(signal.aborted ? interrupted() : 'transport', true);
    }

    let bytes: Uint8Array | null;
    try {
      bytes = await readBounded(response, PROVIDER_RESPONSE_LIMIT_BYTES);
    } catch {
      return failed(signal.aborted ? interrupted() : 'transport', true);
    }
    if (bytes === null) return failed('malformed_output', true);
    const body = parseJson(bytes);
    if (!response.ok) return failed(classifyStatus(response.status, body), true);

    const parsed = completionSchema.safeParse(body);
    if (!parsed.success) return failed('malformed_output', true);
    const completion = parsed.data;
    const requestId = completion.id ?? null;
    const choice = completion.choices[0];
    if (choice === undefined) return failed('malformed_output', true, requestId);
    if ((choice.message.refusal ?? '') !== '' || choice.finish_reason === 'content_filter')
      return failed('refusal', true, requestId);
    const reason = choice.finish_reason;
    return {
      ok: true,
      requestId,
      returnedModel: completion.model ?? null,
      finishReason:
        reason === 'stop' || reason === 'length' || reason === 'tool_calls' ? reason : 'other',
      content: choice.message.content ?? null,
      toolCalls: (choice.message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      usage:
        completion.usage == null
          ? null
          : {
              promptTokens: completion.usage.prompt_tokens,
              completionTokens: completion.usage.completion_tokens,
            },
    };
  }

  return { descriptor, complete };
}
