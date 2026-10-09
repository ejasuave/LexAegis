import { diffWordsWithSpace } from 'diff';
import {
  REVIEW_ENGINE_VERSION,
  REVIEW_LIMITS,
  documentComparisonSchema,
  type DocumentComparisonV1,
  type SourceReferenceV1,
} from '../contracts/review';
import { fail, ok, type Result } from './hash';
import { splitIntoReferences, type SourceSet, type VerifiedSource } from './source-references';

/*
 * Bounded comparison of two explicitly selected versions of one matter. Extracted text is compared
 * with case, numbers, punctuation and whitespace preserved: no semantic equivalence, no legal
 * impact, no patching. An aborted comparison is comparison_incomplete, never "no changes", and
 * never a prefix comparison. Identical extracted text does not prove identical PDFs.
 */

export interface CompareSpec {
  readonly matterId: string;
  readonly oldVersionId: string;
  readonly newVersionId: string;
  /** Inclusive physical page ranges. Required when a full text exceeds the input limit. */
  readonly oldPages?: readonly [number, number];
  readonly newPages?: readonly [number, number];
}

interface Segment {
  readonly page: number;
  readonly textStart: number;
  readonly textEnd: number;
  /** Offset of this page's text inside the concatenated input. */
  readonly pageStart: number;
}

export interface CompareSide {
  readonly text: string;
  readonly segments: readonly Segment[];
  readonly pages: readonly [number, number] | null;
}

export interface CompareInputs {
  readonly old: CompareSide;
  readonly new: CompareSide;
}

export type CompareFailure =
  'VERSION_UNAVAILABLE' | 'SAME_VERSION' | 'PAGE_RANGE_INVALID' | 'COMPARE_INPUT_TOO_LARGE';

const PAGE_SEPARATOR = '\n';

function buildSide(
  source: VerifiedSource,
  range: readonly [number, number] | undefined,
): Result<CompareSide, CompareFailure> {
  const pages = source.extraction.pages;
  const [from, to] = range ?? [1, pages.length];
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 1 ||
    to < from ||
    to > pages.length
  ) {
    return fail('PAGE_RANGE_INVALID');
  }
  let text = '';
  const segments: Segment[] = [];
  for (const page of pages.slice(from - 1, to)) {
    if (text !== '') text += PAGE_SEPARATOR;
    segments.push({
      page: page.index,
      textStart: 0,
      textEnd: page.text.length,
      pageStart: text.length,
    });
    text += page.text;
    if (text.length > REVIEW_LIMITS.compareInputCodeUnits) return fail('COMPARE_INPUT_TOO_LARGE');
  }
  return ok({ text, segments, pages: range === undefined ? null : [from, to] });
}

export function prepareComparison(
  set: SourceSet,
  spec: CompareSpec,
): Result<CompareInputs, CompareFailure> {
  if (spec.oldVersionId === spec.newVersionId) return fail('SAME_VERSION');
  const a = set.sources.get(spec.oldVersionId);
  const b = set.sources.get(spec.newVersionId);
  if (
    a === undefined ||
    b === undefined ||
    !set.selected.has(spec.oldVersionId) ||
    !set.selected.has(spec.newVersionId)
  ) {
    return fail('VERSION_UNAVAILABLE');
  }
  const left = buildSide(a, spec.oldPages);
  if (!left.ok) return left;
  const right = buildSide(b, spec.newPages);
  if (!right.ok) return right;
  return ok({ old: left.data, new: right.data });
}

export interface TextChange {
  readonly added: boolean;
  readonly removed: boolean;
  readonly value: string;
}
export type DiffOutcome =
  | { readonly kind: 'done'; readonly changes: readonly TextChange[] }
  | { readonly kind: 'incomplete'; readonly reason: 'edit_distance' | 'timeout' | 'cancelled' };

/** The only CPU-heavy step. The web app runs it in a terminable worker; tests call it directly. */
export function runTextDiff(
  oldText: string,
  newText: string,
  clock: () => number = Date.now,
): DiffOutcome {
  const started = clock();
  const changes = diffWordsWithSpace(oldText, newText, {
    maxEditLength: REVIEW_LIMITS.compareMaxEditDistance,
    timeout: REVIEW_LIMITS.compareTimeoutMs,
  });
  if (changes === undefined) {
    return {
      kind: 'incomplete',
      reason: clock() - started >= REVIEW_LIMITS.compareTimeoutMs ? 'timeout' : 'edit_distance',
    };
  }
  return {
    kind: 'done',
    changes: changes.map((c) => ({
      added: c.added,
      removed: c.removed,
      value: c.value,
    })),
  };
}

