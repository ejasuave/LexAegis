import {
  REVIEW_LIMITS,
  SOURCE_REF_SCHEMA,
  extractedDocumentSchema,
  sourceReferenceSchema,
  type ExtractedDocumentV1,
  type SourceReferenceV1,
  type SourceResolution,
} from '../contracts/review';
import { canonicalBytes, fail, ok, sha256Bytes, type Result } from './hash';

/*
 * Exact source references. A reference names a physical page and a UTF-16 range in the stored
 * extraction and must reproduce its quote byte for byte. Hashes and quote matching establish
 * reference consistency, not faithful transcription, factual truth or legal correctness.
 */

export interface LoadedSourceInput {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly sourceArtifactId: string;
  readonly sourceSha256: string;
  readonly sourceBytes: Uint8Array;
  readonly extractionArtifactId: string;
  readonly extractionSha256: string;
  /** The exact stored extraction bytes (canonical JSON). */
  readonly extractionBytes: Uint8Array;
}

export interface VerifiedSource {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly sourceArtifactId: string;
  readonly sourceSha256: string;
  readonly extractionArtifactId: string;
  readonly extractionSha256: string;
  readonly extraction: ExtractedDocumentV1;
}

/** A verified immutable set for one controller generation. Never refreshed in place. */
export interface SourceSet {
  readonly matterId: string;
  readonly sources: ReadonlyMap<string, VerifiedSource>;
  /** Versions currently selected for review. A known but unselected version resolves as stale. */
  readonly selected: ReadonlySet<string>;
}

export type SourceSetFailure =
  | 'SOURCE_HASH_MISMATCH'
  | 'EXTRACTION_HASH_MISMATCH'
  | 'EXTRACTION_INVALID'
  | 'BINDING_MISMATCH'
  | 'DUPLICATE_VERSION';

/** Verifies original and extraction byte hashes and the bindings between them. */
export async function verifySourceSet(
  matterId: string,
  inputs: readonly LoadedSourceInput[],
  selected: readonly string[],
): Promise<Result<SourceSet, SourceSetFailure>> {
  const sources = new Map<string, VerifiedSource>();
  for (const input of inputs) {
    if (sources.has(input.documentVersionId)) return fail('DUPLICATE_VERSION');
    if ((await sha256Bytes(input.sourceBytes)) !== input.sourceSha256)
      return fail('SOURCE_HASH_MISMATCH');
    if ((await sha256Bytes(input.extractionBytes)) !== input.extractionSha256) {
      return fail('EXTRACTION_HASH_MISMATCH');
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.extractionBytes));
    } catch {
      return fail('EXTRACTION_INVALID');
    }
    const parsed = extractedDocumentSchema.safeParse(json);
    if (!parsed.success) return fail('EXTRACTION_INVALID');
    const doc = parsed.data;
    if (
      doc.documentId !== input.documentId ||
      doc.documentVersionId !== input.documentVersionId ||
      doc.sourceArtifactId !== input.sourceArtifactId ||
      doc.sourceSha256 !== input.sourceSha256
    ) {
      return fail('BINDING_MISMATCH');
    }
    sources.set(input.documentVersionId, {
      documentId: input.documentId,
      documentVersionId: input.documentVersionId,
      sourceArtifactId: input.sourceArtifactId,
      sourceSha256: input.sourceSha256,
      extractionArtifactId: input.extractionArtifactId,
      extractionSha256: input.extractionSha256,
      extraction: doc,
    });
  }
  return ok({ matterId, sources, selected: new Set(selected) });
}

/** The deterministic extraction serialization: RFC 8785 canonical JSON in UTF-8. */
export const extractionBytes = (document: ExtractedDocumentV1): Uint8Array =>
  canonicalBytes(document);

/** True when index lies inside a surrogate pair (between a high and a low surrogate). */
function insidePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const before = text.charCodeAt(index - 1);
  const at = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff;
}

export type CreateReferenceFailure =
  | 'VERSION_UNAVAILABLE'
  | 'STALE_VERSION'
  | 'PAGE_INVALID'
  | 'RANGE_INVALID'
  | 'SURROGATE_BOUNDARY'
  | 'QUOTE_TOO_LONG';

