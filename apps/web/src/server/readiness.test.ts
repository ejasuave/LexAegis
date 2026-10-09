import { describe, expect, it } from 'vitest';
import type { CapabilityName } from '@/lib/readiness-schema';
import { readinessReportSchema } from '@/lib/readiness-schema';
import { buildReadinessReport, CAPABILITIES, type CapabilityDefinition } from './readiness';

const SECRET_VALUES = {
  QWEN_API_KEY: 'qwen-secret-0123456789',
  QWEN_BASE_URL: 'https://qwen.example.com/v1',
  QWEN_MODEL: 'qwen3.8-max',
  ALCHEMY_MONAD_RPC_URL: 'https://monad.alchemy.example/v2/rpc-key-ABCDEF',
  DATABASE_URL: 'postgres://app:db-password-xyz@db.example.com/lexaegis',
  AUTH_SESSION_SECRET: 'session-secret-0123456789',
};

const IMPLEMENTED: ReadonlySet<string> = new Set(['account.mera', 'database.postgres']);

describe('readiness (only accounts and the database are implemented)', () => {
  it('stays unavailable with no credentials at all, and nothing is called verified', () => {
    const report = buildReadinessReport({ env: {} }, 'req_1');
    expect(report.status).toBe('unavailable');
    expect(report.capabilities.length).toBe(CAPABILITIES.length);
    for (const item of report.capabilities) {
      // Built capabilities with no configuration are unconfigured; the rest do not exist yet.
      const built = IMPLEMENTED.has(item.name);
      expect(item.state).toBe(built ? 'unconfigured' : 'unimplemented');
      expect(item.reason).toBe(built ? 'NOT_CONFIGURED' : 'NOT_IMPLEMENTED');
    }
    expect(CAPABILITIES.filter((item) => item.implemented).map((item) => item.name)).toEqual([
      'account.mera',
      'database.postgres',
    ]);
    expect(readinessReportSchema.safeParse(report).success).toBe(true);
  });

  it('reports a configured account as configured, never verified, without a real-device check', () => {
    const report = buildReadinessReport(
      {
        env: {
          DATABASE_URL: SECRET_VALUES.DATABASE_URL,
          NEXT_PUBLIC_APP_ORIGIN: 'https://app.lexaegis.test',
          NEXT_PUBLIC_WEBAUTHN_RP_ID: 'app.lexaegis.test',
          NEXT_PUBLIC_CHAIN_ID: '10143',
        },
      },
      'req_1b',
    );
    const account = report.capabilities.find((item) => item.name === 'account.mera');
    expect(account).toMatchObject({ state: 'configured', reason: 'UNVERIFIED' });
    expect(report.status).toBe('unavailable');
  });

  it('stays unavailable when every credential is present, and leaks none of their values', () => {
    const report = buildReadinessReport({ env: SECRET_VALUES }, 'req_2');
    expect(report.status).toBe('unavailable');
    const serialized = JSON.stringify(report);
    for (const value of Object.values(SECRET_VALUES)) expect(serialized).not.toContain(value);
  });
});

describe('readiness state derivation (using hypothetical implemented capabilities)', () => {
  const qwen: CapabilityDefinition = {
    name: 'assistant.qwen',
    implemented: true,
    serverKeys: ['QWEN_API_KEY', 'QWEN_BASE_URL', 'QWEN_MODEL'],
    publicKeys: [],
  };
  const stateFor = (env: Record<string, string>, verified: CapabilityName[] = []) =>
    buildReadinessReport({ env, capabilities: [qwen], verified: new Set(verified) }, 'req_3')
      .capabilities[0]?.state;

  it('missing credentials are unconfigured', () => {
    expect(stateFor({})).toBe('unconfigured');
  });

  it('malformed configuration is blocked', () => {
    expect(stateFor({ ...SECRET_VALUES, QWEN_BASE_URL: 'ftp://nope' })).toBe('blocked');
  });

  it('complete configuration alone is configured, never verified', () => {
    expect(stateFor(SECRET_VALUES)).toBe('configured');
  });

  it('verified requires actual verification evidence, and only then is the report ready', () => {
    expect(stateFor(SECRET_VALUES, ['assistant.qwen'])).toBe('verified');
    const ready = buildReadinessReport(
      { env: SECRET_VALUES, capabilities: [qwen], verified: new Set(['assistant.qwen']) },
      'req_4',
    );
    expect(ready.status).toBe('ready');
  });
});