/** Maps [start,end) of the concatenated input back to per-page (page, offset) ranges. */
function pageRanges(
  side: CompareSide,
  start: number,
  end: number,
): { page: number; start: number; end: number }[] {
  const out: { page: number; start: number; end: number }[] = [];
  for (const seg of side.segments) {
    const segEnd = seg.pageStart + (seg.textEnd - seg.textStart);
    const from = Math.max(start, seg.pageStart);
    const to = Math.min(end, segEnd);
    if (to > from)
      out.push({ page: seg.page, start: from - seg.pageStart, end: to - seg.pageStart });
  }
  return out;
}

/** Nearest page position for a zero-width insertion point (a navigation anchor, not a quote). */
function anchorAt(side: CompareSide, position: number): { page: number; offset: number } | null {
  const first = side.segments[0];
  if (first === undefined) return null;
  let best = { page: first.page, offset: 0 };
  for (const seg of side.segments) {
    if (position >= seg.pageStart)
      best = { page: seg.page, offset: Math.min(position - seg.pageStart, seg.textEnd) };
  }
  return best;
}

export function assembleComparison(
  set: SourceSet,
  spec: CompareSpec,
  inputs: CompareInputs,
  outcome: DiffOutcome,
): Result<DocumentComparisonV1, 'REFERENCE_FAILED' | 'INVALID'> {
  const a = set.sources.get(spec.oldVersionId) as VerifiedSource;
  const b = set.sources.get(spec.newVersionId) as VerifiedSource;
  const identity = (s: VerifiedSource) => ({
    documentVersionId: s.documentVersionId,
    sourceSha256: s.sourceSha256,
    extractionSha256: s.extractionSha256,
  });
  const warnings = [
    ...new Set([...a.extraction.coverage.warnings, ...b.extraction.coverage.warnings]),
  ].sort();
  const spans: DocumentComparisonV1['spans'] = [];
  let oldPos = 0;
  let newPos = 0;
  let incomplete: DocumentComparisonV1['incompleteReason'] = null;
  if (outcome.kind === 'incomplete') incomplete = outcome.reason;
  else {
    for (const change of outcome.changes) {
      const length = change.value.length;
      if (change.removed || change.added) {
        const side = change.removed ? inputs.old : inputs.new;
        const source = change.removed ? a : b;
        const base = change.removed ? oldPos : newPos;
        const references: SourceReferenceV1[] = [];
        for (const range of pageRanges(side, base, base + length)) {
          const made = splitIntoReferences(
            set,
            source.documentVersionId,
            range.page,
            range.start,
            range.end,
          );
          if (!made.ok) return fail('REFERENCE_FAILED');
          references.push(...made.data);
        }
        spans.push({
          kind: change.removed ? 'removed' : 'added',
          references: references.slice(0, 8),
          anchor: anchorAt(
            change.removed ? inputs.new : inputs.old,
            change.removed ? newPos : oldPos,
          ),
        });
        if (change.removed) oldPos += length;
        else newPos += length;
      } else {
        oldPos += length;
        newPos += length;
      }
      if (spans.length > 2000) {
        incomplete = 'too_large';
        break;
      }
    }
  }
  const finalSpans = incomplete === null ? spans : [];
  const parsed = documentComparisonSchema.safeParse({
    schema: 'lexaegis.document-comparison.v1',
    engineVersion: REVIEW_ENGINE_VERSION,
    matterId: spec.matterId,
    oldVersion: identity(a),
    newVersion: identity(b),
    scope: { oldPages: inputs.old.pages, newPages: inputs.new.pages },
    options: {
      algorithm: 'jsdiff-diffWordsWithSpace',
      maxEditLength: REVIEW_LIMITS.compareMaxEditDistance,
      timeoutMs: REVIEW_LIMITS.compareTimeoutMs,
    },
    outcome:
      incomplete !== null
        ? 'comparison_incomplete'
        : finalSpans.length > 0
          ? 'changes'
          : 'no_text_changes',
    incompleteReason: incomplete,
    originalBytesIdentical: a.sourceSha256 === b.sourceSha256,
    extractionDiffers: a.extractionSha256 !== b.extractionSha256,
    warnings,
    spans: finalSpans,
  });
  return parsed.success ? ok(parsed.data) : fail('INVALID');
}

/** Convenience for non-worker callers. */
export function compareDocumentVersions(set: SourceSet, spec: CompareSpec) {
  const prepared = prepareComparison(set, spec);
  if (!prepared.ok) return prepared;
  const outcome = runTextDiff(prepared.data.old.text, prepared.data.new.text);
  return assembleComparison(set, spec, prepared.data, outcome);
}