/** Creates a reference from an explicit page range. Never from a filename or an approximate match. */
export function createSourceReference(
  set: SourceSet,
  input: { documentVersionId: string; page: number; start: number; end: number },
): Result<SourceReferenceV1, CreateReferenceFailure> {
  const source = set.sources.get(input.documentVersionId);
  if (source === undefined) return fail('VERSION_UNAVAILABLE');
  if (!set.selected.has(input.documentVersionId)) return fail('STALE_VERSION');
  const page = source.extraction.pages[input.page - 1];
  if (page === undefined || page.index !== input.page) return fail('PAGE_INVALID');
  if (
    !Number.isInteger(input.start) ||
    !Number.isInteger(input.end) ||
    input.start < 0 ||
    input.end <= input.start ||
    input.end > page.text.length
  ) {
    return fail('RANGE_INVALID');
  }
  if (insidePair(page.text, input.start) || insidePair(page.text, input.end)) {
    return fail('SURROGATE_BOUNDARY');
  }
  const quote = page.text.slice(input.start, input.end);
  if (new TextEncoder().encode(quote).byteLength > REVIEW_LIMITS.quoteBytes)
    return fail('QUOTE_TOO_LONG');
  const ref = {
    schema: SOURCE_REF_SCHEMA,
    documentId: source.documentId,
    documentVersionId: source.documentVersionId,
    sourceArtifactId: source.sourceArtifactId,
    sourceSha256: source.sourceSha256,
    extractionArtifactId: source.extractionArtifactId,
    extractionSha256: source.extractionSha256,
    page: input.page,
    start: input.start,
    end: input.end,
    quote,
  };
  const parsed = sourceReferenceSchema.safeParse(ref);
  return parsed.success ? ok(parsed.data) : fail('RANGE_INVALID');
}

export interface ResolvedSource {
  readonly state: SourceResolution;
  /** Present only when resolved. */
  readonly page?: number;
  readonly start?: number;
  readonly end?: number;
  readonly text?: string;
  readonly context?: { readonly before: string; readonly after: string };
  readonly warnings?: readonly string[];
}

/** Resolves a reference against the verified set. Every binding must match exactly. */
export function resolveSourceReference(set: SourceSet, reference: unknown): ResolvedSource {
  const parsed = sourceReferenceSchema.safeParse(reference);
  if (!parsed.success) return { state: 'integrity_mismatch' };
  const ref = parsed.data;
  const source = set.sources.get(ref.documentVersionId);
  if (source === undefined) return { state: 'unavailable' };
  if (!set.selected.has(ref.documentVersionId)) return { state: 'stale_version' };
  if (
    source.documentId !== ref.documentId ||
    source.sourceArtifactId !== ref.sourceArtifactId ||
    source.sourceSha256 !== ref.sourceSha256 ||
    source.extractionArtifactId !== ref.extractionArtifactId ||
    source.extractionSha256 !== ref.extractionSha256
  ) {
    return { state: 'integrity_mismatch' };
  }
  const page = source.extraction.pages[ref.page - 1];
  if (page === undefined || page.index !== ref.page || ref.end > page.text.length) {
    return { state: 'integrity_mismatch' };
  }
  if (page.text.slice(ref.start, ref.end) !== ref.quote) return { state: 'integrity_mismatch' };
  return {
    state: 'resolved',
    page: ref.page,
    start: ref.start,
    end: ref.end,
    text: ref.quote,
    context: {
      before: page.text.slice(Math.max(0, ref.start - 80), ref.start),
      after: page.text.slice(ref.end, ref.end + 80),
    },
    warnings: source.extraction.coverage.warnings,
  };
}

/** Splits a long span into bounded references, one per page and at most the quote limit each. */
export function splitIntoReferences(
  set: SourceSet,
  documentVersionId: string,
  page: number,
  start: number,
  end: number,
): Result<SourceReferenceV1[], CreateReferenceFailure> {
  const out: SourceReferenceV1[] = [];
  let cursor = start;
  while (cursor < end) {
    // A chunk of at most 1,000 code units stays under 4 KiB in UTF-8 even at 4 bytes each.
    let stop = Math.min(end, cursor + 1000);
    const text = set.sources.get(documentVersionId)?.extraction.pages[page - 1]?.text ?? '';
    if (insidePair(text, stop)) stop -= 1;
    const made = createSourceReference(set, { documentVersionId, page, start: cursor, end: stop });
    if (!made.ok) return made;
    out.push(made.data);
    cursor = stop;
  }
  return ok(out);
}
