/**
 * pnpm threat:check: every test cited by docs/THREAT-MODEL.md exists, every case has its required
 * fields, and a case with no test says NO TEST YET. It does not run the tests.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkReferences, parseThreatModel } from '../src/threat-model';
import { ROOT } from './lib';

const { cases, issues } = parseThreatModel(
  readFileSync(join(ROOT, 'docs', 'THREAT-MODEL.md'), 'utf8'),
);
const all = [...issues, ...checkReferences(ROOT, cases)];
for (const issue of all) {
  console.log(`FAIL  ${issue.caseId}  ${issue.code}  line ${String(issue.line)}  ${issue.detail}`);
}
const references = cases.reduce((sum, item) => sum + item.references.length, 0);
const uncovered = cases.filter((item) => (item.result ?? '').includes('NO TEST YET'));
console.log(
  `${String(cases.length)} cases, ${String(references)} test references, ${String(uncovered.length)} with a declared NO TEST YET (${uncovered.map((item) => item.id).join(', ')}), ${String(all.length)} issue(s)`,
);
if (cases.length === 0 || all.length > 0) process.exit(1);
