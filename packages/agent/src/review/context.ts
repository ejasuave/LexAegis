import { REVIEW_LIMITS, type ConfirmedFactV1, type SourceReferenceV1 } from '../contracts/review';
import { fail, ok, type Result } from './hash';
import { resolveSourceReference, type SourceSet } from './source-references';

/*
 * Selected-context builder for the future assistant. Only deliberately selected excerpts and
 * confirmed facts, inside the 32 KiB limit; oversized selections are rejected, never truncated.
 * Everything here is untrusted document data: not an instruction, not a permission to fetch a
 * link or use a tool. Building the context sends nothing anywhere: transmission needs the
 * separate consent Chapter 9 defines, naming the provider, matter, version and disclosed content.
 */

export interface SelectedContextV1 {
  readonly schema: 'lexaegis.selected-context.v1';
  readonly matterId: string;
  readonly untrustedDocumentData: true;
  readonly excerpts: readonly {
    readonly page: number;
    readonly documentVersionId: string;
    readonly text: string;
  }[];
  readonly facts: readonly {
    readonly field: string;
    readonly value: string;
    readonly basis: string;
  }[];
  readonly bytes: number;
}

export function buildSelectedContext(
  set: SourceSet,
  selection: { references: readonly SourceReferenceV1[]; facts: readonly ConfirmedFactV1[] },
): Result<SelectedContextV1, 'SOURCE_UNRESOLVED' | 'CONTEXT_TOO_LARGE'> {
  const excerpts: SelectedContextV1['excerpts'][number][] = [];
  for (const ref of selection.references) {
    const resolved = resolveSourceReference(set, ref);
    if (
      resolved.state !== 'resolved' ||
      resolved.text === undefined ||
      resolved.page === undefined
    ) {
      return fail('SOURCE_UNRESOLVED');
    }
    excerpts.push({
      page: resolved.page,
      documentVersionId: ref.documentVersionId,
      text: resolved.text,
    });
  }
  const body = {
    schema: 'lexaegis.selected-context.v1' as const,
    matterId: set.matterId,
    untrustedDocumentData: true as const,
    excerpts,
    facts: selection.facts.map((f) => ({ field: f.field, value: f.value, basis: f.basis })),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
  if (bytes > REVIEW_LIMITS.contextBytes) return fail('CONTEXT_TOO_LARGE');
  return ok({ ...body, bytes });
}
