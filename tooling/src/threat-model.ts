import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * docs/THREAT-MODEL.md cites tests as `path` :: test name [suite]. This checks that every citation
 * resolves to a test that exists in the working tree. It does not run them: outcomes come from the
 * suites recorded in the document's "Observed results" table.
 */

export const SUITES = ['F', 'U', 'A', 'B'] as const;
export type Suite = (typeof SUITES)[number];

export interface TestReference {
  readonly caseId: string;
  readonly path: string;
  readonly name: string;
  readonly suite: Suite;
  readonly line: number;
}

export interface ThreatCase {
  readonly id: string;
  readonly line: number;
  readonly references: TestReference[];
  readonly fields: ReadonlySet<string>;
  readonly result: string | null;
}

export interface ThreatIssue {
  readonly code:
    | 'DUPLICATE_ID'
    | 'MISSING_FIELD'
    | 'NO_TEST_AND_NOT_DECLARED'
    | 'REFERENCE_MALFORMED'
    | 'TEST_FILE_MISSING'
    | 'TEST_NAME_MISSING'
    | 'SUITE_MISMATCH';
  readonly caseId: string;
  readonly line: number;
  readonly detail: string;
}

const REQUIRED_FIELDS = [
  'Asset / boundary',
  'Preconditions',
  'Impact',
  'Mitigation',
  'Tests',
  'Result',
  'Residual risk',
] as const;

const CASE = /^#### (TM-[A-Z]\d{2}) /;
const FIELD = /^- ([A-Z][A-Za-z /]+?)(?: \([a-z]+\))?:/;
const REFERENCE = /^ {2}- `([^`]+)` :: (.+) \[([A-Z])\]$/;

export function parseThreatModel(markdown: string): {
  cases: ThreatCase[];
  issues: ThreatIssue[];
} {
  const cases: ThreatCase[] = [];
  const issues: ThreatIssue[] = [];
  const seen = new Set<string>();
  let current: {
    id: string;
    line: number;
    references: TestReference[];
    fields: Set<string>;
    result: string | null;
  } | null = null;
  const lines = markdown.split('\n');
  for (const [index, text] of lines.entries()) {
    const line = index + 1;
    const heading = CASE.exec(text);
    if (heading !== null) {
      const id = heading[1] ?? '';
      if (seen.has(id)) issues.push({ code: 'DUPLICATE_ID', caseId: id, line, detail: id });
      seen.add(id);
      current = { id, line, references: [], fields: new Set(), result: null };
      cases.push(current);
      continue;
    }
    if (text.startsWith('## ')) current = null;
    if (current === null) continue;
    const field = FIELD.exec(text);
    if (field !== null) {
      current.fields.add(field[1] ?? '');
      if (field[1] === 'Result') current.result = text.slice(text.indexOf(':') + 1).trim();
      continue;
    }
    if (/^ {2}- /.test(text)) {
      const reference = REFERENCE.exec(text);
      const suite = reference?.[3];
      if (reference === null || !(SUITES as readonly string[]).includes(suite ?? '')) {
        issues.push({ code: 'REFERENCE_MALFORMED', caseId: current.id, line, detail: text.trim() });
        continue;
      }
      current.references.push({
        caseId: current.id,
        path: reference[1] ?? '',
        name: reference[2] ?? '',
        suite: suite as Suite,
        line,
      });
    }
  }
  for (const item of cases) {
    for (const field of REQUIRED_FIELDS) {
      if (!item.fields.has(field)) {
        issues.push({ code: 'MISSING_FIELD', caseId: item.id, line: item.line, detail: field });
      }
    }
    // A case without a test must say so in its result; it may never read as covered.
    if (item.references.length === 0 && !(item.result ?? '').includes('NO TEST YET')) {
      issues.push({
        code: 'NO_TEST_AND_NOT_DECLARED',
        caseId: item.id,
        line: item.line,
        detail: 'no test reference and the result does not say NO TEST YET',
      });
    }
  }
  return { cases, issues };
}

function expectedSuite(path: string): Suite {
  if (path.endsWith('.t.sol')) return 'F';
  if (path.startsWith('tooling/scripts/') && path.endsWith('-browser-check.ts')) return 'B';
  if (path.startsWith('contracts/integration/')) return 'A';
  return 'U';
}

/** Resolves every reference against the files under `root`. */
export function checkReferences(root: string, cases: readonly ThreatCase[]): ThreatIssue[] {
  const issues: ThreatIssue[] = [];
  const cache = new Map<string, string | null>();
  const read = (path: string): string | null => {
    if (!cache.has(path)) {
      const full = join(root, path);
      cache.set(path, existsSync(full) ? readFileSync(full, 'utf8') : null);
    }
    return cache.get(path) ?? null;
  };
  for (const reference of cases.flatMap((item) => item.references)) {
    const base = { caseId: reference.caseId, line: reference.line };
    if (reference.path.includes('..') || reference.path.startsWith('/')) {
      issues.push({ ...base, code: 'TEST_FILE_MISSING', detail: reference.path });
      continue;
    }
    const text = read(reference.path);
    if (text === null) {
      issues.push({ ...base, code: 'TEST_FILE_MISSING', detail: reference.path });
      continue;
    }
    const present =
      reference.suite === 'F'
        ? new RegExp(`function ${reference.name}\\(`).test(text)
        : text.includes(reference.name);
    if (!present) {
      issues.push({
        ...base,
        code: 'TEST_NAME_MISSING',
        detail: `${reference.path} :: ${reference.name}`,
      });
    }
    if (expectedSuite(reference.path) !== reference.suite) {
      issues.push({
        ...base,
        code: 'SUITE_MISMATCH',
        detail: `${reference.path} is suite ${expectedSuite(reference.path)}, cited as ${reference.suite}`,
      });
    }
  }
  return issues;
}
