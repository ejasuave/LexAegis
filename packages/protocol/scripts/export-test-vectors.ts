/**
 * Materializes (or with --check, verifies) the language-neutral Proof of Review test vectors in
 * packages/protocol/test-vectors.
 *
 *   tsx scripts/export-test-vectors.ts          write protocol-v1.json (explicit export)
 *   tsx scripts/export-test-vectors.ts --check  read-only drift check for CI
 *   ... --check --asset <file>                   check another copy (used to prove detection)
 *
 * See test-vectors.ts: the asset is assembled only from the two independently generated sources,
 * so nothing is computed by the code under test. A failing check never overwrites the asset.
 */
import { writeFileSync } from 'node:fs';
import { ASSET_PATH, assetIsCurrent, buildAsset } from './test-vectors';

const flag = process.argv.indexOf('--asset');
const candidate = flag === -1 ? undefined : process.argv[flag + 1];

if (!process.argv.includes('--check')) {
  writeFileSync(ASSET_PATH, buildAsset());
  console.log('wrote packages/protocol/test-vectors/protocol-v1.json');
} else if (!assetIsCurrent(candidate)) {
  console.error(
    'STALE packages/protocol/test-vectors/protocol-v1.json: it differs from its two sources (run "pnpm vectors:export" only after reviewing why)',
  );
  process.exit(1);
} else {
  console.log('published test vectors match their independent sources');
}
