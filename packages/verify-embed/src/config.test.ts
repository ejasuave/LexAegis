import { describe, expect, it } from 'vitest';
import { resolveHostConfig } from './config';
import { HOST, POLICY } from './test-helpers';

describe('host configuration', () => {
  it('is unknown-by-default: missing configuration is a typed reason, not a default', () => {
    expect(resolveHostConfig(undefined)).toEqual({ ok: false, reason: 'CONFIG_MISSING' });
    expect(resolveHostConfig(null)).toEqual({ ok: false, reason: 'CONFIG_MISSING' });
  });

  it('accepts an explicit deployment record with an HTTPS endpoint', () => {
    const result = resolveHostConfig(HOST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.deployments.size).toBe(1);
      expect(result.config.packageOrigins.has('https://packages.example.invalid')).toBe(true);
      expect(result.config.rpcOrigins.has('https://rpc.example.invalid')).toBe(true);
    }
  });

  it.each([
    ['unknown field', { ...HOST, extra: 1 }],
    ['no deployments', { deployments: [] }],
    [
      'a bad policy',
      { deployments: [{ policy: { ...POLICY, chainId: '010143' }, rpcUrl: 'https://r.invalid/' }] },
    ],
  ])('rejects %s', (_name, input) => {
    expect(resolveHostConfig(input)).toEqual({ ok: false, reason: 'CONFIG_INVALID' });
  });

  it.each([
    'http://rpc.example.invalid/',
    'https://user:secret@rpc.example.invalid/',
    'https://rpc.example.invalid/?key=abc',
    'http://127.0.0.1:8545/',
  ])('rejects the RPC endpoint %s without the local-test switch', (rpcUrl) => {
    expect(resolveHostConfig({ deployments: [{ policy: POLICY, rpcUrl }] })).toEqual({
      ok: false,
      reason: 'CONFIG_RPC_REJECTED',
    });
  });

  it('allows loopback HTTP only with the explicit local-test switch', () => {
    const input = {
      deployments: [{ policy: POLICY, rpcUrl: 'http://127.0.0.1:8545/' }],
      allowLoopbackHttp: true,
    };
    expect(resolveHostConfig(input).ok).toBe(true);
    expect(resolveHostConfig({ ...input, rpcOrigins: ['http://rpc.example.invalid'] })).toEqual({
      ok: false,
      reason: 'CONFIG_ORIGIN_REJECTED',
    });
  });

  it.each(['https://p.invalid/path', 'https://u:p@p.invalid', 'ftp://p.invalid', 'nope'])(
    'rejects the package origin %s',
    (origin) => {
      expect(resolveHostConfig({ ...HOST, packageOrigins: [origin] })).toEqual({
        ok: false,
        reason: 'CONFIG_ORIGIN_REJECTED',
      });
    },
  );

  it('rejects a duplicated deployment', () => {
    const item = { policy: POLICY, rpcUrl: 'https://rpc.example.invalid/' };
    expect(resolveHostConfig({ deployments: [item, item] })).toEqual({
      ok: false,
      reason: 'CONFIG_DUPLICATE_DEPLOYMENT',
    });
  });
});
