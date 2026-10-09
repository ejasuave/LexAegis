import { REVIEW_LIMITS, type ReviewLimitCode } from '../contracts/review';
import { fail, ok, type Result } from './hash';

export interface SelectionSizes {
  readonly pdfs: readonly { readonly bytes: number; readonly pages: number }[];
  /** Serialized extraction artifact sizes, when known. */
  readonly extractionBytes: readonly number[];
}

/** Typed limit errors for one selected review. Nothing is silently truncated. */
export function checkSelectionLimits(sizes: SelectionSizes): Result<null, ReviewLimitCode> {
  if (sizes.pdfs.length > REVIEW_LIMITS.pdfsPerReview) return fail('TOO_MANY_PDFS');
  if (sizes.pdfs.some((p) => p.pages > REVIEW_LIMITS.pagesPerPdf))
    return fail('TOO_MANY_PAGES_IN_PDF');
  if (sizes.pdfs.reduce((s, p) => s + p.pages, 0) > REVIEW_LIMITS.pagesPerReview)
    return fail('TOO_MANY_PAGES');
  if (sizes.pdfs.reduce((s, p) => s + p.bytes, 0) > REVIEW_LIMITS.originalBytes)
    return fail('ORIGINALS_TOO_LARGE');
  if (sizes.extractionBytes.some((b) => b > REVIEW_LIMITS.extractionArtifactBytes))
    return fail('EXTRACTION_TOO_LARGE');
  if (sizes.extractionBytes.reduce((s, b) => s + b, 0) > REVIEW_LIMITS.extractionTotalBytes)
    return fail('EXTRACTIONS_TOO_LARGE');
  return ok(null);
}
