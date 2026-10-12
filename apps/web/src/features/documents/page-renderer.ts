/*
 * Lazy page canvas for the source viewer. At most two canvases render at once and each is capped
 * at 8 million pixels. It draws the page only: no scripts, links, forms or embedded files run,
 * and it never invents a highlight (the viewer shows extracted text passages beside it).
 */

export const MAX_CONCURRENT_RENDERS = 2;
export const MAX_CANVAS_PIXELS = 8_000_000;

let running = 0;
const waiting: (() => void)[] = [];
async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT_RENDERS) {
    running += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
}
function release(): void {
  running -= 1;
  waiting.shift()?.();
}

export type RenderOutcome = 'rendered' | 'too_large' | 'cancelled' | 'failed';

export async function renderPage(
  bytes: Uint8Array,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  signal: AbortSignal,
): Promise<RenderOutcome> {
  await acquire();
  try {
    const aborted = (): boolean => signal.aborted;
    if (aborted()) return 'cancelled';
    const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.mjs',
      import.meta.url,
    ).toString();
    const task = (
      pdfjs.getDocument as (p: Record<string, unknown>) => {
        promise: Promise<RenderDoc>;
        destroy(): Promise<void>;
      }
    )({
      data: bytes.slice(),
      enableXfa: false,
      disableFontFace: true,
      useWasm: false,
      isEvalSupported: false,
      verbosity: 0,
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
    });
    try {
      const doc = await task.promise;
      const page = await doc.getPage(pageNumber);
      const natural = page.getViewport({ scale: 1 });
      let scale = 1.5;
      if (natural.width * natural.height * scale * scale > MAX_CANVAS_PIXELS) {
        scale = Math.sqrt(MAX_CANVAS_PIXELS / (natural.width * natural.height));
        if (scale < 0.1) return 'too_large';
      }
      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const context = canvas.getContext('2d');
      if (context === null || aborted()) return aborted() ? 'cancelled' : 'failed';
      const render = page.render({ canvasContext: context, viewport });
      signal.addEventListener('abort', () => render.cancel(), { once: true });
      await render.promise;
      return aborted() ? 'cancelled' : 'rendered';
    } finally {
      await task.destroy().catch(() => undefined);
    }
  } catch {
    return signal.aborted ? 'cancelled' : 'failed';
  } finally {
    release();
  }
}

interface RenderDoc {
  getPage(n: number): Promise<{
    getViewport(o: { scale: number }): { width: number; height: number };
    render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): {
      promise: Promise<void>;
      cancel(): void;
    };
  }>;
}
