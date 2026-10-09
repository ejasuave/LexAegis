import { spawn } from 'node:child_process';
import { redact } from './redact';

export type CheckOutcome = 'pass' | 'fail' | 'unknown';

export interface CheckSpec {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Checks that must run before this one (same chain), such as build before the exclusion scan. */
  readonly after?: string;
  /** Marks a check that could not run for lack of an offline prerequisite. */
  readonly requires?: () => string | null;
}

export interface CheckResult {
  readonly id: string;
  readonly outcome: CheckOutcome;
  readonly reason: string;
  readonly durationMs: number;
  readonly tail: string;
}

/** Environment that disables telemetry and network use in the tools these checks run. */
export const OFFLINE_ENV: Readonly<Record<string, string>> = {
  NEXT_TELEMETRY_DISABLED: '1',
  DO_NOT_TRACK: '1',
  npm_config_offline: 'true',
  FOUNDRY_OFFLINE: 'true',
  CI: '',
};

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    // The child leads its own process group, so this reaches only its own descendants.
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** Runs one command with a deadline. A timeout or spawn failure is unknown, never pass. */
export function runCheck(spec: CheckSpec, timeoutMs: number): Promise<CheckResult> {
  const started = Date.now();
  const finish = (outcome: CheckOutcome, reason: string, tail: string): CheckResult => ({
    id: spec.id,
    outcome,
    reason,
    durationMs: Date.now() - started,
    tail: redact(tail.slice(-1500)),
  });
  const missing = spec.requires?.() ?? null;
  if (missing !== null)
    return Promise.resolve(finish('unknown', `PREREQUISITE_MISSING: ${missing}`, ''));

  return new Promise((resolve) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...process.env, ...OFFLINE_ENV },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const settle = (result: CheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      killTree(child.pid);
      settle(finish('unknown', 'TIMED_OUT', output));
    }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk: Buffer) => {
        output = `${output}${chunk.toString('utf8')}`.slice(-6000);
      });
    }
    child.on('error', () => settle(finish('unknown', 'SPAWN_FAILED', output)));
    child.on('close', (code) =>
      settle(
        code === 0 ? finish('pass', 'OK', output) : finish('fail', `EXIT_${String(code)}`, output),
      ),
    );
  });
}

/**
 * Runs checks in parallel chains within one wall-clock budget. Checks that name `after` wait for
 * that check and are skipped (unknown) when it did not pass. Nothing is dropped for time: a
 * check that does not finish is unknown with a reason.
 */
export async function runAll(
  specs: readonly CheckSpec[],
  budgetMs: number,
): Promise<CheckResult[]> {
  const deadline = Date.now() + budgetMs;
  const done = new Map<string, Promise<CheckResult>>();
  const start = (spec: CheckSpec): Promise<CheckResult> => {
    const existing = done.get(spec.id);
    if (existing !== undefined) return existing;
    const promise = (async () => {
      if (spec.after !== undefined) {
        const parent = specs.find((item) => item.id === spec.after);
        const before = parent === undefined ? undefined : await start(parent);
        if (before?.outcome !== 'pass') {
          return {
            id: spec.id,
            outcome: 'unknown' as const,
            reason: `NOT_RUN: ${spec.after} did not pass`,
            durationMs: 0,
            tail: '',
          };
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        return {
          id: spec.id,
          outcome: 'unknown' as const,
          reason: 'NOT_RUN: budget exhausted',
          durationMs: 0,
          tail: '',
        };
      return runCheck(spec, remaining);
    })();
    done.set(spec.id, promise);
    return promise;
  };
  return Promise.all(specs.map(start));
}

// ---- Live probes (read-only, bounded) -------------------------------------------------------------

export type Fetcher = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ProbeResult {
  readonly id: string;
  readonly outcome: CheckOutcome;
  readonly reason: string;
}

async function bounded(
  fetcher: Fetcher,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** eth_chainId and eth_getCode against the configured registry. Errors never echo the RPC URL. */
export async function probeRegistry(
  fetcher: Fetcher,
  config: {
    rpcUrl: string | undefined;
    registryAddress: string | undefined;
    expectedChainId: string;
    expectedCodeLength: number | undefined;
  },
  timeoutMs = 5000,
): Promise<ProbeResult> {
  const id = 'live-registry-read';
  if (!config.rpcUrl || !config.registryAddress)
    return { id, outcome: 'unknown', reason: 'NOT_CONFIGURED' };
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    const response = await bounded(
      fetcher,
      config.rpcUrl as string,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      },
      timeoutMs,
    );
    if (!response.ok) throw new Error('HTTP_ERROR');
    const body = (await response.json()) as { result?: unknown };
    return body.result;
  };
  try {
    const chain = await call('eth_chainId', []);
    if (typeof chain !== 'string' || BigInt(chain).toString() !== config.expectedChainId)
      return { id, outcome: 'fail', reason: 'WRONG_CHAIN' };
    const code = await call('eth_getCode', [config.registryAddress, 'latest']);
    if (typeof code !== 'string' || !/^0x[0-9a-f]*$/i.test(code))
      return { id, outcome: 'unknown', reason: 'RESPONSE_MALFORMED' };
    if (code === '0x') return { id, outcome: 'fail', reason: 'NO_CODE_AT_REGISTRY' };
    if (
      config.expectedCodeLength !== undefined &&
      (code.length - 2) / 2 !== config.expectedCodeLength
    )
      return { id, outcome: 'fail', reason: 'CODE_LENGTH_MISMATCH' };
    return { id, outcome: 'pass', reason: 'OK' };
  } catch {
    return { id, outcome: 'unknown', reason: 'UNAVAILABLE' };
  }
}

/** Existing health route only. A missing future field stays unknown. */
export async function probeHealth(
  fetcher: Fetcher,
  origin: string | undefined,
  timeoutMs = 5000,
): Promise<ProbeResult> {
  const id = 'live-health';
  if (!origin) return { id, outcome: 'unknown', reason: 'NOT_CONFIGURED' };
  try {
    const response = await bounded(fetcher, `${origin}/api/health`, { method: 'GET' }, timeoutMs);
    return response.ok
      ? { id, outcome: 'pass', reason: 'OK' }
      : { id, outcome: 'fail', reason: `HTTP_${String(response.status)}` };
  } catch {
    return { id, outcome: 'unknown', reason: 'UNAVAILABLE' };
  }
}

/** The indexer exposes no checkpoint/lag field yet (Chapter 19 owns it), so this is always unknown. */
export function probeIndexer(): ProbeResult {
  return { id: 'live-indexer-lag', outcome: 'unknown', reason: 'INDEXER_CHECKPOINT_UNSUPPORTED' };
}
