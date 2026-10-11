import { describe, expect, it } from 'vitest';
import {
  BUILD_SETTING_KEYS,
  PROFILES,
  RECORDED_SEEDS,
  REQUIRED_SELECTORS,
  REQUIRED_SUITES,
  profileEnvironment,
  sameBuildSettings,
  summariseCampaign,
} from './security-campaign';

const target = { fuzzRuns: 10, invariantRuns: 4, invariantDepth: 8 };
const metrics = Object.fromEntries(
  REQUIRED_SELECTORS.map((selector) => [
    `test/handlers/ReviewRegistryHandler.sol:ReviewRegistryHandler.${selector}`,
    { calls: 4, reverts: 0, discards: 0 },
  ]),
);
function output(
  change: (suites: Record<string, { test_results: Record<string, unknown> }>) => void = () =>
    undefined,
) {
  const suites: Record<string, { test_results: Record<string, unknown> }> = {};
  for (const suite of REQUIRED_SUITES) {
    suites[suite] = {
      test_results: {
        'test_unit()': { status: 'Success', reason: null, kind: { Unit: { gas: 1 } } },
        'testFuzz_property(uint256)': {
          status: 'Success',
          reason: null,
          kind: { Fuzz: { runs: 10 } },
        },
      },
    };
  }
  suites['test/RegistryInvariants.t.sol:RegistryInvariantsTest'] = {
    test_results: {
      'invariant_x()': {
        status: 'Success',
        reason: null,
        kind: { Invariant: { runs: 4, calls: 32, reverts: 0, metrics } },
      },
    },
  };
  change(suites);
  return JSON.stringify(suites);
}

describe('security campaign summary', () => {
  it('accepts exactly the campaign that was asked for and counts what ran', () => {
    const summary = summariseCampaign(output(), target);
    expect(summary.issues).toEqual([]);
    expect(summary.totals).toMatchObject({
      suites: REQUIRED_SUITES.length,
      failed: 0,
      fuzzProperties: REQUIRED_SUITES.length - 1,
      fuzzCases: (REQUIRED_SUITES.length - 1) * 10,
      invariantCampaigns: 1,
      invariantCalls: 32,
    });
  });
  it('never relabels a smaller run as the full campaign', () => {
    const fewer = summariseCampaign(output(), { ...target, fuzzRuns: 11 });
    expect(fewer.issues.some((issue) => issue.startsWith('FUZZ_CASES_BELOW_TARGET'))).toBe(true);
    const shallow = summariseCampaign(output(), { ...target, invariantDepth: 9 });
    expect(shallow.issues.some((issue) => issue.startsWith('INVARIANT_CALLS_BELOW_TARGET'))).toBe(
      true,
    );
    const short = summariseCampaign(output(), { ...target, invariantRuns: 5 });
    expect(short.issues.some((issue) => issue.startsWith('INVARIANT_RUNS_BELOW_TARGET'))).toBe(
      true,
    );
  });
  it('a failed test, a missing suite, a revert or an unexercised operation fails the campaign', () => {
    const failed = summariseCampaign(
      output((suites) => {
        const suite = suites[REQUIRED_SUITES[0]];
        if (suite !== undefined) {
          suite.test_results['test_unit()'] = {
            status: 'Failure',
            reason: 'x',
            kind: { Unit: { gas: 1 } },
          };
        }
      }),
      target,
    );
    expect(failed.issues.some((issue) => issue.startsWith('TEST_NOT_PASSED'))).toBe(true);
    expect(failed.totals.failed).toBe(1);

    const missing = summariseCampaign(
      output((suites) => {
        Reflect.deleteProperty(suites, REQUIRED_SUITES[3]);
      }),
      target,
    );
    expect(missing.issues).toContain(`REQUIRED_SUITE_MISSING ${REQUIRED_SUITES[3]}`);

    const idle = summariseCampaign(
      output((suites) => {
        suites['test/RegistryInvariants.t.sol:RegistryInvariantsTest'] = {
          test_results: {
            'invariant_x()': {
              status: 'Success',
              reason: null,
              kind: {
                Invariant: {
                  runs: 4,
                  calls: 32,
                  reverts: 2,
                  metrics: {
                    ...metrics,
                    'a:ReviewRegistryHandler.supersede': { calls: 0, reverts: 0 },
                  },
                },
              },
            },
          },
        };
      }),
      target,
    );
    expect(idle.issues).toContain('OPERATION_NOT_EXERCISED supersede');
    expect(idle.issues.some((issue) => issue.startsWith('INVARIANT_REVERTS'))).toBe(true);
  });
  it('an empty or unreadable output is not evidence', () => {
    expect(summariseCampaign('', target).issues).toEqual(['OUTPUT_UNREADABLE']);
    expect(summariseCampaign('{}', target).issues).toContain(
      `REQUIRED_SUITE_MISSING ${REQUIRED_SUITES[0]}`,
    );
  });
});

describe('security profile', () => {
  it('sets campaign sizes only, with the documented targets and two distinct recorded seeds', () => {
    expect(PROFILES.full).toMatchObject({
      fuzzRuns: 10_000,
      invariantRuns: 1_000,
      invariantDepth: 256,
    });
    expect(PROFILES.ci).toMatchObject({ fuzzRuns: 1_000, invariantRuns: 256, invariantDepth: 128 });
    expect(RECORDED_SEEDS.pinned).not.toBe(RECORDED_SEEDS.additional);
    const environment = profileEnvironment('full', RECORDED_SEEDS.additional);
    expect(Object.keys(environment).sort()).toEqual([
      'FOUNDRY_FUZZ_RUNS',
      'FOUNDRY_FUZZ_SEED',
      'FOUNDRY_INVARIANT_DEPTH',
      'FOUNDRY_INVARIANT_RUNS',
      'FOUNDRY_INVARIANT_WORKERS',
    ]);
    // No override names a compiler, optimizer, EVM or metadata setting.
    for (const key of Object.keys(environment)) {
      expect(/SOLC|OPTIMIZER|EVM|VIA_IR|BYTECODE|METADATA|REMAPPING|PROFILE/.test(key)).toBe(false);
    }
    expect(() => profileEnvironment('full', 'not-hex')).toThrow();
  });
  it('detects any bytecode-affecting difference between the baseline and the profile', () => {
    const baseline = Object.fromEntries(
      BUILD_SETTING_KEYS.map((key) => [key, key === 'optimizer_runs' ? 200 : 'x']),
    );
    expect(sameBuildSettings(baseline, { ...baseline, fuzz: { runs: 10_000 } })).toEqual([]);
    expect(sameBuildSettings(baseline, { ...baseline, optimizer_runs: 1 })).toEqual([
      'optimizer_runs',
    ]);
    expect(
      sameBuildSettings(baseline, { ...baseline, via_ir: true, solc: '0.8.38' }).sort(),
    ).toEqual(['solc', 'via_ir']);
  });
});
