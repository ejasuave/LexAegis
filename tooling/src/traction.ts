import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/*
 * The traction log reader. The log is a Markdown table with one CURRENT row per actual relationship or
 * project; dated history lives in the referenced notes. This module validates rows and counts them. It
 * cannot prove that a person or an observation is genuine: it checks that a record is well formed,
 * carries a specific evidence reference, and that a human recorded having reviewed that evidence.
 * Everything here is offline and read-only: remote links are checked for syntax, never fetched.
 */

export const TRACTION_HEADER = [
  'Subject ID',
  'Audience',
  'Origin',
  'Status',
  'Observed',
  'Evidence',
  'Evidence review',
  'Attribution',
] as const;
export const EMPTY_LINE = 'No entries yet';

export const AUDIENCES = ['agent-builders', 'legal-tech', 'practitioners'] as const;
export const ORIGINS = ['internal', 'external'] as const;
/** The ladder, in order. A later status never proves an earlier one happened. */
export const STATUSES = [
  'contacted',
  'replied',
  'call held',
  'trial started',
  'integrated',
] as const;
export const ATTRIBUTIONS = ['none', 'anonymous', 'named'] as const;

export type Audience = (typeof AUDIENCES)[number];
export type Origin = (typeof ORIGINS)[number];
export type Status = (typeof STATUSES)[number];

export const TRACTION_ERRORS = [
  'LOG_MALFORMED',
  'HEADER_MISMATCH',
  'ROW_MALFORMED',
  'EMPTY_LINE_WITH_ROWS',
  'EMPTY_LOG_MISSING_LINE',
  'MISSING_CELL',
  'SUBJECT_ID_INVALID',
  'DUPLICATE_SUBJECT',
  'DUPLICATE_RELATIONSHIP',
  'AUDIENCE_UNKNOWN',
  'ORIGIN_UNKNOWN',
  'STATUS_UNKNOWN',
  'ATTRIBUTION_UNKNOWN',
  'DATE_MALFORMED',
  'DATE_IN_FUTURE',
  'EVIDENCE_INSUFFICIENT',
  'EVIDENCE_URL_UNSAFE',
  'EVIDENCE_PATH_UNSAFE',
  'EVIDENCE_MISSING',
  'EVIDENCE_REVIEW_MALFORMED',
  'EVIDENCE_REVIEW_BEFORE_OBSERVATION',
] as const;
export type TractionError = (typeof TRACTION_ERRORS)[number];

export interface TractionRow {
  readonly line: number;
  readonly subject: string;
  readonly audience: Audience;
  readonly origin: Origin;
  readonly status: Status;
  readonly observed: string;
  readonly evidence: string;
  readonly reviewed: boolean;
  readonly attribution: string;
}

export interface TractionProblem {
  /** 1-based line in the log. Never a subject, name, link or path. */
  readonly line: number;
  readonly code: TractionError;
}

export interface ParsedLog {
  readonly rows: readonly string[][];
  readonly rowLines: readonly number[];
  readonly emptyLine: boolean;
  readonly problems: readonly TractionProblem[];
}

const splitRow = (text: string): string[] | null => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  // Cells may not contain an unescaped pipe: an ambiguous row is rejected, not guessed at.
  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
};

