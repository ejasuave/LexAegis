import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { extractPdf, hasPdfSignature, type ExtractIdentity, type PdfjsLike } from './extract';

/* Real PDFs from fixtures/documents-v1 parsed by the real pinned pdf.js (Node, legacy build). */

const pdfjs = pdfjsModule as unknown as PdfjsLike;
const dir = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../../fixtures/documents-v1',
);
const load = (name: string) => new Uint8Array(readFileSync(join(dir, 'pdfs', `${name}.pdf`)));
const identity: ExtractIdentity = {
  documentId: '11111111-1111-4111-8111-111111111111',
  documentVersionId: '22222222-2222-4222-8222-222222222222',
  sourceArtifactId: '33333333-3333-4333-8333-333333333333',
  sourceSha256: `0x${'ab'.repeat(32)}`,
};

describe('PDF extraction', () => {
  it('extracts text deterministically and byte-identically on repeat', async () => {
    const a = await extractPdf(pdfjs, load('clean-payment'), identity);
    const b = await extractPdf(pdfjs, load('clean-payment'), identity);
    expect(a.kind).toBe('extracted');
    if (a.kind !== 'extracted' || b.kind !== 'extracted') throw new Error('extraction');
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.document.pages[1]?.text).toContain('Total settlement payment: GBP 24,000');
    expect(a.document.extractor).toMatchObject({ name: 'pdfjs-dist', version: '6.3.289' });
    // No clock or random value enters the serialized artifact.
    expect(new TextDecoder().decode(a.bytes)).not.toMatch(/20\d\d-\d\d-\d\dT/);
  });

  it('records offsets as UTF-16 positions into the page text and display geometry as integers', async () => {
    const out = await extractPdf(pdfjs, load('clean-payment'), identity);
    if (out.kind !== 'extracted') throw new Error(out.kind);
    const page = out.document.pages[0];
    if (page === undefined) throw new Error('page');
    for (const item of page.items) {
      expect(item.end).toBeLessThanOrEqual(page.text.length);
      expect(page.text.slice(item.start, item.end).length).toBe(item.end - item.start);
      expect(Number.isInteger(item.box?.x)).toBe(true);
    }
    expect(page.text.split('\n')[1]).toBe('Employer: Northwind Demo Ltd');
  });

  it("does not alter the caller's buffer", async () => {
    const bytes = load('clean-payment');
    const before = Buffer.from(bytes);
    await extractPdf(pdfjs, bytes, identity);
    expect(Buffer.from(bytes).equals(before)).toBe(true);
  });

  it('returns distinct typed outcomes instead of guessing', async () => {
    expect(
      await extractPdf(pdfjs, new TextEncoder().encode('plain text, not a pdf'), identity),
    ).toEqual({ kind: 'unsupported', reason: 'not_a_pdf' });
    expect(await extractPdf(pdfjs, load('malformed'), identity)).toEqual({ kind: 'malformed' });
    expect(await extractPdf(pdfjs, load('image-only'), identity)).toEqual({
      kind: 'no_extractable_text',
    });
    expect(await extractPdf(pdfjs, load('pages-81'), identity)).toEqual({
      kind: 'limit_exceeded',
      limit: 'pages',
    });
  });

  it('reports partial coverage and its warnings, never a clean extraction', async () => {
    const out = await extractPdf(pdfjs, load('mixed-image-text'), identity);
    expect(out.kind).toBe('partial_coverage');
    if (out.kind !== 'partial_coverage') throw new Error(out.kind);
    expect(out.document.coverage.status).toBe('partial');
    expect(out.document.pages.map((p) => p.hasText)).toEqual([true, false]);
    expect(out.document.pages.map((p) => p.hasImages)).toEqual([false, true]);
  });

  it('stops promptly when cancelled and reports it as cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await extractPdf(pdfjs, load('clean-payment'), identity, { signal: controller.signal }),
    ).toEqual({ kind: 'cancelled' });
  });

  it('recognises a PDF only by its signature, not by name or type', () => {
    expect(hasPdfSignature(load('clean-payment'))).toBe(true);
    expect(hasPdfSignature(new TextEncoder().encode('%PDF-not really but starts'))).toBe(true);
    expect(hasPdfSignature(new TextEncoder().encode('GIF89a'))).toBe(false);
    expect(hasPdfSignature(new Uint8Array(0))).toBe(false);
  });

  it('keeps document text that looks like instructions as inert data', async () => {
    const out = await extractPdf(pdfjs, load('prompt-injection'), identity);
    if (out.kind !== 'extracted') throw new Error(out.kind);
    expect(out.document.pages[0]?.text).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    expect(out.document.coverage.status).toBe('complete');
  });
});
