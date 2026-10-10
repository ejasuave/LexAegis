import type { OutputMode } from '../contracts';
import type {
  ChatProvider,
  ProviderDescriptor,
  ProviderRequest,
  ProviderResult,
} from '../runtime/provider';

/*
 * lexaegis-test-only
 * SCRIPTED test provider. It answers from a fixed script and records what it was asked. It never
 * contacts a network and is labelled "scripted-test" wherever its output appears, so nothing it
 * produces can be mistaken for Qwen. Tests only.
 */

export type ScriptStep =
  | ProviderResult
  | ((request: ProviderRequest, index: number) => ProviderResult | Promise<ProviderResult>);

export interface ScriptedProvider extends ChatProvider {
  /** Every request received, in order. */
  readonly requests: ProviderRequest[];
  /** Completions that returned a result (not aborted before answering). */
  answered(): number;
}

let callCounter = 0;

/** A tool-call completion with a matching call ID. */
export const toolCall = (name: string, args: unknown, id?: string): ProviderResult => ({
  ok: true,
  requestId: `scripted-${++callCounter}`,
  returnedModel: 'scripted-test-model',
  finishReason: 'tool_calls',
  content: null,
  toolCalls: [
    {
      id: id ?? `call_${callCounter}`,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  ],
  usage: { promptTokens: 120, completionTokens: 18 },
});

export const text = (
  content: string,
  overrides: Partial<Extract<ProviderResult, { ok: true }>> = {},
): ProviderResult => ({
  ok: true,
  requestId: `scripted-${++callCounter}`,
  returnedModel: 'scripted-test-model',
  finishReason: 'stop',
  content,
  toolCalls: [],
  usage: { promptTokens: 150, completionTokens: 40 },
  ...overrides,
});

export const done = (): ProviderResult => text('DONE');
export const json = (
  value: unknown,
  overrides: Partial<Extract<ProviderResult, { ok: true }>> = {},
) => text(JSON.stringify(value), overrides);

export const failure = (
  kind: Extract<ProviderResult, { ok: false }>['failure'],
  dispatched = true,
): ProviderResult => ({ ok: false, failure: kind, requestId: null, dispatched });

/** Resolves when the request is aborted, as a real client does for an in-flight request. */
export const hangUntilAborted = (request: ProviderRequest): Promise<ProviderResult> =>
  new Promise((resolve) => {
    const finish = () => resolve(failure('aborted'));
    if (request.signal.aborted) finish();
    else request.signal.addEventListener('abort', finish, { once: true });
  });

export function createScriptedProvider(
  script: readonly ScriptStep[],
  descriptor: Partial<ProviderDescriptor> = {},
): ScriptedProvider {
  const requests: ProviderRequest[] = [];
  let answered = 0;
  const outputMode: OutputMode = descriptor.outputMode ?? 'json_schema';
  return {
    descriptor: {
      id: 'scripted-test',
      model: 'qwen3.8-max',
      region: 'test-loopback',
      fingerprint: `0x${'5c'.repeat(32)}`,
      ...descriptor,
      outputMode,
    },
    requests,
    answered: () => answered,
    async complete(request) {
      const index = requests.length;
      requests.push(request);
      const aborted = () => request.signal.aborted;
      if (aborted()) return failure('aborted', false);
      const step = script[index];
      if (step === undefined) return failure('malformed_output');
      const result = typeof step === 'function' ? await step(request, index) : step;
      if (aborted()) return failure('aborted');
      answered += 1;
      return result;
    },
  };
}