/** A strict table reader: one header, one separator, then rows with exactly the canonical cells. */
export function parseTractionLog(markdown: string): ParsedLog {
  const lines = markdown.split('\n');
  const problems: TractionProblem[] = [];
  const rows: string[][] = [];
  const rowLines: number[] = [];
  let headerAt = -1;
  let emptyLine = false;
  let state: 'before' | 'separator' | 'rows' | 'after' = 'before';
  let fenced = false;
  for (const [index, raw] of lines.entries()) {
    const number = index + 1;
    const text = raw.trim();
    // Fenced examples in the documentation are not log content.
    if (text.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (text === EMPTY_LINE) emptyLine = true;
    if (state === 'before') {
      if (text.startsWith('|')) {
        const cells = splitRow(text);
        if (cells === null || cells.join('|') !== TRACTION_HEADER.join('|')) {
          problems.push({ line: number, code: 'HEADER_MISMATCH' });
          return { rows, rowLines, emptyLine, problems };
        }
        headerAt = index;
        state = 'separator';
      }
      continue;
    }
    if (state === 'separator') {
      const cells = splitRow(text);
      if (
        cells === null ||
        cells.length !== TRACTION_HEADER.length ||
        !cells.every((c) => /^:?-{3,}:?$/.test(c))
      ) {
        problems.push({ line: number, code: 'LOG_MALFORMED' });
        return { rows, rowLines, emptyLine, problems };
      }
      state = 'rows';
      continue;
    }
    if (state === 'rows') {
      if (!text.startsWith('|')) {
        state = 'after';
        continue;
      }
      const cells = splitRow(text);
      if (cells === null || cells.length !== TRACTION_HEADER.length) {
        problems.push({ line: number, code: 'ROW_MALFORMED' });
        continue;
      }
      rows.push(cells);
      rowLines.push(number);
      continue;
    }
    // After the table: another pipe line is a second, ambiguous table.
    if (text.startsWith('|')) problems.push({ line: number, code: 'LOG_MALFORMED' });
  }
  if (headerAt < 0) problems.push({ line: 1, code: 'HEADER_MISMATCH' });
  return { rows, rowLines, emptyLine, problems };
}

const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const REVIEW = /^reviewed:(\d{4}-\d{2}-\d{2}):([A-Za-z0-9._-]{2,40})$/;
const PRIVATE_REFERENCE = /^private:[A-Z0-9][A-Z0-9-]{2,29}$/;
const PLACEHOLDER =
  /^(?:yes|no|y|n|ok|done|tbd|todo|n\/a|na|none|pending|not yet|consent(?: given)?|placeholder|link|see notes?|[-—.?]+)$/i;
const SECRET_QUERY =
  /(?:token|secret|key|password|passwd|sig|signature|credential|auth|session|x-amz-|x-goog-|access)/i;

export const EVIDENCE_ROOT = 'docs/adoption/evidence';

function validDate(text: string): Date | null {
  const match = DATE.exec(text);
  if (match === null) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? null : date;
}

export interface ValidateOptions {
  /** The current day, injected for tests. Observations after it are rejected. */
  readonly today: string;
  /** Absolute repository root; local evidence resolves only inside `<root>/docs/adoption/evidence`. */
  readonly root: string;
}

function checkUrl(value: string): TractionError | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'EVIDENCE_URL_UNSAFE';
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '')
    return 'EVIDENCE_URL_UNSAFE';
  for (const key of url.searchParams.keys())
    if (SECRET_QUERY.test(key)) return 'EVIDENCE_URL_UNSAFE';
  // A long opaque path segment is how signed storage links and private tokens look.
  if (url.pathname.split('/').some((segment) => /^[A-Za-z0-9_-]{40,}$/.test(segment)))
    return 'EVIDENCE_URL_UNSAFE';
  return null;
}

