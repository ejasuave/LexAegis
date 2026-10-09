/**
 * Cut-ladder regression matrix (Chapter 14.5). Resolves the effective configuration of every
 * ladder step with the real flag resolver. Because no optional feature is implemented yet, every
 * configuration collapses to the same effective one, and the smoke journey (which cannot run)
 * keeps the result blocked: this validates candidate configurations, it applies no scope cut.
 */
import { createHash } from 'node:crypto';
import {
  PRODUCT_FLAGS,
  enabledFlags,
  resolveFlags,
  FLAG_ENV,
  type FeatureReadiness,
  type ProductFlag,
} from '../../apps/web/src/config/flags';
import { CUT_LADDER, MIN_FIXTURES } from '../src/cut-ladder';
import { recordEvidence } from '../src/evidence-writer';
import { sourceFingerprint } from '../src/fingerprint';
import { ROOT, stamp } from './lib';

// What exists today (mirrors apps/web/src/server/flags.ts FEATURE_READINESS: nothing).
const readiness = Object.fromEntries(
  PRODUCT_FLAGS.map((f) => [f, { implemented: false, verified: false }]),
) as Record<ProductFlag, FeatureReadiness>;
const off = (...flags: ProductFlag[]) =>
  Object.fromEntries(flags.map((f) => [FLAG_ENV[f], 'false']));

const configurations: {
  name: string;
  env: Record<string, string>;
  presentation: string[];
  covers: string[];
}[] = [
  { name: 'baseline', env: {}, presentation: [], covers: [] },
  {
    name: 'all-t3-off',
    env: off('voice', 'documentComparison', 'matterBriefing', 'reputationFeedback'),
    presentation: [],
    covers: ['voice', 'documentComparison', 'matterBriefing', 'reputationFeedback'],
  },
  { name: 'all-six-off', env: off(...PRODUCT_FLAGS), presentation: [], covers: [...PRODUCT_FLAGS] },
  ...CUT_LADDER.map((step, index) => ({
    name: `ladder-${String(index + 1)}-${step}`,
    env: off(
      ...CUT_LADDER.slice(0, index + 1).filter((s): s is ProductFlag =>
        (PRODUCT_FLAGS as readonly string[]).includes(s),
      ),
    ),
    presentation: CUT_LADDER.slice(0, index + 1).filter(
      (s) => !(PRODUCT_FLAGS as readonly string[]).includes(s),
    ),
    covers: [step],
  })),
  {
    name: 'identity-and-notes-off',
    env: off('agentIdentity', 'matterNotes'),
    presentation: [],
    covers: ['agentIdentity', 'matterNotes'],
  },
];

const effective = new Map<string, string[]>();
const rows = configurations.map((c) => {
  const resolved = resolveFlags(c.env, readiness);
  if (!resolved.ok) throw new Error(`invalid configuration ${c.name}`);
  const key = createHash('sha256')
    .update(
      JSON.stringify({
        flags: enabledFlags(resolved.flags),
        presentation: c.presentation,
        fixtures: c.presentation.includes('fixture-target-twelve-to-eight') ? MIN_FIXTURES : 12,
      }),
    )
    .digest('hex')
    .slice(0, 12);
  effective.set(key, [...(effective.get(key) ?? []), c.name]);
  return {
    name: c.name,
    effective: key,
    enabled: enabledFlags(resolved.flags),
    presentation: c.presentation,
  };
});

for (const row of rows)
  console.log(
    `${row.name.padEnd(46)} effective=${row.effective} enabled=[${row.enabled.join(',')}] presentation=[${row.presentation.join(',')}]`,
  );
console.log(
  `\n${String(rows.length)} configurations, ${String(effective.size)} distinct effective configurations (identical results are reused, not rerun).`,
);
console.log(
  'The T0 journey and every optional feature are unimplemented, so no feature is counted as successfully cut and the smoke journey cannot pass: result is blocked.',
);

await recordEvidence({
  root: ROOT,
  results: [
    stamp({
      id: `cutladder-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
      subject: 'cut-ladder-matrix',
      command: 'pnpm cutladder:check',
      evidenceClass: 'local_scripted',
      outcome: 'blocked',
      reasonCodes: ['T0_JOURNEY_PENDING', 'OPTIONAL_FEATURES_UNIMPLEMENTED'],
      facts: {
        configurations: String(rows.length),
        distinctEffective: String(effective.size),
        appliedProjectCuts: '0',
        fingerprint: sourceFingerprint(ROOT).slice(0, 16),
      },
    }),
  ],
  sections: {
    cutLadderChecks: {
      schemaVersion: 1,
      kind: 'candidate-configuration-validation',
      note: 'Validates candidate configurations. It is not an applied project scope cut; appliedCuts stays empty.',
      configurations: rows.map((r) => ({ ...r, outcome: 'blocked', reason: 'T0_JOURNEY_PENDING' })),
      distinctEffectiveConfigurations: effective.size,
    },
  },
});
process.exit(1);
