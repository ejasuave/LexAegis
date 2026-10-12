import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SYSTEM_CASES } from './cases';
import {
  checkBucket,
  checkDatabase,
  checkExactResource,
  checkLocalChain,
  checkLoopback,
  checkTestMode,
  namespace,
} from './guards';
import { ResourceLedger } from './ledger';
import { parseManifest, satisfies, systemResultSchema, type SystemCaseV1 } from './manifest';
import { Barrier, ControlledClock, PollTimeout, waitUntil } from './poll';
import { buildResult, readResults, recordResult, summarizeCases } from './recorder';
import { existsSync } from 'node:fs';
import { repository } from './services';

const caseOf = (patch: Partial<SystemCaseV1> = {}): SystemCaseV1 => ({
  schema: 'lexaegis.system-case.v1',
  id: 'sample-case',
  owner: 'tests/system/sample.spec.ts',
  invariant: 'A synthetic invariant used by the harness tests.',
  requiredEvidence: 'local_integration',
  requiredForMvp: true,
  ...patch,
});
const at = new Date('2026-10-12T09:00:00.000Z');
const result = (
  status: 'pass' | 'fail' | 'blocked' | 'not_run',
  patch: Partial<Parameters<typeof buildResult>[0]> = {},
) =>
  buildResult({
    caseId: 'sample-case',
    status,
    evidenceClass: 'local_integration',
    startedAt: at,
    finishedAt: new Date(at.getTime() + 5),
    ...(status === 'pass' ? {} : { issueCodes: ['SERVICE_UNAVAILABLE' as const] }),
    ...patch,
  });

describe('[harness-refuses-public-targets] safety guards', () => {
  it('refuses non-loopback endpoints and public chains', () => {
    expect(checkLoopback('http://127.0.0.1:8545')).toEqual({ ok: true });
    expect(checkLoopback('https://testnet-rpc.monad.xyz/')).toEqual({
      ok: false,
      code: 'ENDPOINT_NOT_LOOPBACK',
    });
    expect(
      checkLocalChain('http://127.0.0.1:1', { chainId: '10143', clientVersion: 'anvil/1' }),
    ).toEqual({
      ok: false,
      code: 'CHAIN_IS_PUBLIC_NETWORK',
    });
    expect(
      checkLocalChain(
        'http://127.0.0.1:1',
        { chainId: '143', clientVersion: 'anvil/1' },
        { allowPublicChainIdOnAnvil: true },
      ),
    ).toEqual({ ok: true });
    // A loopback endpoint that is not Anvil (a forked or proxied public node) is refused outright.
    expect(
      checkLocalChain('http://127.0.0.1:1', { chainId: '31337', clientVersion: 'Geth/1.0' }),
    ).toEqual({ ok: false, code: 'CHAIN_NOT_LOCAL_NODE' });
    expect(
      checkLocalChain('https://rpc.example.invalid', {
        chainId: '31337',
        clientVersion: 'anvil/1',
      }),
    ).toEqual({ ok: false, code: 'ENDPOINT_NOT_LOOPBACK' });
  });

  it('accepts only test-namespaced databases and buckets on loopback', () => {
    expect(checkDatabase('postgres://lexaegis:x@127.0.0.1:5432/lexaegis')).toEqual({ ok: true });
    expect(checkDatabase('postgres://lexaegis:x@db.example.invalid:5432/lexaegis').ok).toBe(false);
    expect(checkDatabase('postgres://lexaegis:x@127.0.0.1:5432/production').ok).toBe(false);
    expect(checkBucket('http://127.0.0.1:7070', 'lexvault')).toEqual({ ok: true });
    expect(checkBucket('http://127.0.0.1:7070', 'customer-documents').ok).toBe(false);
    expect(checkBucket('https://s3.amazonaws.com', 'lexvault').ok).toBe(false);
  });

  it('requires a test mode and builds distinct per-worker namespaces', () => {
    expect(checkTestMode({}).ok).toBe(false);
    expect(checkTestMode({ LEXAEGIS_TEST_MODE: 'scripted-assistant' }).ok).toBe(true);
    expect(namespace('run', 1)).not.toBe(namespace('run', 2));
    expect(namespace('run', 1)).toBe(namespace('run', 1));
  });
});

describe('[harness-refuses-public-targets] resource ledger', () => {
  it('cleans only what it recorded, once, newest first, and refuses wildcards', async () => {
    const ledger = new ResourceLedger();
    const order: string[] = [];
    expect(ledger.record({ kind: 'db', name: 'a', cleanup: () => void order.push('a') }).ok).toBe(
      true,
    );
    expect(ledger.record({ kind: 'db', name: 'b', cleanup: () => void order.push('b') }).ok).toBe(
      true,
    );
    expect(
      ledger.record({ kind: 'bucket', name: 'lex*', cleanup: () => void order.push('wild') }),
    ).toEqual({
      ok: false,
      code: 'WILDCARD_RESOURCE',
    });
    expect(checkExactResource('.').ok).toBe(false);
    expect(await ledger.cleanup()).toEqual([]);
    expect(await ledger.cleanup()).toEqual([]);
    expect(order).toEqual(['b', 'a']);
  });

  it('reports a failing cleanup without hiding the others', async () => {
    const ledger = new ResourceLedger();
    const done: string[] = [];
    ledger.record({ kind: 'x', name: 'ok', cleanup: () => void done.push('ok') });
    ledger.record({ kind: 'x', name: 'bad', cleanup: () => Promise.reject(new Error('boom')) });
    expect(await ledger.cleanup()).toEqual(['x:bad']);
    expect(done).toEqual(['ok']);
  });
});

