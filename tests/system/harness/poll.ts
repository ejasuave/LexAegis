/** Bounded condition polling and explicit asynchronous barriers: no long sleeps. */

export class PollTimeout extends Error {
  constructor(label: string) {
    super(`condition not met: ${label}`);
    this.name = 'PollTimeout';
  }
}

export async function waitUntil<T>(
  label: string,
  read: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  const interval = options.intervalMs ?? 100;
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() >= deadline) throw new PollTimeout(label);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** A one-shot gate a test opens explicitly; production code under test awaits it through a seam. */
export class Barrier {
  readonly #promise: Promise<void>;
  #open!: () => void;
  #reached!: () => void;
  readonly #arrival: Promise<void>;

  constructor() {
    this.#promise = new Promise((resolve) => {
      this.#open = resolve;
    });
    this.#arrival = new Promise((resolve) => {
      this.#reached = resolve;
    });
  }

  /** Called by the code under test: announces arrival, then waits to be released. */
  async pass(): Promise<void> {
    this.#reached();
    await this.#promise;
  }

  /** Resolves when the code under test has arrived. */
  arrived(): Promise<void> {
    return this.#arrival;
  }

  release(): void {
    this.#open();
  }
}

/** A controlled clock: time moves only when the test says so. */
export class ControlledClock {
  #now: number;
  constructor(start = Date.UTC(2026, 9, 12, 9, 0, 0)) {
    this.#now = start;
  }
  now = (): number => this.#now;
  date = (): Date => new Date(this.#now);
  advance(milliseconds: number): void {
    this.#now += milliseconds;
  }
}
