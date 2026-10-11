import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkReferences, parseThreatModel } from './threat-model';

const root = mkdtempSync(join(tmpdir(), 'threat-model-'));
mkdirSync(join(root, 'contracts/test'), { recursive: true });
mkdirSync(join(root, 'packages/a'), { recursive: true });
writeFileSync(join(root, 'contracts/test/X.t.sol'), 'function test_real() public {}\n');
writeFileSync(join(root, 'packages/a/a.test.ts'), "it('does the thing', () => {});\n");
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const caseText = (tests: string, result = 'pass.') => `## Abuse cases

#### TM-A01 Example

- Asset / boundary: A5.
- Preconditions: something.
- Impact: something.
- Mitigation (implemented): something.
- Tests:
${tests}
- Result: ${result}
- Residual risk: none known.
`;

describe('threat model references', () => {
  it('accepts a case whose citations resolve to existing tests', () => {
    const parsed = parseThreatModel(
      caseText(
        '  - `contracts/test/X.t.sol` :: test_real [F]\n  - `packages/a/a.test.ts` :: does the thing [U]',
      ),
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.cases[0]?.references).toHaveLength(2);
    expect(checkReferences(root, parsed.cases)).toEqual([]);
  });
  it('rejects a missing file, a missing test name and a wrong suite tag (negative controls)', () => {
    const parsed = parseThreatModel(
      caseText(
        [
          '  - `packages/a/gone.test.ts` :: does the thing [U]',
          '  - `packages/a/a.test.ts` :: does another thing [U]',
          '  - `contracts/test/X.t.sol` :: test_re [F]',
          '  - `contracts/test/X.t.sol` :: test_real [U]',
          '  - `../outside.test.ts` :: x [U]',
        ].join('\n'),
      ),
    );
    expect(checkReferences(root, parsed.cases).map((issue) => issue.code)).toEqual([
      'TEST_FILE_MISSING',
      'TEST_NAME_MISSING',
      'TEST_NAME_MISSING',
      'SUITE_MISMATCH',
      'TEST_FILE_MISSING',
    ]);
  });
  it('a case with no test must say NO TEST YET, and a malformed citation is reported', () => {
    expect(parseThreatModel(caseText('')).issues.map((issue) => issue.code)).toEqual([
      'NO_TEST_AND_NOT_DECLARED',
    ]);
    expect(parseThreatModel(caseText('', 'NO TEST YET.')).issues).toEqual([]);
    expect(
      parseThreatModel(caseText('  - packages/a/a.test.ts does the thing')).issues.map(
        (issue) => issue.code,
      ),
    ).toEqual(['REFERENCE_MALFORMED', 'NO_TEST_AND_NOT_DECLARED']);
  });
  it('requires every field and unique identifiers', () => {
    const text = caseText('  - `packages/a/a.test.ts` :: does the thing [U]');
    expect(
      parseThreatModel(text.replace('- Impact: something.\n', '')).issues.map(
        (issue) => issue.detail,
      ),
    ).toEqual(['Impact']);
    expect(
      parseThreatModel(`${text}\n${text.replace('## Abuse cases\n', '')}`).issues.map(
        (issue) => issue.code,
      ),
    ).toEqual(['DUPLICATE_ID']);
  });
});
