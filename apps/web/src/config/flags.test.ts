import { describe, expect, it } from 'vitest';
import {
  ALL_FLAGS_OFF,
  FLAG_ENV,
  PRODUCT_FLAGS,
  clientFlagsSchema,
  enabledFlags,
  resolveFlags,
  type FeatureReadiness,
  type ProductFlag,
} from './flags';

const NONE: Record<ProductFlag, FeatureReadiness> = Object.fromEntries(
  PRODUCT_FLAGS.map((flag) => [flag, { implemented: false, verified: false }]),
) as Record<ProductFlag, FeatureReadiness>;
const ALL_VERIFIED: Record<ProductFlag, FeatureReadiness> = Object.fromEntries(
  PRODUCT_FLAGS.map((flag) => [flag, { implemented: true, verified: true }]),
) as Record<ProductFlag, FeatureReadiness>;

function flagsOf(env: Record<string, string>, readiness = NONE) {
  const result = resolveFlags(env, readiness);
  if (!result.ok) throw new Error(`invalid: ${result.invalidKeys.join(',')}`);
  return result;
}

describe('product flag defaults', () => {
  it('defines exactly the six product flags with server-only names', () => {
    expect([...PRODUCT_FLAGS]).toEqual([
      'voice',
      'documentComparison',
      'matterBriefing',
      'reputationFeedback',
      'agentIdentity',
      'matterNotes',
    ]);
    for (const name of Object.values(FLAG_ENV)) expect(name).toMatch(/^FEATURE_[A-Z_]+$/);
  });

  it('is entirely off when nothing is implemented, even with empty values', () => {
    expect(flagsOf({}).flags).toEqual(ALL_FLAGS_OFF);
    expect(flagsOf({ FEATURE_VOICE: '', FEATURE_MATTER_NOTES: '' }).flags).toEqual(ALL_FLAGS_OFF);
  });

  it('keeps the first four off by default even when implemented and verified', () => {
    const { flags } = flagsOf({}, ALL_VERIFIED);
    expect(enabledFlags(flags)).toEqual(['agentIdentity', 'matterNotes']);
  });

  it('turns agent identity and notes on by default only with implementation AND matching evidence', () => {
    const partial = (flag: ProductFlag, readiness: FeatureReadiness) => ({
      ...NONE,
      [flag]: readiness,
    });
    for (const flag of ['agentIdentity', 'matterNotes'] as const) {
      expect(flagsOf({}, partial(flag, { implemented: true, verified: false })).flags[flag]).toBe(
        false,
      );
      expect(flagsOf({}, partial(flag, { implemented: false, verified: true })).flags[flag]).toBe(
        false,
      );
      expect(flagsOf({}, partial(flag, { implemented: true, verified: true })).flags[flag]).toBe(
        true,
      );
    }
  });
});

describe('explicit values', () => {
  it('an explicit false always disables, including a verified default-on feature', () => {
    const { flags } = flagsOf(
      { FEATURE_AGENT_IDENTITY: 'false', FEATURE_MATTER_NOTES: 'false' },
      ALL_VERIFIED,
    );
    expect(flags.agentIdentity).toBe(false);
    expect(flags.matterNotes).toBe(false);
  });

  it('an explicit true enables only an implemented and verified feature', () => {
    const env = Object.fromEntries(Object.values(FLAG_ENV).map((name) => [name, 'true']));
    expect(flagsOf(env, ALL_VERIFIED).flags).toEqual(
      Object.fromEntries(PRODUCT_FLAGS.map((flag) => [flag, true])),
    );

    const result = flagsOf(env, NONE);
    expect(result.flags).toEqual(ALL_FLAGS_OFF);
    expect(result.unavailable).toEqual([...PRODUCT_FLAGS]);

    const unverified = { ...ALL_VERIFIED, voice: { implemented: true, verified: false } };
    expect(flagsOf({ FEATURE_VOICE: 'true' }, unverified).flags.voice).toBe(false);
  });

  it.each([
    'TRUE',
    'True',
    '1',
    '0',
    'yes',
    'no',
    'on',
    'off',
    ' true',
    'false ',
    'null',
    'undefined',
  ])('rejects %j instead of coercing it', (value) => {
    const result = resolveFlags({ FEATURE_VOICE: value }, ALL_VERIFIED);
    expect(result).toEqual({ ok: false, invalidKeys: ['FEATURE_VOICE'] });
  });

  it('never treats the string "false" as true and reports every invalid name', () => {
    expect(flagsOf({ FEATURE_VOICE: 'false' }, ALL_VERIFIED).flags.voice).toBe(false);
    const result = resolveFlags(
      { FEATURE_VOICE: 'maybe', FEATURE_MATTER_NOTES: '2' },
      ALL_VERIFIED,
    );
    expect(result).toEqual({ ok: false, invalidKeys: ['FEATURE_VOICE', 'FEATURE_MATTER_NOTES'] });
  });

  it('ignores unknown names, public-prefixed names and client-style overrides', () => {
    const env = {
      NEXT_PUBLIC_FEATURE_VOICE: 'true',
      FEATURE_UNKNOWN: 'true',
      voice: 'true',
      'feature.voice': 'true',
    };
    expect(flagsOf(env, ALL_VERIFIED).flags.voice).toBe(false);
  });
});

describe('client projection', () => {
  it('accepts exactly six booleans and nothing else', () => {
    const projected = { ...ALL_FLAGS_OFF };
    expect(clientFlagsSchema.safeParse(projected).success).toBe(true);
    expect(
      clientFlagsSchema.safeParse({ ...projected, QWEN_API_KEY: 'secret-value' }).success,
    ).toBe(false);
    expect(clientFlagsSchema.safeParse({ ...projected, voice: 'true' }).success).toBe(false);
    const { voice: _omitted, ...missing } = projected;
    expect(clientFlagsSchema.safeParse(missing).success).toBe(false);
  });
});
