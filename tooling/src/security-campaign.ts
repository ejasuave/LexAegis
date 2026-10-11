import { z } from 'zod';

/*
 * The recorded contract security campaign. The campaign sizes are a TEST-ONLY profile supplied as
 * FOUNDRY_* environment overrides: contracts/foundry.toml is a protected baseline and is not
 * edited. Nothing here can change a bytecode-affecting build setting, and `sameBuildSettings`
 * proves that for each run.
 */

export const PROFILES = {
  /** The recorded security campaign (Chapter 17 target). */
  full: { fuzzRuns: 10_000, invariantRuns: 1_000, invariantDepth: 256, timeoutMinutes: 240 },
  /** Bounded routine profile for CI. It is NOT the full campaign and is never recorded as one. */
  ci: { fuzzRuns: 1_000, invariantRuns: 256, invariantDepth: 128, timeoutMinutes: 45 },
} as const;
export type ProfileName = keyof typeof PROFILES;

/** The repository's pinned seed (contracts/foundry.toml) and one additional distinct seed. */
export const RECORDED_SEEDS = {
  pinned: '0x4c657841656769732e50726f6f664f665265766965772e7631',
  additional: '0x4c657841656769732e4368617074657231372e63616d706169676e2e32',
} as const;

/** Suites that must be present with passing tests: an exit code without them is not evidence. */
export const REQUIRED_SUITES = [
  'test/Authorization.t.sol:AuthorizationTest',
  'test/Authorization.t.sol:AuthorizationBoundaryTest',
  'test/Authorization.t.sol:NonceExhaustionBoundaryTest',
  'test/Lifecycle.t.sol:LifecycleTest',
  'test/Vectors.t.sol:VectorsTest',
  'test/InterfaceSelectors.t.sol:InterfaceSelectorsTest',
  'test/Invariants.t.sol:RegistryInvariantTest',
  'test/RegistryInvariants.t.sol:RegistryInvariantsTest',
  'test/RegistryInvariants.t.sol:RegistryInvariantControlsTest',
  'test/RegistryInvariants.t.sol:RegistryTransitionsTest',
  'test/handlers/ReviewRegistryHandler.t.sol:ReviewRegistryHandlerTest',
] as const;

/** Handler operations the stateful campaign must have called. */
export const REQUIRED_SELECTORS = [
  'issue',
  'revoke',
  'supersede',
  'invalidate',
  'rejectSignature',
  'rejectShapeOrDeadline',
  'rejectLifecycle',
  'rejectNonce',
] as const;

/** Settings that decide the compiled bytecode. A profile must leave every one unchanged. */
export const BUILD_SETTING_KEYS = [
  'src',
  'libs',
  'remappings',
  'allow_paths',
  'solc',
  'auto_detect_solc',
  'evm_version',
  'optimizer',
  'optimizer_runs',
  'optimizer_details',
  'via_ir',
  'bytecode_hash',
  'cbor_metadata',
  'use_literal_content',
  'revert_strings',
  'libraries',
  'sparse_mode',
  'extra_output',
  'additional_compiler_profiles',
  'compilation_restrictions',
] as const;

export function profileEnvironment(profile: ProfileName, seed: string): Record<string, string> {
  if (!/^0x[0-9a-f]{2,64}$/.test(seed)) throw new Error('seed must be lowercase hex');
  const sizes = PROFILES[profile];
  return {
    FOUNDRY_FUZZ_RUNS: String(sizes.fuzzRuns),
    FOUNDRY_FUZZ_SEED: seed,
    FOUNDRY_INVARIANT_RUNS: String(sizes.invariantRuns),
    FOUNDRY_INVARIANT_DEPTH: String(sizes.invariantDepth),
    // One worker: runs are complete fixed-depth sequences, which the per-run coverage check needs.
    FOUNDRY_INVARIANT_WORKERS: '1',
  };
}

export function sameBuildSettings(
  baseline: Record<string, unknown>,
  underProfile: Record<string, unknown>,
): string[] {
  return BUILD_SETTING_KEYS.filter(
    (key) => JSON.stringify(baseline[key]) !== JSON.stringify(underProfile[key]),
  );
}

const metricSchema = z.looseObject({ calls: z.number(), reverts: z.number() });
const kindSchema = z.union([
  z.strictObject({ Unit: z.looseObject({ gas: z.number() }) }),
  z.strictObject({ Fuzz: z.looseObject({ runs: z.number() }) }),
  z.strictObject({
    Invariant: z.looseObject({
      runs: z.number(),
      calls: z.number(),
      reverts: z.number(),
      metrics: z.record(z.string(), metricSchema),
    }),
  }),
]);
const forgeOutputSchema = z.record(
  z.string(),
  z.looseObject({
    test_results: z.record(
      z.string(),
      z.looseObject({ status: z.string(), reason: z.string().nullable(), kind: kindSchema }),
    ),
  }),
);