function checkLocal(value: string, options: ValidateOptions): TractionError | null {
  if (
    isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').includes('..') ||
    !value.startsWith(`${EVIDENCE_ROOT}/`)
  )
    return 'EVIDENCE_PATH_UNSAFE';
  const allowed = join(options.root, EVIDENCE_ROOT);
  const target = resolve(options.root, value);
  if (!existsSync(allowed)) return 'EVIDENCE_MISSING';
  if (!existsSync(target)) return 'EVIDENCE_MISSING';
  // An escaped symlink destination is refused: the real path must stay inside the approved folder.
  const real = realpathSync(target);
  const realRoot = realpathSync(allowed);
  const inside = relative(realRoot, real);
  if (
    inside === '' ||
    inside.startsWith('..') ||
    isAbsolute(inside) ||
    inside.split(sep).includes('..')
  )
    return 'EVIDENCE_PATH_UNSAFE';
  const stat = lstatSync(real);
  if (!stat.isFile()) return 'EVIDENCE_PATH_UNSAFE';
  if (/\.(?:md|txt)$/i.test(value)) {
    // A substantive note, not an empty or placeholder file. It is read, never executed or followed.
    const text = readFileSync(real, 'utf8').replace(/\s+/g, ' ').trim();
    if (text.length < 80 || PLACEHOLDER.test(text)) return 'EVIDENCE_INSUFFICIENT';
  } else if (!/\.(?:png|jpe?g|webp|gif|pdf)$/i.test(value)) {
    return 'EVIDENCE_PATH_UNSAFE';
  } else if (stat.size === 0) {
    return 'EVIDENCE_INSUFFICIENT';
  }
  return null;
}

export interface ValidatedLog {
  readonly rows: readonly TractionRow[];
  readonly problems: readonly TractionProblem[];
}

