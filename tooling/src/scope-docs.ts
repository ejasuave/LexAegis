import { FEATURES, TIERS, type Tier } from './register';

const HEADINGS: Readonly<Record<Tier, string>> = {
  T0: 'T0: the golden path (no submission without it)',
  T1: 'T1: required for a credible product and developer story',
  T2: 'T2: depth and assurance',
  T3: 'T3: stretch (first to be cut)',
};

/** docs/scope-tiers.md, generated from the register. Run `pnpm scope:docs` after editing it. */
export function renderScopeDocs(statusOf: (id: string) => string): string {
  const lines = [
    '# Scope tiers',
    '',
    '<!-- Generated from tooling/src/register.ts by `pnpm scope:docs`. Do not edit by hand. -->',
    '',
    'Status is exactly `not-started`, `in-progress`, `verified` or `cut`. A feature is `verified` only',
    'with a passing, current, recorded check; code that exists without one is not verified. A',
    'tier does not remove a dependency: freeze still needs recoverable encrypted storage, approval',
    'still needs a real signer, and the Envio pipeline stays required despite its T2 label.',
    '',
  ];
  for (const tier of TIERS) {
    lines.push(
      `## ${HEADINGS[tier]}`,
      '',
      '| Feature | ID | Chapter | Status |',
      '| --- | --- | --- | --- |',
    );
    for (const feature of FEATURES.filter((item) => item.tier === tier)) {
      lines.push(
        `| ${feature.title} | \`${feature.id}\` | ${feature.chapter} | ${statusOf(feature.id)} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
