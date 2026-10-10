import {
  selectedContextSchema,
  type SelectedContextV1,
  type SourceCatalogEntry,
} from '../contracts/assistant';
import { limitCodeOf } from '../contracts/limits';
import type { ConfirmedFactV1, EvidenceSelectionV1, SourceReferenceV1 } from '../contracts/review';
import { fail, ok, type Result } from './hash';
import { resolveSourceReference, type SourceSet } from './source-references';

/*
 * Selected-context builder. Only deliberately selected excerpts, confirmed facts, evidence
 * descriptors and explicitly selected saved context, inside the 32 KiB limit; an oversized
 * selection is rejected, never truncated. Everything here is untrusted document data: not an
 * instruction, not a permission to fetch a link or use a tool. Building the context sends nothing
 * anywhere: transmission needs the separate consent bound to the exact disclosure.
 */

export interface ContextSelection {
  /** The version the request is about, or null for a matter-level request. */
  readonly documentVersionId: string | null;
  readonly references: readonly SourceReferenceV1[];
  readonly facts: readonly ConfirmedFactV1[];
  readonly evidence: readonly EvidenceSelectionV1[];
  readonly savedContext: readonly {
    readonly entryId: string;
    readonly kind: 'note' | 'outcome';
    readonly text: string;
  }[];
}

export type ContextFailure =
  | 'SOURCE_UNRESOLVED'
  | 'CONTEXT_TOO_LARGE'
  | 'CATALOG_TOO_LARGE'
  | 'QUOTE_TOO_LONG'
  | 'CONTEXT_INVALID';

const referenceKey = (ref: SourceReferenceV1) =>
  `${ref.documentVersionId}:${String(ref.page).padStart(4, '0')}:${String(ref.start).padStart(9, '0')}:${String(ref.end).padStart(9, '0')}`;

/**
 * Builds the context and its handle catalog. Handles S1…Sn follow a deterministic order
 * (document version, page, range) with duplicates removed, so one selection always yields the
 * same catalog. Every reference must resolve against the verified set first.
 */
export function buildSelectedContext(
  set: SourceSet,
  selection: ContextSelection,
): Result<SelectedContextV1, ContextFailure> {
  const unique = new Map<string, SourceReferenceV1>();
  for (const ref of selection.references) unique.set(referenceKey(ref), ref);
  const ordered = [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : 1));

  const sources: SourceCatalogEntry[] = [];
  for (const [, ref] of ordered) {
    const resolved = resolveSourceReference(set, ref);
    const coverage = set.sources.get(ref.documentVersionId)?.extraction.coverage;
    if (resolved.state !== 'resolved' || coverage === undefined) return fail('SOURCE_UNRESOLVED');
    sources.push({
      handle: `S${sources.length + 1}`,
      reference: ref,
      coverage: coverage.status,
      warnings: [...coverage.warnings],
    });
  }

  const parsed = selectedContextSchema.safeParse({
    schema: 'lexaegis.selected-context.v1',
    matterId: set.matterId,
    documentVersionId: selection.documentVersionId,
    untrustedDocumentData: true,
    sources,
    facts: selection.facts,
    evidence: selection.evidence,
    savedContext: selection.savedContext,
    searchedScope: { documentVersionIds: [...set.selected].sort(), excerptsOnly: true },
  });
  if (parsed.success) return ok(parsed.data);
  const limit = limitCodeOf(parsed.error);
  return fail(
    limit === 'CONTEXT_TOO_LARGE' || limit === 'CATALOG_TOO_LARGE' || limit === 'QUOTE_TOO_LONG'
      ? limit
      : 'CONTEXT_INVALID',
  );
}