export function validateTractionLog(parsed: ParsedLog, options: ValidateOptions): ValidatedLog {
  const problems: TractionProblem[] = [...parsed.problems];
  const rows: TractionRow[] = [];
  if (parsed.rows.length > 0 && parsed.emptyLine)
    problems.push({ line: 1, code: 'EMPTY_LINE_WITH_ROWS' });
  if (parsed.rows.length === 0 && !parsed.emptyLine && parsed.problems.length === 0)
    problems.push({ line: 1, code: 'EMPTY_LOG_MISSING_LINE' });
  const today = validDate(options.today);
  const subjects = new Set<string>();
  const evidenceUse = new Map<string, string>();
  for (const [index, cells] of parsed.rows.entries()) {
    const line = parsed.rowLines[index] ?? 0;
    const bad = (code: TractionError): void => {
      problems.push({ line, code });
    };
    const [
      subject = '',
      audience = '',
      origin = '',
      status = '',
      observed = '',
      evidence = '',
      review = '',
      attribution = '',
    ] = cells;
    if (cells.some((cell) => cell === '')) {
      bad('MISSING_CELL');
      continue;
    }
    let ok = true;
    if (!SUBJECT.test(subject)) {
      bad('SUBJECT_ID_INVALID');
      ok = false;
    } else if (subjects.has(subject)) {
      bad('DUPLICATE_SUBJECT');
      ok = false;
    }
    subjects.add(subject);
    if (!(AUDIENCES as readonly string[]).includes(audience)) {
      bad('AUDIENCE_UNKNOWN');
      ok = false;
    }
    if (!(ORIGINS as readonly string[]).includes(origin)) {
      bad('ORIGIN_UNKNOWN');
      ok = false;
    }
    if (!(STATUSES as readonly string[]).includes(status)) {
      bad('STATUS_UNKNOWN');
      ok = false;
    }
    if (!(ATTRIBUTIONS as readonly string[]).includes(attribution)) {
      bad('ATTRIBUTION_UNKNOWN');
      ok = false;
    }
    const observedDate = validDate(observed);
    if (observedDate === null) {
      bad('DATE_MALFORMED');
      ok = false;
    } else if (today !== null && observedDate.getTime() > today.getTime()) {
      bad('DATE_IN_FUTURE');
      ok = false;
    }
    // Evidence: a safe https link, a private reference, or a note/screenshot inside the approved folder.
    let evidenceError: TractionError | null;
    if (PLACEHOLDER.test(evidence) || evidence.length < 4) evidenceError = 'EVIDENCE_INSUFFICIENT';
    else if (/^https?:\/\//i.test(evidence)) evidenceError = checkUrl(evidence);
    else if (PRIVATE_REFERENCE.test(evidence)) evidenceError = null;
    else evidenceError = checkLocal(evidence, options);
    if (evidenceError !== null) {
      bad(evidenceError);
      ok = false;
    }
    const earlier = evidenceUse.get(evidence);
    if (earlier !== undefined && earlier !== subject) {
      // One piece of evidence for two relationships is a conflicting duplicate, not two data points.
      bad('DUPLICATE_RELATIONSHIP');
      ok = false;
    }
    evidenceUse.set(evidence, subject);
    let reviewed = false;
    if (review !== 'pending') {
      const match = REVIEW.exec(review);
      const reviewDate = match === null ? null : validDate(match[1] ?? '');
      if (match === null || reviewDate === null) {
        bad('EVIDENCE_REVIEW_MALFORMED');
        ok = false;
      } else if (observedDate !== null && reviewDate.getTime() < observedDate.getTime()) {
        bad('EVIDENCE_REVIEW_BEFORE_OBSERVATION');
        ok = false;
      } else if (today !== null && reviewDate.getTime() > today.getTime()) {
        bad('DATE_IN_FUTURE');
        ok = false;
      } else {
        reviewed = true;
      }
    }
    if (ok)
      rows.push({
        line,
        subject,
        audience: audience as Audience,
        origin: origin as Origin,
        status: status as Status,
        observed,
        evidence,
        reviewed,
        attribution,
      });
  }
  return { rows, problems };
}

export interface Cell {
  readonly reviewed: number;
  readonly pending: number;
}
export interface Summary {
  readonly asOf: string;
  readonly entries: number;
  /** counts[origin][audience][status] */
  readonly counts: Readonly<
    Record<Origin, Readonly<Record<Audience, Readonly<Record<Status, Cell>>>>>
  >;
  /** External AND evidence-reviewed only: what a pitch may cite, per status, never summed across statuses. */
  readonly pitchEligible: Readonly<Record<Status, number>>;
}

export function summarize(rows: readonly TractionRow[], asOf: string): Summary {
  const empty = (): Record<Status, { reviewed: number; pending: number }> =>
    Object.fromEntries(STATUSES.map((status) => [status, { reviewed: 0, pending: 0 }])) as never;
  const counts = Object.fromEntries(
    ORIGINS.map((origin) => [
      origin,
      Object.fromEntries(AUDIENCES.map((audience) => [audience, empty()])),
    ]),
  ) as Record<Origin, Record<Audience, Record<Status, { reviewed: number; pending: number }>>>;
  const pitch = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<Status, number>;
  for (const row of rows) {
    counts[row.origin][row.audience][row.status][row.reviewed ? 'reviewed' : 'pending'] += 1;
    if (row.origin === 'external' && row.reviewed) pitch[row.status] += 1;
  }
  return { asOf, entries: rows.length, counts, pitchEligible: pitch };
}

export function renderSummary(summary: Summary): string {
  const lines = [
    `Traction summary as of ${summary.asOf}: ${String(summary.entries)} current relationship(s).`,
    'Counts are CURRENT statuses of separate relationships; they are not additive and not a customer count.',
    '',
  ];
  for (const origin of ORIGINS) {
    lines.push(
      `${origin.toUpperCase()}${origin === 'internal' ? ' (team-authored examples and internal trials: never external adoption)' : ''}`,
    );
    for (const audience of AUDIENCES) {
      const parts = STATUSES.map((status) => {
        const cell = summary.counts[origin][audience][status];
        return `${status} ${String(cell.reviewed)} reviewed / ${String(cell.pending)} pending`;
      });
      lines.push(`  ${audience}: ${parts.join('; ')}`);
    }
  }
  lines.push(
    '',
    'PITCH-ELIGIBLE (external, evidence reviewed by a person; each status stands alone):',
  );
  for (const status of STATUSES)
    lines.push(`  ${status}: ${String(summary.pitchEligible[status])}`);
  lines.push(
    '',
    'Pending (unreviewed or inaccessible) and internal rows are excluded from the pitch-eligible figures.',
    'This command validates records. It cannot prove that a person or an observation is genuine.',
  );
  return `${lines.join('\n')}\n`;
}
