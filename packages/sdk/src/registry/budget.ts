/*
 * A bounded budget for one live verification: total time, total underlying attempts, concurrent
 * reads, a per-read timeout and at most one transient retry per read (inside the total budget).
 * There is no hidden transport retry anywhere else: every network attempt passes through here.
 */
export const LIVE_BUDGET_LIMITS = Object.freeze({
  totalMs: 20_000,
  maxAttempts: 64,
  concurrency: 4,
  perReadMs: 5_000,
});

export interface LiveBudgetLimits {
  readonly totalMs: number;
  readonly maxAttempts: number;
  readonly concurrency: number;
  readonly perReadMs: number;
}
export type LiveBudgetOptions = Partial<LiveBudgetLimits>;

export const BUDGET_FAILURES = ['DEADLINE', 'ATTEMPTS', 'ABORTED', 'TIMEOUT'] as const;
export type BudgetFailure = (typeof BUDGET_FAILURES)[number];

/** A budget limit was reached or the check was cancelled. Never carries request content. */
export class BudgetError extends Error {
  readonly failure: BudgetFailure;
  constructor(failure: BudgetFailure) {
    super(failure);
    this.name = 'BudgetError';
    this.failure = failure;
  }
}

/** Thrown by a transport for a failure that one retry may fix (network error, 429, 5xx, timeout). */
export class TransientError extends Error {
  constructor() {
    super('TRANSIENT');
    this.name = 'TransientError';
  }
}

export class LiveBudget {
  readonly #limits: LiveBudgetLimits;
  readonly #outer: AbortController = new AbortController();
  readonly #deadline: ReturnType<typeof setTimeout>;
  readonly #waiting: (() => void)[] = [];
  #attempts = 0;
  #running = 0;
  #deadlineHit = false;
  #last: BudgetFailure | null = null;

  constructor(options: LiveBudgetOptions = {}, signal?: AbortSignal) {
    // Callers may tighten the limits; they can never loosen them past the documented bounds.
    this.#limits = {
      totalMs: Math.min(options.totalMs ?? LIVE_BUDGET_LIMITS.totalMs, LIVE_BUDGET_LIMITS.totalMs),
      maxAttempts: Math.min(
        options.maxAttempts ?? LIVE_BUDGET_LIMITS.maxAttempts,
        LIVE_BUDGET_LIMITS.maxAttempts,
      ),
      concurrency: Math.min(
        options.concurrency ?? LIVE_BUDGET_LIMITS.concurrency,
        LIVE_BUDGET_LIMITS.concurrency,
      ),
      perReadMs: Math.min(
        options.perReadMs ?? LIVE_BUDGET_LIMITS.perReadMs,
        LIVE_BUDGET_LIMITS.perReadMs,
      ),
    };
    this.#deadline = setTimeout(() => {
      this.#deadlineHit = true;
      this.#outer.abort();
    }, this.#limits.totalMs);
    // Wake queued reads so they observe the stop instead of waiting for a release.
    this.#outer.signal.addEventListener('abort', () => {
      for (const wake of this.#waiting.splice(0)) wake();
    });
    if (signal?.aborted === true) this.#outer.abort();
    else signal?.addEventListener('abort', () => this.#outer.abort(), { once: true });
  }

  /** The most recent reason a read was refused or cut short, for honest reporting. */
  get lastFailure(): BudgetFailure | null {
    return this.#last;
  }

  #stop(failure: BudgetFailure): BudgetError {
    this.#last ??= failure;
    return new BudgetError(failure);
  }

  get attempts(): number {
    return this.#attempts;
  }

  /** Stops the deadline timer and cancels anything still in flight. Safe to call twice. */
  dispose(): void {
    clearTimeout(this.#deadline);
    this.#outer.abort();
  }

  get #stopped(): BudgetFailure | null {
    if (!this.#outer.signal.aborted) return null;
    return this.#deadlineHit ? 'DEADLINE' : 'ABORTED';
  }

  async #slot(): Promise<void> {
    while (this.#running >= this.#limits.concurrency) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
      const stopped = this.#stopped;
      if (stopped !== null) throw this.#stop(stopped);
    }
    this.#running += 1;
  }

  #release(): void {
    this.#running -= 1;
    this.#waiting.shift()?.();
  }

  /**
   * Runs one read: at most two attempts (one transient retry), each bounded by the per-read
   * timeout and the remaining total budget. `read` receives an AbortSignal it must honour.
   */
  async run<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const stopped = this.#stopped;
      if (stopped !== null) throw this.#stop(stopped);
      if (this.#attempts >= this.#limits.maxAttempts) throw this.#stop('ATTEMPTS');
      await this.#slot();
      // A stop that arrived while this read waited for a slot must not start a request.
      const late = this.#stopped;
      if (late !== null) {
        this.#release();
        throw this.#stop(late);
      }
      const call = new AbortController();
      const state = { timedOut: false };
      const timer = setTimeout(() => {
        state.timedOut = true;
        call.abort();
      }, this.#limits.perReadMs);
      const forward = () => call.abort();
      this.#outer.signal.addEventListener('abort', forward, { once: true });
      this.#attempts += 1;
      try {
        return await read(call.signal);
      } catch (error) {
        const afterStop = this.#stopped;
        if (afterStop !== null) throw this.#stop(afterStop);
        const transient = error instanceof TransientError || state.timedOut;
        if (!transient || attempt >= 1) {
          throw state.timedOut ? this.#stop('TIMEOUT') : error;
        }
        // One retry, only for a transient failure, and only inside the remaining budget.
      } finally {
        clearTimeout(timer);
        this.#outer.signal.removeEventListener('abort', forward);
        this.#release();
      }
    }
  }
}
