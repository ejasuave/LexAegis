import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EMPTY_LINE,
  TRACTION_HEADER,
  parseTractionLog,
  renderSummary,
  summarize,
  validateTractionLog,
} from './traction';

/*
 * Every row below is SYNTHETIC. These fixtures live in temporary directories created by the test and
 * never in docs/adoption: the real log must stay exactly as it is.
 */

const repository = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const realLog = join(repository, 'docs', 'adoption', 'traction-log.md');
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const realBefore = sha(readFileSync(realLog, 'utf8'));

let root: string;
const NOTE =
  'SYNTHETIC test note. A dated, consented observation note would describe the event in enough detail to be reviewed by a person later.';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'traction-'));
  const evidence = join(root, 'docs', 'adoption', 'evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, 'note-a.md'), NOTE);
  writeFileSync(join(evidence, 'empty.md'), '');
  writeFileSync(join(evidence, 'placeholder.md'), 'TBD');
  writeFileSync(join(evidence, 'shot.png'), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  writeFileSync(join(root, 'outside.md'), NOTE);
  symlinkSync(join(root, 'outside.md'), join(evidence, 'escape.md'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const header = `| ${TRACTION_HEADER.join(' | ')} |\n| ${TRACTION_HEADER.map(() => '---').join(' | ')} |`;
const row = (...cells: string[]): string => `| ${cells.join(' | ')} |`;
const good = (patch: Partial<Record<string, string>> = {}): string =>
  row(
    patch.id ?? 'SYNTHETIC-001',
    patch.audience ?? 'agent-builders',
    patch.origin ?? 'external',
    patch.status ?? 'contacted',
    patch.observed ?? '2026-10-10',
    patch.evidence ?? 'docs/adoption/evidence/note-a.md',
    patch.review ?? 'reviewed:2026-10-11:SYNTH-R1',
    patch.attribution ?? 'none',
  );
const log = (...rows: string[]): string =>
  `# SYNTHETIC log\n\n${rows.length === 0 ? `${EMPTY_LINE}\n\n` : ''}${header}\n${rows.join('\n')}\n`;
const check = (text: string, today = '2026-10-12') =>
  validateTractionLog(parseTractionLog(text), { today, root });
const codes = (text: string): string[] => check(text).problems.map((problem) => problem.code);

describe('the real log', () => {
  it('stays empty and unchanged: No entries yet, a header-only table, no synthetic row', () => {
    const text = readFileSync(realLog, 'utf8');
    expect(text).toContain(`\n${EMPTY_LINE}\n`);
    expect(text).not.toContain('SYNTHETIC');
    const result = validateTractionLog(parseTractionLog(text), {
      today: '2026-10-12',
      root: repository,
    });
    expect(result).toEqual({ rows: [], problems: [] });
    expect(sha(text)).toBe(realBefore);
  });
});

describe('summary counts', () => {
  it('an empty log succeeds with zero counts', () => {
    const result = check(log());
    expect(result.problems).toEqual([]);
    const summary = summarize(result.rows, '2026-10-12');
    expect(summary.entries).toBe(0);
    expect(Object.values(summary.pitchEligible)).toEqual([0, 0, 0, 0, 0]);
  });

  it('counts every status, splits internal from external, and separates reviewed from pending', () => {
    const result = check(
      log(
        good({ id: 'SYNTHETIC-001', status: 'contacted' }),
        good({ id: 'SYNTHETIC-002', status: 'replied', evidence: 'https://example.invalid/reply' }),
        good({
          id: 'SYNTHETIC-003',
          status: 'call held',
          audience: 'practitioners',
          evidence: 'docs/adoption/evidence/shot.png',
        }),
        good({
          id: 'SYNTHETIC-004',
          status: 'trial started',
          review: 'pending',
          evidence: 'private:EV-004',
        }),
        good({
          id: 'SYNTHETIC-005',
          status: 'integrated',
          origin: 'internal',
          evidence: 'https://example.invalid/internal',
        }),
        good({
          id: 'SYNTHETIC-006',
          status: 'integrated',
          audience: 'legal-tech',
          evidence: 'private:EV-006',
        }),
      ),
    );
    expect(result.problems).toEqual([]);
    const summary = summarize(result.rows, '2026-10-12');
    expect(summary.counts.external['agent-builders'].contacted).toEqual({
      reviewed: 1,
      pending: 0,
    });
    expect(summary.counts.external['agent-builders']['trial started']).toEqual({
      reviewed: 0,
      pending: 1,
    });
    expect(summary.counts.external.practitioners['call held']).toEqual({ reviewed: 1, pending: 0 });
    // The internal integrated row never reaches the external or pitch figures.
    expect(summary.counts.internal['agent-builders'].integrated.reviewed).toBe(1);
    expect(summary.counts.external['legal-tech'].integrated.reviewed).toBe(1);
    expect(summary.pitchEligible).toEqual({
      contacted: 1,
      replied: 1,
      'call held': 1,
      'trial started': 0,
      integrated: 1,
    });
  });

  it('prints no subject, link, path or name', () => {
    const result = check(log(good({ evidence: 'private:EV-777' })));
    const text = renderSummary(summarize(result.rows, '2026-10-12'));
    for (const secret of ['SYNTHETIC-001', 'EV-777', 'note-a', 'docs/adoption', 'https://'])
      expect(text).not.toContain(secret);
  });
});

describe('invalid rows fail instead of being skipped', () => {
  it.each([
    ['a duplicate subject', log(good(), good({ evidence: 'private:EV-002' })), 'DUPLICATE_SUBJECT'],
    [
      'the same evidence for two relationships',
      log(good(), good({ id: 'SYNTHETIC-002' })),
      'DUPLICATE_RELATIONSHIP',
    ],
    ['an unknown status', log(good({ status: 'signed up' })), 'STATUS_UNKNOWN'],
    ['an unknown audience', log(good({ audience: 'investors' })), 'AUDIENCE_UNKNOWN'],
    ['an unknown origin', log(good({ origin: 'partner' })), 'ORIGIN_UNKNOWN'],
    ['a malformed date', log(good({ observed: '2026-02-30' })), 'DATE_MALFORMED'],
    ['a future date', log(good({ observed: '2026-10-13' })), 'DATE_IN_FUTURE'],
    [
      'a review before the observation',
      log(good({ review: 'reviewed:2026-10-01:SYNTH-R1' })),
      'EVIDENCE_REVIEW_BEFORE_OBSERVATION',
    ],
    ['a malformed review', log(good({ review: 'looked fine' })), 'EVIDENCE_REVIEW_MALFORMED'],
    ['a bad subject id', log(good({ id: 'x' })), 'SUBJECT_ID_INVALID'],
    ['a bad attribution', log(good({ attribution: 'maybe' })), 'ATTRIBUTION_UNKNOWN'],
  ])('rejects %s', (_name, text, code) => {
    expect(codes(text)).toContain(code);
  });

  it.each([
    ['a bare yes', 'yes', 'EVIDENCE_INSUFFICIENT'],
    ['NOT YET', 'NOT YET', 'EVIDENCE_INSUFFICIENT'],
    ['consent alone', 'consent given', 'EVIDENCE_INSUFFICIENT'],
    ['an http link', 'http://example.invalid/x', 'EVIDENCE_URL_UNSAFE'],
    [
      'a link with credentials',
      `https://${['user', 'pw'].join(':')}@example.invalid/x`,
      'EVIDENCE_URL_UNSAFE',
    ],
    [
      'a link with a token parameter',
      'https://example.invalid/x?access_token=abc',
      'EVIDENCE_URL_UNSAFE',
    ],
    [
      'a signed storage link',
      'https://example.invalid/files/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef',
      'EVIDENCE_URL_UNSAFE',
    ],
    ['path traversal', 'docs/adoption/evidence/../../../etc/passwd', 'EVIDENCE_PATH_UNSAFE'],
    ['an absolute path', '/etc/passwd', 'EVIDENCE_PATH_UNSAFE'],
    ['a path outside the approved folder', 'docs/SPEC.md', 'EVIDENCE_PATH_UNSAFE'],
    ['an escaped symlink', 'docs/adoption/evidence/escape.md', 'EVIDENCE_PATH_UNSAFE'],
    ['a missing file', 'docs/adoption/evidence/absent.md', 'EVIDENCE_MISSING'],
    ['an empty note', 'docs/adoption/evidence/empty.md', 'EVIDENCE_INSUFFICIENT'],
    ['a placeholder note', 'docs/adoption/evidence/placeholder.md', 'EVIDENCE_INSUFFICIENT'],
  ])('rejects evidence that is %s', (_name, evidence, code) => {
    expect(codes(log(good({ evidence })))).toContain(code);
  });

  it('rejects an empty cell and ambiguous or malformed Markdown', () => {
    expect(codes(log(good({ evidence: '' })))).toContain('MISSING_CELL');
    expect(codes(`${header}\n| only | three | cells |\n`)).toContain('ROW_MALFORMED');
    expect(codes(`| Wrong | Header |\n| --- | --- |\n`)).toContain('HEADER_MISMATCH');
    expect(codes(`${header}\n${good()}\n\n${header}\n`)).toContain('LOG_MALFORMED');
    expect(codes(`${EMPTY_LINE}\n\n${header}\n${good()}\n`)).toContain('EMPTY_LINE_WITH_ROWS');
    expect(codes(`${header}\n`)).toContain('EMPTY_LOG_MISSING_LINE');
    expect(codes('no table at all')).toContain('HEADER_MISMATCH');
  });

  it('does not infer a skipped stage: a later status alone is recorded as it is', () => {
    const result = check(log(good({ status: 'integrated' })));
    const summary = summarize(result.rows, '2026-10-12');
    expect(summary.counts.external['agent-builders'].contacted).toEqual({
      reviewed: 0,
      pending: 0,
    });
    expect(summary.counts.external['agent-builders'].replied).toEqual({ reviewed: 0, pending: 0 });
  });
});

describe('the command', () => {
  const run = (file: string, ...extra: string[]) =>
    spawnSync(
      'pnpm',
      [
        'exec',
        'tsx',
        'tooling/scripts/traction-summary.ts',
        '--log',
        file,
        '--root',
        root,
        '--today',
        '2026-10-12',
        ...extra,
      ],
      { cwd: repository, encoding: 'utf8' },
    );

  it('exits 0 for an empty log and for a valid synthetic sample', () => {
    writeFileSync(join(root, 'empty-log.md'), log());
    writeFileSync(join(root, 'sample-log.md'), log(good()));
    expect(run(join(root, 'empty-log.md')).status).toBe(0);
    const sample = run(join(root, 'sample-log.md'));
    expect(sample.status).toBe(0);
    expect(sample.stdout).toContain('contacted 1 reviewed / 0 pending');
  });

  it('exits nonzero and counts nothing when a row is invalid, without printing the row', () => {
    writeFileSync(
      join(root, 'bad-log.md'),
      log(good(), good({ id: 'SYNTHETIC-002', evidence: 'yes' })),
    );
    const bad = run(join(root, 'bad-log.md'));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/line \d+: EVIDENCE_INSUFFICIENT/);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).not.toContain('SYNTHETIC-002');
  });

  it('leaves the real log untouched', () => {
    expect(sha(readFileSync(realLog, 'utf8'))).toBe(realBefore);
  });
});
