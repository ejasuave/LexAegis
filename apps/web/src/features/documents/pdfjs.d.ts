/** The standard pdf.js module has no bundled declaration for this subpath; the typed surface used is PdfjsLike. */
declare module 'pdfjs-dist/build/pdf.mjs' {
  export const version: string;
  export const OPS: Record<string, number>;
  export const GlobalWorkerOptions: { workerSrc: string };
  export function getDocument(params: Record<string, unknown>): unknown;
}
