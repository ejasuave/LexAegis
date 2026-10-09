/// Dedicated, terminable worker for PDF parsing. It receives bytes and an identity, never a URL,
/// and answers with one typed outcome. Nothing is persisted, logged or fetched except the
/// same-origin static parser assets (fonts and character maps).
import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import { extractPdf, type ExtractIdentity, type PdfAssets, type PdfjsLike } from './extract';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString();

interface Request {
  readonly job: string;
  readonly bytes: Uint8Array;
  readonly identity: ExtractIdentity;
  readonly assets: PdfAssets;
}

const scope = self as unknown as {
  onmessage: ((event: { data: Request }) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (event) => {
  const { job, bytes, identity, assets } = event.data;
  void extractPdf(pdfjs as unknown as PdfjsLike, bytes, identity, { assets }).then((outcome) => {
    const transfer: Transferable[] = [];
    if ('bytes' in outcome) transfer.push(outcome.bytes.buffer as ArrayBuffer);
    scope.postMessage({ job, outcome }, transfer);
  });
};
