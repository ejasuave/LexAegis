import { describe, expect, it } from 'vitest';
import { startLocalJob, type WorkerLike } from './local-job';
import { runVerificationJob, type JobInput } from './verification-job';
import type { WorkerRequest, WorkerResponse } from './verification-worker';
import { exportBytes } from './test-helpers';

/** An in-process stand-in that runs the real job logic, or hangs, or fails, on demand. */
function worker(mode: 'run' | 'hang' | 'crash' | 'stale'): WorkerLike & { terminated: boolean } {
  const self: WorkerLike & { terminated: boolean } = {
    terminated: false,
    onmessage: null,
    onerror: null,
    terminate() {
      self.terminated = true;
    },
    postMessage(message: WorkerRequest) {
      if (mode === 'hang') return;
      if (mode === 'crash') {
        setTimeout(() => self.onerror?.({} as ErrorEvent), 0);
        return;
      }
      const post = (response: WorkerResponse) =>
        self.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
      if (mode === 'stale') {
        setTimeout(
          () =>
            post({
              type: 'done',
              generation: message.generation + 1,
              outcome: { ok: false, code: 'SCHEMA_INVALID' },
            }),
          0,
        );
        return;
      }
      void runVerificationJob(message.input as JobInput, (update) =>
        post({ type: 'progress', generation: message.generation, update }),
      ).then((outcome) => post({ type: 'done', generation: message.generation, outcome }));
    },
  };
  return self;
}

const input = (): JobInput => {
  const bytes = exportBytes('legal');
  return {
    kind: 'file',
    bytes: bytes.buffer,
    expectedReference: undefined,
    hasExpectedReference: false,
  };
};

describe('local job runner', () => {
  it('transfers the buffer, relays progress and terminates the worker when done', async () => {
    const instance = worker('run');
    const seen: string[] = [];
    const job = startLocalJob(
      () => instance,
      5,
      input(),
      (update) => seen.push(update.stage),
    );
    const outcome = await job.result;
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual(['parsing', 'decoded', 'hashing']);
    expect(instance.terminated).toBe(true);
  });

  it('terminates a worker that outlives the deadline, rather than racing a Promise', async () => {
    const instance = worker('hang');
    const job = startLocalJob(
      () => instance,
      1,
      input(),
      () => undefined,
      20,
    );
    expect(await job.result).toEqual({ ok: false, code: 'DEADLINE' });
    expect(instance.terminated).toBe(true);
  });

  it('cancel terminates the worker and settles as cancelled, twice safely', async () => {
    const instance = worker('hang');
    const job = startLocalJob(
      () => instance,
      1,
      input(),
      () => undefined,
    );
    job.cancel();
    job.cancel();
    expect(await job.result).toEqual({ ok: false, code: 'CANCELLED' });
    expect(instance.terminated).toBe(true);
  });

  it('turns a worker crash into a typed failure and ignores results for another generation', async () => {
    const crashed = startLocalJob(
      () => worker('crash'),
      1,
      input(),
      () => undefined,
    );
    expect(await crashed.result).toEqual({ ok: false, code: 'WORKER_FAILED' });
    const instance = worker('stale');
    const stale = startLocalJob(
      () => instance,
      1,
      input(),
      () => undefined,
      30,
    );
    expect(await stale.result).toEqual({ ok: false, code: 'DEADLINE' });
  });
});
