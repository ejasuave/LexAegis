import { sha256Bytes } from '@lexaegis/agent/review';
import { REVIEW_LIMITS } from '@lexaegis/agent/contracts';
import {
  hasPdfSignature,
  type ExtractIdentity,
  type ExtractOutcome,
  type PdfAssets,
} from './extract';

/*
 * One PDF intake job at a time, parsed in a terminable worker. The 30-second deadline and Cancel
 * both terminate the worker (a Promise timeout would leave parsing running). Results are tagged
 * with the job and the vault generation they started in, and a stale result is discarded.
 */

export const INTAKE_DEADLINE_MS = 30_000;
const MAX_PDF_BYTES = 10 * 1024 * 1024;

export interface WorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export type IntakeRefusal = 'too_large' | 'empty' | 'not_a_pdf' | 'busy';
export type IntakeResult =
  | { readonly status: 'refused'; readonly reason: IntakeRefusal }
  | { readonly status: 'timeout' }
  | { readonly status: 'stale' }
  | { readonly status: 'done'; readonly outcome: ExtractOutcome; readonly sourceSha256: string };

export interface IntakeDeps {
  readonly createWorker: () => WorkerLike;
  readonly generation: () => number;
  readonly assets: PdfAssets;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly newJobId?: () => string;
}

export class PdfIntake {
  readonly #deps: IntakeDeps;
  #active: { job: string; worker: WorkerLike; cancel: () => void } | null = null;

  constructor(deps: IntakeDeps) {
    this.#deps = deps;
  }

  get busy(): boolean {
    return this.#active !== null;
  }

  /** Terminates the active job, if any. Its caller receives a cancelled outcome. */
  cancel(): void {
    this.#active?.cancel();
  }

  dispose(): void {
    this.cancel();
  }

  /** `identity.sourceSha256` is filled in here from the original bytes, hashed before any transfer. */
  async run(
    bytes: Uint8Array,
    identity: Omit<ExtractIdentity, 'sourceSha256'>,
  ): Promise<IntakeResult> {
    if (this.#active !== null) return { status: 'refused', reason: 'busy' };
    if (bytes.byteLength === 0) return { status: 'refused', reason: 'empty' };
    if (bytes.byteLength > MAX_PDF_BYTES) return { status: 'refused', reason: 'too_large' };
    if (!hasPdfSignature(bytes)) return { status: 'refused', reason: 'not_a_pdf' };
    const generation = this.#deps.generation();
    const sourceSha256 = await sha256Bytes(bytes);
    if (generation !== this.#deps.generation()) return { status: 'stale' };
    if (this.busy) return { status: 'refused', reason: 'busy' };

    const job = (this.#deps.newJobId ?? (() => crypto.randomUUID()))();
    const worker = this.#deps.createWorker();
    const setTimer = this.#deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer =
      this.#deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    return new Promise<IntakeResult>((resolve) => {
      let finished = false;
      const finish = (result: IntakeResult) => {
        if (finished) return;
        finished = true;
        clearTimer(timer);
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        if (this.#active?.job === job) this.#active = null;
        resolve(result);
      };
      const timer = setTimer(() => finish({ status: 'timeout' }), INTAKE_DEADLINE_MS);
      this.#active = {
        job,
        worker,
        cancel: () => finish({ status: 'done', outcome: { kind: 'cancelled' }, sourceSha256 }),
      };
      worker.onmessage = (event) => {
        const data = event.data as { job?: string; outcome?: ExtractOutcome } | null;
        if (data?.job !== job || data.outcome === undefined) return;
        // A lock, account or matter change since this job started discards the result.
        if (generation !== this.#deps.generation()) {
          finish({ status: 'stale' });
          return;
        }
        finish({ status: 'done', outcome: data.outcome, sourceSha256 });
      };
      worker.onerror = () => finish({ status: 'done', outcome: { kind: 'failed' }, sourceSha256 });
      // The worker gets its own copy; the caller's buffer is untouched.
      const copy = bytes.slice();
      worker.postMessage(
        { job, bytes: copy, identity: { ...identity, sourceSha256 }, assets: this.#deps.assets },
        [copy.buffer],
      );
    });
  }
}

export const browserWorkerFactory = (): WorkerLike =>
  new Worker(new URL('./extract.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;

export const PDF_ASSETS: PdfAssets = {
  cMapUrl: '/pdfjs/cmaps/',
  standardFontDataUrl: '/pdfjs/standard_fonts/',
};

export { REVIEW_LIMITS };
