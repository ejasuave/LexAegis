/** Generates docs/scope-tiers.md from the register and the statuses in build-state. --check compares. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'prettier';
import { writeAtomic, readState } from '../src/evidence-writer';
import { renderScopeDocs } from '../src/scope-docs';
import { ROOT } from './lib';

const state = readState(ROOT);
const features = (state.tiers as { features: { id: string; status: string }[] }).features;
const status = (id: string) => features.find((feature) => feature.id === id)?.status ?? 'missing';
const path = join(ROOT, 'docs', 'scope-tiers.md');
const expected = await format(renderScopeDocs(status), {
  parser: 'markdown',
  singleQuote: true,
  printWidth: 100,
});

if (process.argv.includes('--check')) {
  const actual = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (actual !== expected) {
    console.error('STALE docs/scope-tiers.md: run "pnpm scope:docs"');
    process.exit(1);
  }
  console.log('docs/scope-tiers.md agrees with the register and build-state');
} else {
  await writeAtomic(path, expected);
  console.log('wrote docs/scope-tiers.md');
}
