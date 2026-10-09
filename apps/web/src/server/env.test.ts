import { describe, expect, it } from 'vitest';
import { loadServerConfig } from './env';

describe('server configuration', () => {
  it('permits an empty environment so both shells can boot without sponsor credentials', () => {
    expect(loadServerConfig({})).toMatchObject({ ok: true });
    const result = loadServerConfig({ QWEN_API_KEY: '', ALCHEMY_MONAD_RPC_URL: '' });
    expect(result.ok && result.config.qwen).toEqual({});
  });

  it('uses the configured model verbatim and does not invent a default', () => {
    const configured = loadServerConfig({ QWEN_MODEL: 'qwen3.8-max' });
    expect(configured.ok && configured.config.qwen.model).toBe('qwen3.8-max');
    const unset = loadServerConfig({});
    expect(unset.ok && unset.config.qwen.model).toBeUndefined();
  });

  it('rejects malformed supplied values and reports names only', () => {
    const secretLooking = 'http://user:hunter2@evil.example.com/rpc';
    const result = loadServerConfig({
      ALCHEMY_MONAD_RPC_URL: secretLooking,
      DATABASE_URL: 'mysql://db/x',
      QWEN_API_KEY: 'short',
      QWEN_BASE_URL: 'ftp://example.com',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invalidKeys.sort()).toEqual([
      'ALCHEMY_MONAD_RPC_URL',
      'DATABASE_URL',
      'QWEN_API_KEY',
      'QWEN_BASE_URL',
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('short');
  });

  it('allows plain HTTP only for loopback endpoints', () => {
    expect(loadServerConfig({ QWEN_BASE_URL: 'http://localhost:8080' }).ok).toBe(true);
    expect(loadServerConfig({ QWEN_BASE_URL: 'http://api.example.com' }).ok).toBe(false);
    expect(loadServerConfig({ QWEN_BASE_URL: 'https://api.example.com/v1' }).ok).toBe(true);
  });
});
