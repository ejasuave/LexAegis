/**
 * Read-only drift check for docs/SPEC.md (run with `pnpm spec:check`). It compares the tagged
 * literals, tables and snippets with the implementation and the committed contract artifacts, and
 * exits nonzero with a factual list of discrepancies. It never rewrites SPEC.md or an expected value.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSpec } from './spec-check';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const markdown = readFileSync(join(root, 'docs', 'SPEC.md'), 'utf8');
const findings = checkSpec(markdown, { root, snippets: !process.argv.includes('--no-snippets') });

for (const finding of findings) console.error(`SPEC  ${finding.tag}  ${finding.message}`);
console.log(
  findings.length === 0
    ? 'SPEC.md matches the implementation, the registry source, the ABI artifact and the vectors'
    : `${String(findings.length)} discrepancy(ies) between SPEC.md and the sources`,
);
process.exit(findings.length === 0 ? 0 : 1);
