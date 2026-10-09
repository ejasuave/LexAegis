import { describe, expect, it } from 'vitest';
import { loadPublicConfig } from './public';

const SECRET = 'sk-test-secret-value-1234567890';

describe('public configuration', () => {
  it('exposes only the allowlisted values and never spreads the environment', () => {
    const result = loadPublicConfig({
      NEXT_PUBLIC_APP_ORIGIN: 'https://app.example.com',
      NEXT_PUBLIC_CHAIN_ID: '10143',
      NEXT_PUBLIC_WEBAUTHN_RP_ID: 'app.example.com',
      QWEN_API_KEY: SECRET,
      DATABASE_URL: 'postgres://user:pw@db/x',
      AUTH_SESSION_SECRET: SECRET,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.config).sort()).toEqual(['appOrigin', 'chainId', 'webauthnRpId']);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain('postgres');
  });

  it('treats empty values as unset so the shell can boot', () => {
    expect(
      loadPublicConfig({ NEXT_PUBLIC_CHAIN_ID: '', NEXT_PUBLIC_REGISTRY_ADDRESS: '' }),
    ).toEqual({
      ok: true,
      config: {},
    });
  });

  it('rejects malformed values by variable name without echoing them', () => {
    const bad = 'not-a-valid-value-xyz';
    const result = loadPublicConfig({
      NEXT_PUBLIC_APP_ORIGIN: 'https://app.example.com/path/',
      NEXT_PUBLIC_WEBAUTHN_RP_ID: 'https://app.example.com:3000',
      NEXT_PUBLIC_CHAIN_ID: '0',
      NEXT_PUBLIC_REGISTRY_ADDRESS: bad,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invalidKeys.sort()).toEqual([
      'NEXT_PUBLIC_APP_ORIGIN',
      'NEXT_PUBLIC_CHAIN_ID',
      'NEXT_PUBLIC_REGISTRY_ADDRESS',
      'NEXT_PUBLIC_WEBAUTHN_RP_ID',
    ]);
    expect(JSON.stringify(result)).not.toContain(bad);
  });
});
