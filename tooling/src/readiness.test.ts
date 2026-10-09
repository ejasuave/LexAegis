import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { redact } from './redact';
import {
  probeHealth,
  probeIndexer,
  probeRegistry,
  runAll,
  runCheck,
  type Fetcher,
} from './readiness';
import { exitCode, reportRunId, renderReport, renderGateTable } from './report';
import { evaluateGates } from './gates';
import { FINGERPRINT, gateAEvidence } from './test-helpers';

const node = (code: string) => ({
  id: 'c',
  command: process.execPath,
  args: ['-e', code],
  cwd: process.cwd(),
});

describe('check runner', () => {
  it('passes, fails and reports the exit code', async () => {
    expect((await runCheck(node('process.exit(0)'), 5000)).outcome).toBe('pass');
    const failed = await runCheck(node('process.exit(3)'), 5000);
    expect(failed).toMatchObject({ outcome: 'fail', reason: 'EXIT_3' });
  });

  it('marks a timed-out check unknown and kills its whole process tree, not other processes', async () => {
    const marker = `lj-timeout-${String(process.pid)}`;
    const code = `require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)',${JSON.stringify(marker)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const result = await runCheck(node(code), 600);
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'TIMED_OUT' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const leftover = (() => {
      try {
        return execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim();
      } catch {
        return '';
      }
    })();
    expect(leftover).toBe('');
  });

  it('treats a missing offline prerequisite as unknown with a precise reason', async () => {
    const result = await runCheck(
      { ...node('process.exit(0)'), requires: () => 'forge 1.8.5 is not installed' },
      5000,
    );
    expect(result).toMatchObject({
      outcome: 'unknown',
      reason: 'PREREQUISITE_MISSING: forge 1.8.5 is not installed',
    });
  });

  it('never reports an unrun dependent as pass and never drops a check for time', async () => {
    const specs = [
      { ...node('process.exit(1)'), id: 'build' },
      { ...node('process.exit(0)'), id: 'exclusion', after: 'build' },
      { ...node('process.exit(0)'), id: 'unit' },
    ];
    const results = await runAll(specs, 5000);
    expect(results.map((r) => `${r.id}:${r.outcome}`)).toEqual([
      'build:fail',
      'exclusion:unknown',
      'unit:pass',
    ]);

    const slow = await runAll(
      [
        { ...node('setTimeout(()=>{},4000)'), id: 'slow' },
        { ...node('process.exit(0)'), id: 'later', after: 'slow' },
      ],
      500,
    );
    expect(slow.map((r) => r.outcome)).toEqual(['unknown', 'unknown']);
    expect(slow).toHaveLength(2);
  });

  it('redacts credentials from captured output', async () => {
    const result = await runCheck(
      node(
        `console.log('QWEN_API_KEY=supersecretvalue1234 https://eth.example.io/v2/abcdefghijklmnop1234')`,
      ),
      5000,
    );
    expect(result.tail).not.toContain('supersecretvalue1234');
    expect(result.tail).not.toContain('abcdefghijklmnop1234');
  });
});

describe('redaction', () => {
  it('removes keys from RPC URLs, headers, bearer tokens, userinfo and assignments', () => {
    const text = [
      'https://monad-testnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWx',
      'Authorization: Bearer abcdef0123456789',
      'https://user:hunter2@example.com/path',
      'ENVIO_API_TOKEN=tok_1234567890',
      'sk-abcdefghijklmnopqrstuvwxyz',
    ].join('\n');
    const out = redact(text);
    for (const secret of [
      'AbCdEfGhIjKlMnOpQrStUvWx',
      'abcdef0123456789',
      'hunter2',
      'tok_1234567890',
      'sk-abcdefghijkl',
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('monad-testnet.g.alchemy.com');
  });

  it('keeps ordinary public URLs readable', () => {
    expect(redact('see https://docs.monad.xyz/ for details')).toBe(
      'see https://docs.monad.xyz/ for details',
    );
  });
});

function rpc(responses: Record<string, unknown>): Fetcher {
  const fetcher: Fetcher = (_url, init) => {
    const method = (JSON.parse(init.body ?? '{}') as { method?: string }).method ?? '';
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: responses[method] }),
    });
  };
  return fetcher;
}
const REGISTRY = {
  rpcUrl: 'https://rpc.example/v2/secretsecretsecret1234',
  registryAddress: `0x${'ab'.repeat(20)}`,
  expectedChainId: '10143',
  expectedCodeLength: 4,
};

describe('live probes', () => {
  it('passes only for the right chain with matching code', async () => {
    expect(
      await probeRegistry(rpc({ eth_chainId: '0x279f', eth_getCode: '0x01020304' }), REGISTRY),
    ).toMatchObject({ outcome: 'pass' });
  });

  it('fails wrong chain, no code and code of the wrong length', async () => {
    expect(
      await probeRegistry(rpc({ eth_chainId: '0x1', eth_getCode: '0x01020304' }), REGISTRY),
    ).toMatchObject({ outcome: 'fail', reason: 'WRONG_CHAIN' });
    expect(
      await probeRegistry(rpc({ eth_chainId: '0x279f', eth_getCode: '0x' }), REGISTRY),
    ).toMatchObject({ reason: 'NO_CODE_AT_REGISTRY' });
    expect(
      await probeRegistry(rpc({ eth_chainId: '0x279f', eth_getCode: '0x0102' }), REGISTRY),
    ).toMatchObject({ reason: 'CODE_LENGTH_MISMATCH' });
  });

  it('is unknown, never a pass or a fail, when unavailable, malformed or unconfigured, and leaks no URL', async () => {
    const down: Fetcher = () => Promise.reject(new Error(`connect failed ${REGISTRY.rpcUrl}`));
    const result = await probeRegistry(down, REGISTRY);
    expect(result).toEqual({ id: 'live-registry-read', outcome: 'unknown', reason: 'UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toContain('secretsecret');
    expect(
      (await probeRegistry(rpc({ eth_chainId: '0x279f', eth_getCode: 'oops' }), REGISTRY)).outcome,
    ).toBe('unknown');
    expect(await probeRegistry(rpc({}), { ...REGISTRY, rpcUrl: undefined })).toMatchObject({
      outcome: 'unknown',
      reason: 'NOT_CONFIGURED',
    });
  });

  it('times out an unresponsive endpoint', async () => {
    const hang: Fetcher = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    expect((await probeRegistry(hang, REGISTRY, 50)).outcome).toBe('unknown');
    expect((await probeHealth(hang, 'https://app.example', 50)).outcome).toBe('unknown');
  });

  it('health uses the existing route; the indexer lag stays unknown until the field exists', async () => {
    const fetcher: Fetcher = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
    );
    expect((await probeHealth(fetcher, 'https://app.example')).outcome).toBe('pass');
    expect(vi.mocked(fetcher).mock.calls[0]?.[0]).toBe('https://app.example/api/health');
    expect(probeIndexer()).toMatchObject({
      outcome: 'unknown',
      reason: 'INDEXER_CHECKPOINT_UNSUPPORTED',
    });
  });
});

describe('offline mode', () => {
  it('evaluation, rendering and exit logic make no network call', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    try {
      const evaluations = evaluateGates(gateAEvidence(), {
        now: '2026-10-05T12:00:00+01:00',
        currentFingerprint: FINGERPRINT,
      });
      renderGateTable(evaluations);
      renderReport({
        runId: 'r1',
        generatedAt: 'now',
        fingerprint: FINGERPRINT,
        evaluations,
        checks: [],
        totalMs: 1,
        versions: {},
      });
      exitCode({ stateValid: true, checks: [], evaluations, now: '2026-10-05T12:00:00+01:00' });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('exit code and report', () => {
  const ctx = (now: string) => evaluateGates([], { now, currentFingerprint: FINGERPRINT });

  it('is zero before any deadline with nothing failed, and not a readiness claim', () => {
    expect(
      exitCode({
        stateValid: true,
        checks: [{ outcome: 'pass' }],
        evaluations: ctx('2026-10-05T12:00:00+01:00'),
        now: '2026-10-05T12:00:00+01:00',
      }),
    ).toBe(0);
  });

  it('is nonzero for invalid state, a failed check or a due gate that is not pass', () => {
    const now = '2026-10-07T12:00:00+01:00';
    expect(exitCode({ stateValid: false, checks: [], evaluations: ctx(now), now })).toBe(1);
    expect(
      exitCode({
        stateValid: true,
        checks: [{ outcome: 'fail' }],
        evaluations: ctx('2026-10-05T12:00:00+01:00'),
        now: '2026-10-05T12:00:00+01:00',
      }),
    ).toBe(1);
    expect(exitCode({ stateValid: true, checks: [], evaluations: ctx(now), now })).toBe(1);
  });

  it('--require enforces a future gate and its prerequisites', () => {
    const now = '2026-10-05T12:00:00+01:00';
    expect(
      exitCode({ stateValid: true, checks: [], evaluations: ctx(now), now, require: 'A' }),
    ).toBe(1);
    expect(
      exitCode({
        stateValid: true,
        checks: [],
        evaluations: evaluateGates(gateAEvidence(), { now, currentFingerprint: FINGERPRINT }),
        now,
        require: 'A',
      }),
    ).toBe(0);
  });

  it('keeps the NOT YET marker and a detectable run ID in the report', () => {
    const evaluations = ctx('2026-10-05T12:00:00+01:00');
    expect(renderGateTable(evaluations)).toContain('NOT YET: ');
    const markdown = renderReport({
      runId: 'rd-20261008-abc',
      generatedAt: 'x',
      fingerprint: FINGERPRINT,
      evaluations,
      checks: [],
      totalMs: 0,
      versions: {},
    });
    expect(reportRunId(markdown)).toBe('rd-20261008-abc');
    expect(reportRunId('# stale')).toBeNull();
  });
});
