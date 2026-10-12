import { canonicalizeJson } from '@lexaegis/protocol/v1';
import {
  EXTRACTION_FORMAT_VERSION,
  REVIEW_LIMITS,
  extractedDocumentSchema,
  type ExtractedDocumentV1,
} from '@lexaegis/agent/contracts';

/*
 * Deterministic text extraction from a text-based PDF with a pinned pdfjs-dist. Pure with
 * respect to its inputs: no clock, no random IDs, no network. Text assembly is one fixed rule:
 * parser item order, each item's string as is, and a newline after an item that reports hasEOL.
 * Nothing is dehyphenated, corrected, reordered or normalised. Offsets are UTF-16 code units.
 */

export const TEXT_ASSEMBLY = 'item-order;hasEOL=newline;other=none;nfc=false' as const;

/** The slice of the pdfjs API this module uses, so the same code runs in a worker and in tests. */
export interface PdfjsLike {
  readonly version: string;
  readonly OPS: Record<string, number>;
  getDocument(params: Record<string, unknown>): PdfLoadingTask;
}
export interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}
interface PdfDocument {
  readonly numPages: number;
  readonly isPureXfa?: boolean;
  getPage(n: number): Promise<PdfPage>;
  getPageLabels(): Promise<string[] | null>;
  destroy(): Promise<void>;
}
interface PdfPage {
  readonly view: number[];
  getTextContent(): Promise<{ items: readonly PdfTextItem[] }>;
  getAnnotations(): Promise<readonly { subtype?: string; fieldType?: string }[]>;
  getOperatorList(): Promise<{ fnArray: readonly number[] }>;
  cleanup(): unknown;
}
interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
  width?: number;
  height?: number;
  transform?: readonly number[];
}

export interface ExtractIdentity {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly sourceArtifactId: string;
  readonly sourceSha256: string;
}

export interface PdfAssets {
  readonly cMapUrl?: string;
  readonly standardFontDataUrl?: string;
}

export type ExtractOutcome =
  | {
      readonly kind: 'extracted';
      readonly document: ExtractedDocumentV1;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: 'partial_coverage';
      readonly document: ExtractedDocumentV1;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: 'no_extractable_text' }
  | { readonly kind: 'password_required' }
  | { readonly kind: 'unsupported'; readonly reason: 'xfa' | 'not_a_pdf' }
  | { readonly kind: 'malformed' }
  | {
      readonly kind: 'limit_exceeded';
      readonly limit: 'pages' | 'items' | 'text' | 'extraction_size';
    }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed' };

