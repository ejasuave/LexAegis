import { describe, expect, it } from 'vitest';
import { PRODUCT_FLAGS, type FeatureReadiness, type ProductFlag } from '@/config/flags';
import {
  FEATURE_READINESS,
  clientFlags,
  computeRevision,
  loadFeatureConfiguration,
  rejectIfDisabled,
} from './flags';

const VERIFIED = Object.fromEntries(
  PRODUCT_FLAGS.map((flag) => [flag, { implemented: true, verified: true }]),
) as Record<ProductFlag, FeatureReadiness>;

describe('shipped feature readiness', () => {
  it('claims only what has code and recorded evidence: comparison (Chapter 8), voice (Chapter 10) and the read-only agent identity line (Chapter 16), nothing else yet', () => {
    for (const flag of PRODUCT_FLAGS) {
      expect(FEATURE_READINESS[flag]).toEqual(
        flag === 'documentComparison' || flag === 'voice' || flag === 'agentIdentity'
          ? { implemented: true, verified: true }
          : { implemented: false, verified: false },
      );
    }
  });

  it('keeps every unimplemented feature off whatever the environment says; comparison needs an explicit true', () => {
    const env = Object.fromEntries(
      PRODUCT_FLAGS.map((flag) => [
        `FEATURE_${flag.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`,
        'true',
      ]),
    );
    const configuration = loadFeatureConfiguration(env);
    expect(configuration.valid).toBe(true);
    expect(Object.values(configuration.flags)).toEqual(
      PRODUCT_FLAGS.map(
        (flag) => flag === 'documentComparison' || flag === 'voice' || flag === 'agentIdentity',
      ),
    );
    // Unset means off, even though the feature exists.
    expect(loadFeatureConfiguration({}).flags.documentComparison).toBe(false);
    // The identity line is on by default once verified (Chapter 14 rule), but an explicit false removes it.
    expect(loadFeatureConfiguration({ FEATURE_AGENT_IDENTITY: 'false' }).flags.agentIdentity).toBe(
      false,
    );
  });
});

describe('feature configuration', () => {
  it('fails closed on a malformed value: valid=false and every flag off', () => {
    const configuration = loadFeatureConfiguration({ FEATURE_VOICE: 'TRUE' }, VERIFIED);
    expect(configuration.valid).toBe(false);
    expect(Object.values(configuration.flags)).not.toContain(true);
  });

  it('gives identical configurations the same revision and different ones a different revision', () => {
    const a = loadFeatureConfiguration({}, VERIFIED);
    const b = loadFeatureConfiguration({ FEATURE_AGENT_IDENTITY: '' }, VERIFIED);
    const c = loadFeatureConfiguration({ FEATURE_MATTER_NOTES: 'false' }, VERIFIED);
    expect(a.revision).toBe(b.revision);
    expect(a.revision).not.toBe(c.revision);
    expect(a.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(a.revision).toBe(computeRevision(a.flags));
  });

  it('projects only six booleans to clients, with no secrets or revision details', () => {
    const projected = clientFlags(loadFeatureConfiguration({ FEATURE_VOICE: 'true' }, VERIFIED));
    expect(Object.keys(projected).sort()).toEqual([...PRODUCT_FLAGS].sort());
    expect(Object.values(projected).every((value) => typeof value === 'boolean')).toBe(true);
    expect(JSON.stringify(projected)).not.toMatch(/FEATURE_|KEY|SECRET|TOKEN|revision|http/i);
  });
});

describe('server-side gate', () => {
  it('rejects a direct request for a disabled capability with a fixed FORBIDDEN error', async () => {
    const configuration = loadFeatureConfiguration({});
    const response = rejectIfDisabled('voice', 'req-1', configuration);
    expect(response?.status).toBe(403);
    const body: unknown = await response?.json();
    expect(body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'This capability is not enabled.', requestId: 'req-1' },
    });
  });

  it('lets an enabled capability through and ignores any client-supplied override', () => {
    const enabled = loadFeatureConfiguration({ FEATURE_VOICE: 'true' }, VERIFIED);
    expect(rejectIfDisabled('voice', 'req-2', enabled)).toBeNull();
    // The gate takes no request data: a query string, cookie or payload cannot reach it.
    const disabled = loadFeatureConfiguration({}, VERIFIED);
    expect(rejectIfDisabled('voice', 'req-3', disabled)?.status).toBe(403);
  });
});