export interface CampaignTest {
  readonly suite: string;
  readonly name: string;
  readonly status: string;
  readonly kind: 'unit' | 'fuzz' | 'invariant';
  readonly runs: number | null;
  readonly calls: number | null;
  readonly reverts: number | null;
  readonly selectorCalls: Record<string, number> | null;
}

export interface CampaignSummary {
  readonly tests: CampaignTest[];
  readonly totals: {
    readonly suites: number;
    readonly tests: number;
    readonly passed: number;
    readonly failed: number;
    readonly fuzzProperties: number;
    readonly fuzzCases: number;
    readonly invariantCampaigns: number;
    readonly invariantCalls: number;
  };
  readonly issues: string[];
}

/**
 * Reads `forge test --json` and decides whether it is the campaign that was asked for. Every fuzz
 * property must have run the full case count and every invariant campaign the full runs and
 * depth; a smaller effective run is reported, never relabelled.
 */
export function summariseCampaign(
  rawJson: string,
  expected: { fuzzRuns: number; invariantRuns: number; invariantDepth: number },
): CampaignSummary {
  const issues: string[] = [];
  let parsed: z.infer<typeof forgeOutputSchema>;
  try {
    parsed = forgeOutputSchema.parse(JSON.parse(rawJson));
  } catch {
    return {
      tests: [],
      totals: {
        suites: 0,
        tests: 0,
        passed: 0,
        failed: 0,
        fuzzProperties: 0,
        fuzzCases: 0,
        invariantCampaigns: 0,
        invariantCalls: 0,
      },
      issues: ['OUTPUT_UNREADABLE'],
    };
  }
  const tests: CampaignTest[] = [];
  for (const [suite, body] of Object.entries(parsed)) {
    for (const [name, result] of Object.entries(body.test_results)) {
      if ('Unit' in result.kind) {
        tests.push({
          suite,
          name,
          status: result.status,
          kind: 'unit',
          runs: null,
          calls: null,
          reverts: null,
          selectorCalls: null,
        });
      } else if ('Fuzz' in result.kind) {
        const runs = result.kind.Fuzz.runs;
        tests.push({
          suite,
          name,
          status: result.status,
          kind: 'fuzz',
          runs,
          calls: null,
          reverts: null,
          selectorCalls: null,
        });
        if (runs < expected.fuzzRuns)
          issues.push(`FUZZ_CASES_BELOW_TARGET ${suite} ${name} ${String(runs)}`);
      } else {
        const invariant = result.kind.Invariant;
        const selectorCalls = Object.fromEntries(
          Object.entries(invariant.metrics).map(([key, metric]) => [
            key.slice(key.lastIndexOf('.') + 1),
            metric.calls,
          ]),
        );
        tests.push({
          suite,
          name,
          status: result.status,
          kind: 'invariant',
          runs: invariant.runs,
          calls: invariant.calls,
          reverts: invariant.reverts,
          selectorCalls,
        });
        if (invariant.runs < expected.invariantRuns) {
          issues.push(`INVARIANT_RUNS_BELOW_TARGET ${suite} ${String(invariant.runs)}`);
        }
        if (invariant.calls < expected.invariantRuns * expected.invariantDepth) {
          issues.push(`INVARIANT_CALLS_BELOW_TARGET ${suite} ${String(invariant.calls)}`);
        }
        if (invariant.reverts !== 0)
          issues.push(`INVARIANT_REVERTS ${suite} ${String(invariant.reverts)}`);
      }
      if (result.status !== 'Success')
        issues.push(`TEST_NOT_PASSED ${suite} ${name} ${result.status}`);
    }
  }
  for (const suite of REQUIRED_SUITES) {
    if (!tests.some((test) => test.suite === suite)) issues.push(`REQUIRED_SUITE_MISSING ${suite}`);
  }
  const stateful = tests.find(
    (test) => test.suite === 'test/RegistryInvariants.t.sol:RegistryInvariantsTest',
  );
  for (const selector of REQUIRED_SELECTORS) {
    if ((stateful?.selectorCalls?.[selector] ?? 0) === 0) {
      issues.push(`OPERATION_NOT_EXERCISED ${selector}`);
    }
  }
  const fuzz = tests.filter((test) => test.kind === 'fuzz');
  const invariant = tests.filter((test) => test.kind === 'invariant');
  return {
    tests,
    totals: {
      suites: Object.keys(parsed).length,
      tests: tests.length,
      passed: tests.filter((test) => test.status === 'Success').length,
      failed: tests.filter((test) => test.status !== 'Success').length,
      fuzzProperties: fuzz.length,
      fuzzCases: fuzz.reduce((sum, test) => sum + (test.runs ?? 0), 0),
      invariantCampaigns: invariant.length,
      invariantCalls: invariant.reduce((sum, test) => sum + (test.calls ?? 0), 0),
    },
    issues,
  };
}
