import 'server-only';
import { validateQwenBaseUrl, validateTestBaseUrl, type QwenProviderConfig } from '@lexaegis/agent';
import type { ServerConfig } from '../env';

/*
 * Resolves the one provider configuration the server may use. The model and endpoint come from
 * operator configuration only. The scripted test mode is a separate, explicit setting: it needs
 * a loopback endpoint and refuses to coexist with a real API key, so a test double can never
 * stand in for Qwen in a deployment that has credentials.
 */

export const DEFAULT_QWEN_MODEL = 'qwen3.8-max';

export type AssistantProvider =
  | { readonly state: 'not_configured' }
  | {
      readonly state: 'invalid';
      readonly reason: 'ENDPOINT' | 'TEST_MODE_WITH_API_KEY' | 'TEST_ENDPOINT';
    }
  | { readonly state: 'ready'; readonly provider: QwenProviderConfig };

export function resolveAssistantProvider(config: ServerConfig): AssistantProvider {
  const { qwen, assistant } = config;
  // json_schema unless the operator explicitly configures the JSON-object mode. Never switched at run time.
  const outputMode = qwen.outputMode === 'json_object' ? 'json_object' : 'json_schema';
  const model = qwen.model ?? DEFAULT_QWEN_MODEL;

  if (assistant.testMode === 'scripted-assistant') {
    if (qwen.apiKey !== undefined) return { state: 'invalid', reason: 'TEST_MODE_WITH_API_KEY' };
    const endpoint = validateTestBaseUrl(assistant.testProviderUrl ?? '');
    if (!endpoint.ok) return { state: 'invalid', reason: 'TEST_ENDPOINT' };
    return {
      state: 'ready',
      provider: {
        id: 'scripted-test',
        apiKey: 'scripted-test-no-key',
        endpoint,
        model,
        outputMode,
      },
    };
  }

  if (qwen.apiKey === undefined || qwen.baseUrl === undefined) return { state: 'not_configured' };
  const endpoint = validateQwenBaseUrl(qwen.baseUrl);
  if (!endpoint.ok) return { state: 'invalid', reason: 'ENDPOINT' };
  return {
    state: 'ready',
    provider: { id: 'qwen', apiKey: qwen.apiKey, endpoint, model, outputMode },
  };
}