describe('[harness-non-pass-is-never-pass] case manifest and results', () => {
  it('rejects unknown fields, duplicate ids and bad ids', () => {
    expect(() => parseManifest([{ ...caseOf(), extra: 1 }])).toThrow();
    expect(() => parseManifest([caseOf(), caseOf()])).toThrow(/duplicate/);
    expect(() => parseManifest([caseOf({ id: 'Bad Id' })])).toThrow();
  });

  it('the shipped manifest is valid and every owner exists', () => {
    for (const item of SYSTEM_CASES)
      expect(existsSync(join(repository, item.owner)), item.owner).toBe(true);
  });

  it('a result that is not a pass must carry an issue code, and a pass must not carry a blocking one', () => {
    const base = {
      schema: 'lexaegis.system-result.v1',
      caseId: 'sample-case',
      evidenceClass: 'unit',
      startedAt: at.toISOString(),
      finishedAt: at.toISOString(),
      durationMs: 0,
      evidencePaths: [],
    };
    expect(
      systemResultSchema.safeParse({ ...base, status: 'blocked', issueCodes: [] }).success,
    ).toBe(false);
    expect(
      systemResultSchema.safeParse({ ...base, status: 'pass', issueCodes: ['SKIPPED'] }).success,
    ).toBe(false);
    expect(systemResultSchema.safeParse({ ...base, status: 'pass', issueCodes: [] }).success).toBe(
      true,
    );
  });

  it('only a real, current, sufficiently strong pass satisfies a case', () => {
    const required = caseOf();
    expect(satisfies(required, result('pass'))).toBe(true);
    expect(satisfies(required, undefined)).toBe(false);
    for (const status of ['fail', 'blocked', 'not_run'] as const)
      expect(satisfies(required, result(status))).toBe(false);
    // Weaker evidence than required.
    expect(satisfies(required, result('pass', { evidenceClass: 'unit' }))).toBe(false);
    // Stronger evidence satisfies a weaker requirement.
    expect(satisfies(required, result('pass', { evidenceClass: 'browser_scripted' }))).toBe(true);
    // A flaky pass is preserved as a flaky result and does not satisfy.
    expect(satisfies(required, result('pass', { issueCodes: ['FLAKY_RESULT'] }))).toBe(false);
    // The wrong case.
    expect(
      satisfies(
        required,
        buildResult({ caseId: 'other', status: 'pass', evidenceClass: 'unit', startedAt: at }),
      ),
    ).toBe(false);
  });

  it('summaries mark a case with no result as missing, never as a pass', () => {
    const [summary] = summarizeCases([caseOf()], []);
    expect(summary).toMatchObject({ status: 'missing', satisfied: false });
  });

  it('records results as validated lines in an output directory and reads the latest', () => {
    const directory = mkdtempSync(join(tmpdir(), 'system-results-'));
    try {
      const file = join(directory, 'results.jsonl');
      recordResult(
        {
          caseId: 'sample-case',
          status: 'blocked',
          evidenceClass: 'local_integration',
          startedAt: at,
          issueCodes: ['SERVICE_UNAVAILABLE'],
        },
        file,
      );
      recordResult(
        {
          caseId: 'sample-case',
          status: 'pass',
          evidenceClass: 'local_integration',
          startedAt: at,
        },
        file,
      );
      const [summary] = summarizeCases([caseOf()], readResults(file));
      expect(summary).toMatchObject({ status: 'pass', satisfied: true });
      expect(() =>
        recordResult(
          { caseId: 'sample-case', status: 'fail', evidenceClass: 'unit', startedAt: at },
          file,
        ),
      ).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('polling, barriers and the controlled clock', () => {
  it('polls a bounded condition and times out with a label', async () => {
    let calls = 0;
    expect(
      await waitUntil('third try', () => (++calls >= 3 ? 'done' : null), { intervalMs: 1 }),
    ).toBe('done');
    await expect(
      waitUntil('never', () => false, { timeoutMs: 20, intervalMs: 5 }),
    ).rejects.toBeInstanceOf(PollTimeout);
  });

  it('a barrier holds the code under test until released', async () => {
    const barrier = new Barrier();
    const order: string[] = [];
    const work = (async () => {
      order.push('before');
      await barrier.pass();
      order.push('after');
    })();
    await barrier.arrived();
    expect(order).toEqual(['before']);
    barrier.release();
    await work;
    expect(order).toEqual(['before', 'after']);
  });

  it('time moves only when told to', () => {
    const clock = new ControlledClock(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
  });
});
