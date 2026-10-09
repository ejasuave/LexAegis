import type { DiffOutcome } from '@lexaegis/agent/review';
import { REVIEW_LIMITS } from '@lexaegis/agent/contracts';
import type { WorkerLike } from './pdf-intake';

/**
 * Runs the text diff in a terminable worker. The library's own 2-second limit is backed by a hard
 * worker termination shortly after, so a runaway diff cannot keep running. An aborted or
 * terminated run is reported as incomplete, never as "no changes".
 */
export function createDiffRunner(
  createWorker: () => WorkerLike = () =>
    new Worker(new URL('./compare.worker.ts', import.meta.url), {
      type: 'module',
    }) as unknown as WorkerLike,
  graceMs = 750,
) {
  return (
    oldText: string,
    newText: string,
  ): { promise: Promise<DiffOutcome>; cancel: () => void } => {
    const worker = createWorker();
    const job = crypto.randomUUID();
    let settle: (outcome: DiffOutcome) => void = () => undefined;
    let done = false;
    const promise = new Promise<DiffOutcome>((resolve) => {
      settle = (outcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        resolve(outcome);
      };
    });
    const timer = setTimeout(
      () => settle({ kind: 'incomplete', reason: 'timeout' }),
      REVIEW_LIMITS.compareTimeoutMs + graceMs,
    );
    worker.onmessage = (event) => {
      const data = event.data as { job?: string; outcome?: DiffOutcome } | null;
      if (data?.job === job && data.outcome !== undefined) settle(data.outcome);
    };
    worker.onerror = () => settle({ kind: 'incomplete', reason: 'cancelled' });
    worker.postMessage({ job, oldText, newText });
    return { promise, cancel: () => settle({ kind: 'incomplete', reason: 'cancelled' }) };
  };
}
