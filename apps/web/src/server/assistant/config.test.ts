import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '../env';
import { resolveAssistantProvider } from './config';

const KEY = 'sk-qwen-secret-0123456789';
const URL = 'https://ws1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';

function resolve(env: Record<string, string>) {
  const loaded = loadServerConfig(env);
  if (!loaded.ok) return { state: 'env_invalid' as const, keys: loaded.invalidKeys };
  return resolveAssistantProvider(loaded.config);
}

describe('assistant provider configuration', () => {
  it('is not configured without credentials; local review tools need none', () => {
    expect(resolve({})).toEqual({ state: 'not_configured' });
    expect(resolve({ QWEN_MODEL: 'qwen3.8-max', QWEN_BASE_URL: URL })).toEqual({
      state: 'not_configured',
    });
  });

  it('uses the configured model exactly, defaults to qwen3.8-max and json_schema, and never another provider', () => {
    expect(resolve({ QWEN_API_KEY: KEY, QWEN_BASE_URL: URL })).toMatchObject({
      state: 'ready',
      provider: {
        id: 'qwen',
        model: 'qwen3.8-max',
        outputMode: 'json_schema',
        endpoint: { region: 'ap-southeast-1' },
      },
    });
    expect(
      resolve({
        QWEN_API_KEY: KEY,
        QWEN_BASE_URL: URL,
        QWEN_MODEL: 'qwen3.8-max-0902',
        QWEN_OUTPUT_MODE: 'json_object',
      }),
    ).toMatchObject({ provider: { model: 'qwen3.8-max-0902', outputMode: 'json_object' } });
  });

  it('rejects an endpoint that is not a documented Qwen host, and an unknown output mode', () => {
    for (const url of [
      'https://api.openai.com/v1',
      'https://example.com/compatible-mode/v1',
      'http://127.0.0.1:4000/compatible-mode/v1',
    ]) {
      expect(resolve({ QWEN_API_KEY: KEY, QWEN_BASE_URL: url })).toEqual({
        state: 'env_invalid',
        keys: ['QWEN_BASE_URL'],
      });
    }
    expect(resolve({ QWEN_API_KEY: KEY, QWEN_BASE_URL: URL, QWEN_OUTPUT_MODE: 'auto' })).toEqual({
      state: 'env_invalid',
      keys: ['QWEN_OUTPUT_MODE'],
    });
  });

  it('keeps the scripted test provider separate from any real credential', () => {
    const test = {
      LEXAEGIS_TEST_MODE: 'scripted-assistant',
      ASSISTANT_TEST_PROVIDER_URL: 'http://127.0.0.1:4011/compatible-mode/v1',
    };
    expect(resolve(test)).toMatchObject({
      state: 'ready',
      provider: { id: 'scripted-test', endpoint: { region: 'test-loopback' } },
    });
    expect(resolve({ ...test, QWEN_API_KEY: KEY })).toEqual({
      state: 'invalid',
      reason: 'TEST_MODE_WITH_API_KEY',
    });
    expect(resolve({ LEXAEGIS_TEST_MODE: 'scripted-assistant' })).toEqual({
      state: 'invalid',
      reason: 'TEST_ENDPOINT',
    });
    // Without the explicit mode, a test endpoint alone enables nothing.
    expect(resolve({ ASSISTANT_TEST_PROVIDER_URL: test.ASSISTANT_TEST_PROVIDER_URL })).toEqual({
      state: 'not_configured',
    });
    expect(
      resolve({ ...test, ASSISTANT_TEST_PROVIDER_URL: 'https://example.com/compatible-mode/v1' }),
    ).toMatchObject({
      state: 'env_invalid',
    });
  });
});
