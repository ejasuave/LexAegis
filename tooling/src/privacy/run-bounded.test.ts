import { describe, expect, it } from 'vitest';
import { processTree, runBounded, within } from './run-bounded';

/*
 * Regression tests for the first observed run, which never ended: the observer awaited the body of
 * an event stream whose request never finished, and nothing bounded the journey.
 */

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('bounded waits', () => {
  it('a wait that never settles yields the fallback instead of blocking', async () => {
    const never = new Promise<string>(() => undefined);
    const startedAt = Date.now();
    expect(await within(never, 50, 'gave up')).toBe('gave up');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('a wait that settles in time keeps its value, and a failure stays a failure', async () => {
    expect(await within(Promise.resolve('body'), 1_000, 'gave up')).toBe('body');
    await expect(
      within(Promise.reject(new Error('read failed')), 1_000, 'gave up'),
    ).rejects.toThrow('read failed');
  });
});

describe('bounded journey run', () => {
  it('returns the exit status and output of a run that ends', async () => {
    const run = await runBounded(
      process.execPath,
      ['-e', 'console.log("3 of 3 checks passed"); process.exitCode = 3;'],
      { cwd: process.cwd(), env: process.env, timeoutMs: 10_000 },
    );
    expect(run.timedOut).toBe(false);
    expect(run.status).toBe(3);
    expect(run.output).toContain('3 of 3 checks passed');
  });

  it('stops a run that never ends, together with the detached server it started', async () => {
    // The stand-in journey starts a DETACHED child that inherits its output pipe (as the journeys'
    // application server does), prints both process IDs and then waits for ever.
    const journey = `
      const { spawn } = require('node:child_process');
      const server = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
        detached: true,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      console.log(JSON.stringify({ journey: process.pid, server: server.pid }));
      setInterval(() => undefined, 1000);
    `;
    const startedAt = Date.now();
    const run = await runBounded(process.execPath, ['-e', journey], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 1_000,
      graceMs: 500,
    });
    expect(run.timedOut).toBe(true);
    expect(run.status).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    const pids = JSON.parse(run.output.trim().split('\n')[0] ?? '{}') as {
      journey: number;
      server: number;
    };
    expect(pids.journey).toBeGreaterThan(0);
    expect(pids.server).toBeGreaterThan(0);
    expect(alive(pids.journey)).toBe(false);
    expect(alive(pids.server)).toBe(false);
  });

  it('lists a process with its descendants', () => {
    expect(processTree(process.pid)[0]).toBe(process.pid);
  });
});
