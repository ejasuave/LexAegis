import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { loadIdentityConfig } from './agent-identity';

describe('identity configuration', () => {
  const env = { NEXT_PUBLIC_APP_ORIGIN: 'https://app.example.test', AGENT_IDENTITY_AGENT_ID: '7' };
  it('is not configured without an operator-recorded agent ID', () => {
    expect(loadIdentityConfig({})).toEqual({
      configured: false,
      reason: 'NO_REGISTRATION_CONFIGURED',
    });
    expect(loadIdentityConfig({ ...env, AGENT_IDENTITY_AGENT_ID: '07' })).toEqual({
      configured: false,
      reason: 'UNSUPPORTED_AGENT_ID',
    });
  });
  it('needs a public card address and only ever targets the configured testnet registry', () => {
    expect(
      loadIdentityConfig({
        AGENT_IDENTITY_AGENT_ID: '7',
        NEXT_PUBLIC_APP_ORIGIN: 'http://localhost:3000',
      }),
    ).toEqual({ configured: false, reason: 'NO_PUBLIC_CARD' });
    const config = loadIdentityConfig(env);
    expect(config).toMatchObject({
      configured: true,
      reference: {
        chainId: '10143',
        agentId: '7',
        cardUri: 'https://app.example.test/api/agent-card',
      },
      policy: { chainId: '10143' },
    });
    expect(JSON.stringify(config)).not.toMatch(/key|secret/i);
  });
});
