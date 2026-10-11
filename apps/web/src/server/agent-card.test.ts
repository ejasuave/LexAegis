import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { registrationFileSchema } from '@lexaegis/sdk/agent-identity';
import { agentCardOutcome, publicOrigin } from './agent-card';

describe('agent card route logic', () => {
  it('is not published while disabled or without a public https origin', () => {
    expect(agentCardOutcome({ NEXT_PUBLIC_APP_ORIGIN: 'https://app.example.test' }, false)).toEqual(
      { status: 404, reason: 'DISABLED' },
    );
    for (const origin of [
      'http://localhost:3000',
      'https://localhost',
      'https://127.0.0.1',
      'http://app.example.test',
      undefined,
      'https://[::1]',
    ]) {
      expect(agentCardOutcome({ NEXT_PUBLIC_APP_ORIGIN: origin }, true)).toEqual({
        status: 404,
        reason: 'NO_PUBLIC_ORIGIN',
      });
    }
    expect(publicOrigin(['https://user', 'pw'].join(':') + '@app.example.test')).toBeNull();
  });
  it('serves a valid card with no registration tuple before registration (nothing predicted)', () => {
    const outcome = agentCardOutcome({ NEXT_PUBLIC_APP_ORIGIN: 'https://app.example.test' }, true);
    expect(outcome.status).toBe(200);
    if (outcome.status === 200) {
      expect(registrationFileSchema.parse(outcome.card).registrations).toEqual([]);
      expect(JSON.stringify(outcome.card)).not.toMatch(
        /session|cookie|matter|analytics|authorization/i,
      );
    }
  });
  it('includes the actual tuple only from a configured confirmed ID, and refuses unsafe IDs', () => {
    const env = { NEXT_PUBLIC_APP_ORIGIN: 'https://app.example.test' };
    const ok = agentCardOutcome({ ...env, AGENT_IDENTITY_AGENT_ID: '12' }, true);
    expect(ok.status === 200 && ok.card.registrations).toEqual([
      { agentId: 12, agentRegistry: 'eip155:10143:0x8004a818bfb912233c491871b3d84c89a494bd9e' },
    ]);
    for (const bad of ['9007199254740993', '1e3', '-1', '07', 'x']) {
      expect(agentCardOutcome({ ...env, AGENT_IDENTITY_AGENT_ID: bad }, true)).toEqual({
        status: 404,
        reason: 'UNSUPPORTED_AGENT_ID',
      });
    }
  });
});
