import { describe, expect, it } from 'vitest';
import { resolveHostConfig } from './config';
import { snapshotInputs } from './inputs';
import { ATTRIBUTES, HOST } from './test-helpers';

const resolved = resolveHostConfig({ ...HOST, rpcOrigins: ['https://alt.example.invalid'] });
if (!resolved.ok) throw new Error('fixture');
const config = resolved.config;

describe('attribute snapshots', () => {
  it('validates the whole chain/registry/reviewer/commitment tuple', () => {
    const result = snapshotInputs(ATTRIBUTES, config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.reference.chainId).toBe('10143');
      expect(result.input.rpcUrl).toBe('https://rpc.example.invalid/');
      expect(result.input.packageUrl).toBeNull();
    }
  });

  it.each(['chainId', 'registry', 'reviewer', 'commitment'] as const)('needs %s', (key) => {
    expect(snapshotInputs({ ...ATTRIBUTES, [key]: null }, config)).toEqual({
      ok: false,
      reason: 'ATTRIBUTE_MISSING',
    });
  });

  it('never identifies a receipt by commitment alone', () => {
    expect(
      snapshotInputs({ ...ATTRIBUTES, chainId: null, registry: null, reviewer: null }, config).ok,
    ).toBe(false);
  });

  it.each([
    ['a non-canonical chain id', { chainId: '010143' }],
    ['an exponent chain id', { chainId: '1e4' }],
    ['a short commitment', { commitment: '0xab' }],
    ['an uppercase reviewer', { reviewer: '0x22222222222222222222222222222222222222AA' }],
  ])('rejects %s', (_name, patch) => {
    expect(snapshotInputs({ ...ATTRIBUTES, ...patch }, config)).toEqual({
      ok: false,
      reason: 'REFERENCE_INVALID',
    });
  });

  it('keeps a very large chain id as a string, never a Number', () => {
    const big = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    const result = snapshotInputs({ ...ATTRIBUTES, chainId: big }, config);
    expect(result).toEqual({ ok: false, reason: 'DEPLOYMENT_NOT_TRUSTED' });
  });

  it('treats an unlisted registry as an untrusted deployment', () => {
    expect(
      snapshotInputs(
        { ...ATTRIBUTES, registry: '0x9999999999999999999999999999999999999999' },
        config,
      ),
    ).toEqual({ ok: false, reason: 'DEPLOYMENT_NOT_TRUSTED' });
  });

  it('honours rpc-url only on an approved origin', () => {
    const allowed = snapshotInputs(
      { ...ATTRIBUTES, rpcUrl: 'https://alt.example.invalid/rpc' },
      config,
    );
    expect(allowed.ok && allowed.input.rpcUrl).toBe('https://alt.example.invalid/rpc');
    for (const rpcUrl of [
      'https://evil.example.invalid/',
      'http://alt.example.invalid/',
      'https://u:p@alt.example.invalid/',
      'https://alt.example.invalid/?k=1',
    ]) {
      expect(snapshotInputs({ ...ATTRIBUTES, rpcUrl }, config)).toEqual({
        ok: false,
        reason: 'RPC_URL_NOT_ALLOWED',
      });
    }
  });

  it('limits only the file check when the package-url is not approved', () => {
    const ok = snapshotInputs(
      { ...ATTRIBUTES, packageUrl: 'https://packages.example.invalid/a.json' },
      config,
    );
    expect(ok.ok && ok.input.packageUrl).toBe('https://packages.example.invalid/a.json');
    for (const packageUrl of [
      'https://other.example.invalid/a.json',
      'https://u:p@packages.example.invalid/a.json',
      'https://packages.example.invalid/a.json#x',
      'javascript:alert(1)',
    ]) {
      const bad = snapshotInputs({ ...ATTRIBUTES, packageUrl }, config);
      expect(bad.ok && bad.input.packageUrl).toBeNull();
      expect(bad.ok && bad.input.packageRejected).toBe(true);
    }
  });
});
