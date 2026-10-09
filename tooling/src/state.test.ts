import { describe, expect, it } from 'vitest';
import { FEATURES, FEATURE_IDS, initialStatus } from './register';
import { appendResults, validateBuildState } from './state';
import { renderScopeDocs } from './scope-docs';
import { result } from './test-helpers';

type Row = Record<string, unknown>;

function stateWith(overrides: { features?: Row[]; results?: unknown[] } = {}) {
  return {
    chapters: [],
    tiers: {
      schemaVersion: 1,
      features:
        overrides.features ??
        FEATURES.map((feature): Row => ({
          id: feature.id,
          tier: feature.tier,
          chapter: feature.chapter,
          status: initialStatus(feature.id),
          evidence: [],
        })),
    },
    results: overrides.results ?? [],
  };
}

const codes = (state: unknown, options = {}) =>
  validateBuildState(state, options).map((i) => i.code);

describe('scope register', () => {
  it('registers every required feature in its tier', () => {
    const tier = (name: string) => FEATURES.filter((f) => f.tier === name).length;
    expect([tier('T0'), tier('T1'), tier('T2'), tier('T3')]).toEqual([12, 11, 7, 6]);
    expect(FEATURE_IDS.size).toBe(FEATURES.length);
    expect(FEATURES.filter((f) => f.tier === 'T3').map((f) => f.id)).toEqual([
      'voice',
      'document-comparison',
      'matter-briefing',
      'reputation-feedback',
      'evaluation-fixtures-12',
      'visual-polish',
    ]);
  });

  it('starts nothing as verified: authored prompts and unchecked code are not verification', () => {
    expect(FEATURES.map((f) => initialStatus(f.id))).not.toContain('verified');
  });
});

describe('build-state validation', () => {
  it('accepts the initial state', () => {
    expect(codes(stateWith())).toEqual([]);
  });

  it('rejects unknown feature IDs and statuses', () => {
    const features = stateWith().tiers.features;
    const head: Row = features[0] ?? {};
    expect(codes(stateWith({ features: [...features, { ...head, id: 'made-up' }] }))).toContain(
      'UNKNOWN_FEATURE_ID',
    );
    expect(
      codes(stateWith({ features: [{ ...head, status: 'done' }, ...features.slice(1)] })),
    ).toContain('SCHEMA_INVALID');
  });

  it('requires every registered feature exactly once and the register tier and chapter', () => {
    const features = stateWith().tiers.features;
    const head: Row = features[0] ?? {};
    expect(codes(stateWith({ features: features.slice(1) }))).toContain('MISSING_FEATURE');
    expect(codes(stateWith({ features: [head, ...features] }))).toContain('DUPLICATE_FEATURE_ID');
    expect(
      codes(stateWith({ features: [{ ...head, tier: 'T3' }, ...features.slice(1)] })),
    ).toContain('REGISTER_MISMATCH');
  });

  it('rejects unsupported verified claims', () => {
    const features = stateWith().tiers.features;
    const head: Row = features[0] ?? {};
    const claim = (patch: object) =>
      stateWith({ features: [{ ...head, ...patch }, ...features.slice(1)] });
    expect(codes(claim({ status: 'verified' }))).toContain('VERIFIED_WITHOUT_EVIDENCE');
    expect(codes(claim({ status: 'verified', evidence: ['nope'] }))).toContain('DANGLING_EVIDENCE');
    expect(codes(claim({ status: 'in-progress', evidence: ['x'] }))).toContain(
      'EVIDENCE_ON_UNVERIFIED',
    );

    const failing = result('document-import', { outcome: 'fail', evidenceClass: 'local_scripted' });
    const state = stateWith({ results: [failing] });
    state.tiers.features[0] = {
      ...head,
      status: 'verified',
      evidence: [failing.id],
    };
    expect(codes(state)).toContain('VERIFIED_WITHOUT_PASS');

    // Evidence for a different feature does not support this one.
    const other = result('consent', { evidenceClass: 'local_scripted' });
    const crossed = stateWith({ results: [other] });
    crossed.tiers.features[0] = {
      ...head,
      status: 'verified',
      evidence: [other.id],
    };
    expect(codes(crossed)).toContain('DANGLING_EVIDENCE');

    const good = result('document-import', { evidenceClass: 'local_scripted' });
    const ok = stateWith({ results: [good] });
    ok.tiers.features[0] = { ...head, status: 'verified', evidence: [good.id] };
    expect(codes(ok)).toEqual([]);
  });

  it('flags dangling result and path references', () => {
    const dangling = result('consent', {
      evidenceRefs: [
        { type: 'result', value: 'ghost-result' },
        { type: 'path', value: 'docs/not-there.md' },
      ],
    });
    const found = codes(stateWith({ results: [dangling] }), { pathExists: () => false });
    expect(found).toEqual(['DANGLING_RESULT_REFERENCE', 'DANGLING_PATH_REFERENCE']);
  });

  it('keeps the result schema closed and timestamps explicit about their offset', () => {
    expect(codes(stateWith({ results: [{ ...result('consent'), extra: 1 }] }))).toContain(
      'SCHEMA_INVALID',
    );
    expect(
      codes(stateWith({ results: [{ ...result('consent'), checkedAt: '2026-10-06T12:00:00' }] })),
    ).toContain('SCHEMA_INVALID');
    expect(codes(stateWith({ results: [result('consent'), result('consent')] }))).toEqual([]);
  });
});

describe('immutable history', () => {
  it('appends new results and tolerates an identical repeat', () => {
    const first = result('consent');
    const second = result('qwen-run');
    expect(appendResults([first], [first, second])).toEqual([first, second]);
  });

  it('refuses to rewrite a recorded result', () => {
    const first = result('consent');
    expect(() => appendResults([first], [{ ...first, outcome: 'fail' }])).toThrow(
      /refusing to rewrite/,
    );
  });
});

describe('scope-tiers.md', () => {
  it('lists every feature once with its status', () => {
    const doc = renderScopeDocs((id) => initialStatus(id));
    for (const feature of FEATURES) expect(doc.split(`\`${feature.id}\``)).toHaveLength(2);
    expect(doc).toContain('Generated from tooling/src/register.ts');
  });
});
