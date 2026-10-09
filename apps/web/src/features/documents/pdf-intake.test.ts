import { describe, expect, it, vi } from 'vitest';
import { PdfIntake, INTAKE_DEADLINE_MS, type WorkerLike } from './pdf-intake';
import { createDiffRunner } from './diff-runner';

/* The worker lifecycle with a controllable worker: nothing here parses a PDF. */

class FakeWorker implements WorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;
  posted: unknown[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const pdfBytes = () => new TextEncoder().encode('%PDF-1.4 fake');
const identity = { documentId: 'a', documentVersionId: 'b', sourceArtifactId: 'c' };

function setup(generation = { value: 1 }) {
  const workers: FakeWorker[] = [];
  const intake = new PdfIntake({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    generation: () => generation.value,
    assets: {},
    newJobId: () => 'job-1',
  });
  return { intake, workers, generation };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** The worker is created after the original is hashed; wait for it instead of guessing a delay. */
async function started(workers: FakeWorker[]): Promise<FakeWorker> {
  for (let i = 0; i < 200 && workers.length === 0; i += 1) await tick();
  const worker = workers[0];
  if (worker === undefined) throw new Error('worker never started');
  return worker;
}

describe('intake worker lifecycle', () => {
  it('refuses without starting a worker: empty, oversized or not a PDF', async () => {
    const { intake, workers } = setup();
    expect(await intake.run(new Uint8Array(0), identity)).toEqual({
      status: 'refused',
      reason: 'empty',
    });
    expect(await intake.run(new Uint8Array(10 * 1024 * 1024 + 1), identity)).toEqual({
      status: 'refused',
      reason: 'too_large',
    });
    expect(await intake.run(new TextEncoder().encode('hello'), identity)).toEqual({
      status: 'refused',
      reason: 'not_a_pdf',
    });
    expect(workers).toHaveLength(0);
  });

  it('hashes the original before transfer and hands the worker its own copy', async () => {
    const { intake, workers } = setup();
    const bytes = pdfBytes();
    const run = intake.run(bytes, identity);
    const worker = await started(workers);
    const message = worker.posted[0] as {
      job: string;
      bytes: Uint8Array;
      identity: { sourceSha256: string };
    };
    expect(message.identity.sourceSha256).toMatch(/^0x[0-9a-f]{64}$/);
    expect(message.bytes).not.toBe(bytes);
    expect(bytes.byteLength).toBeGreaterThan(0);
    worker.reply({ job: 'job-1', outcome: { kind: 'malformed' } });
    expect(await run).toMatchObject({ status: 'done', outcome: { kind: 'malformed' } });
    expect(worker.terminated).toBe(true);
  });

  it('allows one job at a time', async () => {
    const { intake, workers } = setup();
    const first = intake.run(pdfBytes(), identity);
    await started(workers);
    expect(await intake.run(pdfBytes(), identity)).toEqual({ status: 'refused', reason: 'busy' });
    workers[0]?.reply({ job: 'job-1', outcome: { kind: 'failed' } });
    await first;
  });

  it('terminates the worker at the 30-second deadline instead of racing a promise', async () => {
    vi.useFakeTimers();
    try {
      const { intake, workers } = setup();
      const run = intake.run(pdfBytes(), identity);
      await vi.waitFor(() => expect(workers).toHaveLength(1));
      const worker = workers[0] as FakeWorker;
      expect(worker.terminated).toBe(false);
      await vi.advanceTimersByTimeAsync(INTAKE_DEADLINE_MS + 1);
      expect(await run).toEqual({ status: 'timeout' });
      expect(worker.terminated).toBe(true);
      expect(intake.busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Cancel terminates the worker and reports cancelled', async () => {
    const { intake, workers } = setup();
    const run = intake.run(pdfBytes(), identity);
    await started(workers);
    intake.cancel();
    expect(await run).toMatchObject({ status: 'done', outcome: { kind: 'cancelled' } });
    expect(workers[0]?.terminated).toBe(true);
    // A reply that arrives after termination is ignored.
    workers[0]?.reply({ job: 'job-1', outcome: { kind: 'failed' } });
    expect(intake.busy).toBe(false);
  });

  it('discards a result that arrives after the vault generation changed', async () => {
    const { intake, workers, generation } = setup();
    const run = intake.run(pdfBytes(), identity);
    await started(workers);
    generation.value = 2;
    workers[0]?.reply({ job: 'job-1', outcome: { kind: 'extracted' } });
    expect(await run).toEqual({ status: 'stale' });
    expect(workers[0]?.terminated).toBe(true);
  });

  it('ignores a reply for another job', async () => {
    const { intake, workers } = setup();
    const run = intake.run(pdfBytes(), identity);
    await started(workers);
    workers[0]?.reply({ job: 'someone-else', outcome: { kind: 'extracted' } });
    expect(workers[0]?.terminated).toBe(false);
    workers[0]?.reply({ job: 'job-1', outcome: { kind: 'failed' } });
    await run;
  });

  it('a worker crash is a failed outcome, not a hang', async () => {
    const { intake, workers } = setup();
    const run = intake.run(pdfBytes(), identity);
    await started(workers);
    workers[0]?.onerror?.({});
    expect(await run).toMatchObject({ outcome: { kind: 'failed' } });
  });
});

describe('diff runner', () => {
  it('terminates a diff that overruns its limit and reports it incomplete, never "no changes"', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const run = createDiffRunner(() => worker, 100)('old', 'new');
      await vi.advanceTimersByTimeAsync(2_200);
      expect(await run.promise).toEqual({ kind: 'incomplete', reason: 'timeout' });
      expect(worker.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel terminates the worker; a finished result passes through once', async () => {
    const worker = new FakeWorker();
    const run = createDiffRunner(() => worker)('a', 'b');
    run.cancel();
    expect(await run.promise).toEqual({ kind: 'incomplete', reason: 'cancelled' });
    expect(worker.terminated).toBe(true);

    const other = new FakeWorker();
    const ok = createDiffRunner(() => other)('a', 'b');
    const job = (other.posted[0] as { job: string }).job;
    other.reply({ job, outcome: { kind: 'done', changes: [] } });
    expect(await ok.promise).toEqual({ kind: 'done', changes: [] });
  });
});