/** True when the buffer starts with a PDF header within its first 1,024 bytes. */
export function hasPdfSignature(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

/** Finite number to integer milli-points, or null. Canonical JSON carries no floating point. */
const milliOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e6
    ? Math.round(value * 1000)
    : null;

export async function extractPdf(
  pdfjs: PdfjsLike,
  bytes: Uint8Array,
  identity: ExtractIdentity,
  options: { signal?: AbortSignal; assets?: PdfAssets } = {},
): Promise<ExtractOutcome> {
  if (!hasPdfSignature(bytes)) return { kind: 'unsupported', reason: 'not_a_pdf' };
  const aborted = () => options.signal?.aborted === true;
  // pdf.js may transfer or detach the buffer it is given: parse a private copy.
  const copy = bytes.slice();
  const task = pdfjs.getDocument({
    data: copy,
    // Load nothing the document names, run no scripts, no XFA, no font installation.
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWasm: false,
    // pdf.js would compile PDF function streams with eval; the page policy forbids eval, and a hostile
    // document must never reach a string-to-code path.
    isEvalSupported: false,
    isOffscreenCanvasSupported: false,
    stopAtErrors: false,
    verbosity: 0,
    ...(options.assets?.cMapUrl !== undefined && {
      cMapUrl: options.assets.cMapUrl,
      cMapPacked: true,
    }),
    ...(options.assets?.standardFontDataUrl !== undefined && {
      standardFontDataUrl: options.assets.standardFontDataUrl,
    }),
  });
  try {
    const doc = await task.promise;
    if (aborted()) return { kind: 'cancelled' };
    if (doc.isPureXfa === true) return { kind: 'unsupported', reason: 'xfa' };
    if (doc.numPages > REVIEW_LIMITS.pagesPerPdf) return { kind: 'limit_exceeded', limit: 'pages' };
    const labels = (await doc.getPageLabels().catch(() => null)) ?? null;

    const pages: ExtractedDocumentV1['pages'] = [];
    let annotations = false;
    let forms = false;
    let signatures = false;
    let anyImages = false;
    for (let n = 1; n <= doc.numPages; n += 1) {
      if (aborted()) return { kind: 'cancelled' };
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      if (content.items.length > REVIEW_LIMITS.itemsPerPage)
        return { kind: 'limit_exceeded', limit: 'items' };
      let text = '';
      const items: ExtractedDocumentV1['pages'][number]['items'] = [];
      for (const item of content.items) {
        const str = typeof item.str === 'string' ? item.str : '';
        if (str.length > 0) {
          const start = text.length;
          text += str;
          const t = item.transform;
          items.push({
            start,
            end: text.length,
            box:
              t !== undefined &&
              milliOrNull(t[4]) !== null &&
              milliOrNull(t[5]) !== null &&
              milliOrNull(item.width) !== null &&
              milliOrNull(item.height) !== null
                ? {
                    x: milliOrNull(t[4]) as number,
                    y: milliOrNull(t[5]) as number,
                    width: milliOrNull(item.width) as number,
                    height: milliOrNull(item.height) as number,
                  }
                : null,
          });
        }
        if (item.hasEOL === true) text += '\n';
        if (text.length > 2_000_000) return { kind: 'limit_exceeded', limit: 'text' };
      }
      const notes = await page.getAnnotations().catch(() => []);
      for (const note of notes) {
        annotations = true;
        if (note.subtype === 'Widget') forms = true;
        if (note.fieldType === 'Sig') signatures = true;
      }
      const ops = await page.getOperatorList().catch(() => ({ fnArray: [] as number[] }));
      const imageOps = [
        'paintImageXObject',
        'paintInlineImageXObject',
        'paintImageMaskXObject',
        'paintJpegXObject',
      ]
        .map((name) => pdfjs.OPS[name])
        .filter((op): op is number => typeof op === 'number');
      const hasImages = ops.fnArray.some((op) => imageOps.includes(op));
      anyImages ||= hasImages;
      const width = milliOrNull(page.view[2]);
      const height = milliOrNull(page.view[3]);
      pages.push({
        index: n,
        label: labels?.[n - 1]?.slice(0, 64) ?? null,
        text,
        items,
        width,
        height,
        hasText: text.trim().length > 0,
        hasImages,
      });
      page.cleanup();
    }
    const withText = pages.filter((p) => p.hasText).length;
    if (withText === 0) return { kind: 'no_extractable_text' };
    const warnings: ExtractedDocumentV1['coverage']['warnings'] = [
      'text_order_may_differ_from_layout',
    ];
    if (annotations) warnings.push('annotations_present');
    if (forms) warnings.push('form_fields_present');
    if (signatures) warnings.push('signatures_not_verified');
    if (anyImages) warnings.push('images_not_extracted');
    if (withText < pages.length) warnings.push('pages_without_text');
    warnings.sort();
    const incomplete = warnings.some(
      (w) =>
        w === 'images_not_extracted' || w === 'pages_without_text' || w === 'form_fields_present',
    );
    const document = extractedDocumentSchema.parse({
      schema: 'lexaegis.extracted-document.v1',
      formatVersion: EXTRACTION_FORMAT_VERSION,
      ...identity,
      extractor: {
        name: 'pdfjs-dist',
        version: pdfjs.version,
        options: {
          scripting: 'not_loaded',
          xfa: 'disabled',
          fontFace: 'disabled',
          textAssembly: TEXT_ASSEMBLY,
        },
      },
      pageCount: pages.length,
      pages,
      coverage: {
        status: incomplete ? 'partial' : 'complete',
        pagesWithText: withText,
        pagesWithoutText: pages.length - withText,
        warnings,
      },
    });
    const serialized = canonicalizeJson(document);
    if (serialized.byteLength > REVIEW_LIMITS.extractionArtifactBytes) {
      return { kind: 'limit_exceeded', limit: 'extraction_size' };
    }
    return { kind: incomplete ? 'partial_coverage' : 'extracted', document, bytes: serialized };
  } catch (error) {
    const name = (error as { name?: string } | null)?.name ?? '';
    if (aborted()) return { kind: 'cancelled' };
    if (name === 'PasswordException') return { kind: 'password_required' };
    if (
      name === 'InvalidPDFException' ||
      name === 'FormatError' ||
      name === 'MissingPDFException'
    ) {
      return { kind: 'malformed' };
    }
    return { kind: 'failed' };
  } finally {
    await task.destroy().catch(() => undefined);
    // pdf.js transfers the buffer to its worker, leaving the copy detached (nothing left to zero).
    if (copy.byteLength > 0) copy.fill(0);
  }
}
