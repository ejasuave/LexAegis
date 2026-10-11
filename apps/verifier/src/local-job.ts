import type { JobInput, JobOutcome, JobProgress } from './verification-job';
import type { WorkerRequest, WorkerResponse } from './verification-worker';

/** The 30-second limit for one local job. Enforced by terminating the worker, not by a Promise race. */
export const LOCAL_JOB_DEADLINE_MS = 30_000;

/** The slice of a Worker the job runner uses, so tests can supply an in-process stand-in. */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror?: ((event: MessageEvent) => void) | null;
}

export type WorkerFactory = () => WorkerLike;

export interface LocalJobHandle {
  readonly result: Promise<JobOutcome>;
  /** Terminates the worker and settles the result as CANCELLED. Safe to call twice. */
  cancel(): void;
}

/**
 * Starts a local job in a fresh dedicated worker. The buffer is transferred, so no copy stays on
 * this thread. A deadline, a cancel or any worker error terminates the worker, which stops the
 * parsing and hashing itself. Results for another generation are ignored by the caller.
 */
export function startLocalJob(
  createWorker: WorkerFactory,
  generation: number,
  input: JobInput,
  onProgress: (update: JobProgress) => void,
  deadlineMs: number = LOCAL_JOB_DEADLINE_MS,
): LocalJobHandle {
  const worker = createWorker();
  let settle: (outcome: JobOutcome) => void = () => undefined;
  let finished = false;
  const result = new Promise<JobOutcome>((resolve) => {
    settle = resolve;
  });
  const finish = (outcome: JobOutcome) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    settle(outcome);
  };
  const timer = setTimeout(() => finish({ ok: false, code: 'DEADLINE' }), deadlineMs);

  worker.onmessage = (event) => {
    const message = event.data;
    if (message.generation !== generation) return;
    if (message.type === 'progress') onProgress(message.update);
    else finish(message.outcome);
  };
  worker.onerror = () => finish({ ok: false, code: 'WORKER_FAILED' });
  worker.onmessageerror = () => finish({ ok: false, code: 'WORKER_FAILED' });
  worker.postMessage({ type: 'run', generation, input }, [input.bytes]);
  return { result, cancel: () => finish({ ok: false, code: 'CANCELLED' }) };
}
