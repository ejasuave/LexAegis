import { spawn, spawnSync } from 'node:child_process';

/*
 * Runs one journey with a hard time limit. A journey starts its own detached application server,
 * database, object store and browser; if it stops making progress, killing only the process that
 * was started leaves all of those running and the caller waiting. On the limit this stops the
 * WHOLE process tree the journey started, then reports `timedOut` so the check fails with a named
 * reason instead of hanging.
 */

/**
 * Resolves with `work`, or with `fallback` once `ms` have passed. Observation must never be the
 * reason a journey does not end: a wait that cannot finish is reported, not waited on. The timer
 * does not keep the process alive.
 */
export function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(fallback);
    }, ms);
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface BoundedRun {
  /** The exit status, or null when the process was stopped by a signal. */
  readonly status: number | null;
  readonly timedOut: boolean;
  /** Standard output and standard error together, in arrival order, bounded. */
  readonly output: string;
  readonly durationMs: number;
}

/** `pid` and every process descended from it that is alive now, parents before children. */
export function processTree(pid: number): number[] {
  const listed = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  const children = new Map<number, number[]>();
  for (const line of listed.stdout.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child === undefined || parent === undefined || Number.isNaN(child) || Number.isNaN(parent))
      continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const tree: number[] = [];
  const walk = (current: number): void => {
    tree.push(current);
    for (const child of children.get(current) ?? []) walk(child);
  };
  walk(pid);
  return tree;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pids: readonly number[], name: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, name);
    } catch {
      // Already gone.
    }
  }
}

/** Stops a process tree: asks first, then insists. The tree is listed before anything is stopped. */
export async function stopProcessTree(pid: number, graceMs = 3_000): Promise<void> {
  const tree = processTree(pid);
  // Children first, so a parent cannot start a replacement for a child that was just stopped.
  signal([...tree].reverse(), 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && tree.some(isAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  signal(tree.filter(isAlive), 'SIGKILL');
}

export function runBounded(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly graceMs?: number;
    readonly maxOutputBytes?: number;
  },
): Promise<BoundedRun> {
  const startedAt = Date.now();
  const maxOutput = options.maxOutputBytes ?? 8 * 1024 * 1024;
  return new Promise<BoundedRun>((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    let settled = false;
    const collect = (chunk: Buffer): void => {
      if (output.length < maxOutput) output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, timedOut, output, durationMs: Date.now() - startedAt });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      void (pid === undefined ? Promise.resolve() : stopProcessTree(pid, options.graceMs)).then(
        () => {
          // A descendant may still hold the output pipes open, so `close` may never come.
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null);
        },
      );
    }, options.timeoutMs);
    child.on('error', () => {
      finish(null);
    });
    // `exit`, not `close`: a detached grandchild that inherited a pipe must not delay the result.
    child.on('exit', (code) => {
      if (!timedOut) setTimeout(() => finish(code), 50);
    });
  });
}
