import { describe, expect, it } from 'vitest';
import {
  countLintDiagnostics,
  parseSlither,
  reconcile,
  triageSchema,
  unresolved,
  type Finding,
  type Triage,
} from './static-analysis';

const id = (n: number) => n.toString(16).padStart(64, '0');
const detector = (n: number, check: string, file: string, fn: string | null) => ({
  id: id(n),
  check,
  impact: 'Medium',
  confidence: 'High',
  description: `Something in (/home/someone/project/contracts/${file}#1-2) happened\nmore`,
  elements: [
    fn === null
      ? { type: 'pragma', source_mapping: { filename_relative: file, lines: [4] } }
      : {
          type: 'function',
          name: fn,
          source_mapping: { filename_relative: file, lines: [10, 11, 12] },
          type_specific_fields: { parent: { type: 'contract', name: 'C' }, signature: `${fn}()` },
        },
  ],
});
const output = (detectors: unknown[], extra: object = {}) =>
  JSON.stringify({ success: true, error: null, results: { detectors }, ...extra });
const text = 'a'.repeat(60);
const entry = (
  key: string,
  check: string,
  scope: 'source' | 'dependency',
  ids: string[],
  disposition = 'accepted',
) => ({
  key,
  check,
  scope,
  disposition,
  reasoning: text,
  evidence: text,
  ids,
});
const triage = (slither: unknown[], lint: unknown[] = []): Triage =>
  triageSchema.parse({ schema: 'lexaegis.security.static-analysis-triage.v1', slither, lint });

describe('slither inventory', () => {
  const parsed = parseSlither(
    output([
      detector(2, 'timestamp', 'src/A.sol', 'used'),
      detector(1, 'assembly', 'node_modules/x/B.sol', 'unused'),
      detector(3, 'pragma', 'src/A.sol', null),
    ]),
    new Set(['C.used()']),
  );
  it('keeps every finding with scope, location, reachability and no absolute path', () => {
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.findings.map((finding) => finding.check)).toEqual([
      'assembly',
      'pragma',
      'timestamp',
    ]);
    expect(parsed.findings[0]).toMatchObject({
      scope: 'dependency',
      reachable: false,
      location: 'node_modules/x/B.sol#10-12',
    });
    expect(parsed.findings[1]).toMatchObject({
      scope: 'source',
      reachable: null,
      function: null,
      location: 'src/A.sol#4',
    });
    expect(parsed.findings[2]).toMatchObject({
      scope: 'source',
      reachable: true,
      function: 'C.used()',
    });
    expect(JSON.stringify(parsed.findings)).not.toContain('/home/');
  });
  it('a failed, empty or unreadable run is a tool failure, never a clean result', () => {
    expect(parseSlither('', new Set())).toEqual({ ok: false, reason: 'OUTPUT_UNREADABLE' });
    expect(
      parseSlither(JSON.stringify({ success: false, error: 'compile', results: {} }), new Set()),
    ).toEqual({ ok: false, reason: 'ANALYSIS_FAILED' });
    expect(
      parseSlither(JSON.stringify({ success: true, error: null, results: {} }), new Set()),
    ).toEqual({ ok: false, reason: 'NO_DETECTOR_RESULTS' });
  });
});

describe('triage reconciliation', () => {
  const findings: Finding[] = [
    {
      id: id(1),
      check: 'assembly',
      impact: 'Informational',
      confidence: 'High',
      scope: 'dependency',
      location: 'x',
      function: null,
      reachable: null,
      summary: 's',
    },
    {
      id: id(2),
      check: 'timestamp',
      impact: 'Low',
      confidence: 'Medium',
      scope: 'source',
      location: 'y',
      function: null,
      reachable: null,
      summary: 's',
    },
  ];
  const complete = [
    entry('S-01', 'assembly', 'dependency', [id(1)]),
    entry('S-02', 'timestamp', 'source', [id(2)]),
  ];
  it('passes only when every finding is named exactly once', () => {
    expect(
      reconcile(
        findings,
        { 'block-timestamp': 1 },
        triage(complete, [
          {
            key: 'L-01',
            lint: 'block-timestamp',
            count: 1,
            disposition: 'accepted',
            reasoning: text,
            evidence: text,
          },
        ]),
      ),
    ).toEqual([]);
  });
  it('reports an untriaged finding, a stale entry, a duplicate and a wrong detector or scope', () => {
    const codes = (slither: unknown[]) =>
      reconcile(findings, {}, triage(slither)).map((issue) => issue.code);
    expect(codes([complete[0]])).toEqual(['UNTRIAGED_FINDING']);
    expect(codes([...complete, entry('S-03', 'assembly', 'dependency', [id(9)])])).toEqual([
      'STALE_TRIAGE_ID',
    ]);
    expect(codes([...complete, entry('S-03', 'assembly', 'dependency', [id(1)])])).toEqual([
      'TRIAGED_TWICE',
    ]);
    expect(codes([entry('S-01', 'timestamp', 'dependency', [id(1)]), complete[1]])).toEqual([
      'CHECK_MISMATCH',
    ]);
    expect(codes([entry('S-01', 'assembly', 'source', [id(1)]), complete[1]])).toEqual([
      'SCOPE_MISMATCH',
    ]);
  });
  it('a triage entry cannot name a detector without naming findings (no blanket ignore)', () => {
    expect(() => triage([entry('S-01', 'assembly', 'dependency', [])])).toThrow();
    expect(() =>
      triage([{ ...entry('S-01', 'assembly', 'dependency', [id(1)]), reasoning: 'ok' }]),
    ).toThrow();
  });
  it('suppressed lint diagnostics are counted and must match their triage', () => {
    const lint = (count: number) => [
      {
        key: 'L-01',
        lint: 'reentrancy-events',
        count,
        disposition: 'accepted',
        reasoning: text,
        evidence: text,
      },
    ];
    expect(
      reconcile(findings, { 'reentrancy-events': 4 }, triage(complete, lint(3))).map(
        (issue) => issue.code,
      ),
    ).toEqual(['LINT_COUNT_MISMATCH']);
    expect(
      reconcile(findings, { 'block-timestamp': 1 }, triage(complete)).map((issue) => issue.code),
    ).toEqual(['LINT_UNTRIAGED']);
    expect(reconcile(findings, {}, triage(complete, lint(4))).map((issue) => issue.code)).toEqual([
      'LINT_STALE',
    ]);
    expect(
      countLintDiagnostics(
        'warning[reentrancy-events]: x\n  --> a\nwarning[reentrancy-events]: y\nnote[block-timestamp]: z\n',
      ),
    ).toEqual({ 'reentrancy-events': 2, 'block-timestamp': 1 });
  });
  it('open and redeploy-decision entries stay unresolved', () => {
    expect(
      unresolved(
        triage([
          entry('S-01', 'assembly', 'dependency', [id(1)], 'open'),
          entry('S-02', 'timestamp', 'source', [id(2)], 'requires_redeploy_decision'),
        ]),
      ),
    ).toEqual(['S-01', 'S-02']);
    expect(unresolved(triage(complete))).toEqual([]);
  });
});
