import { describe, expect, it } from 'vitest';
import { guardsPass, preflightTestnet, remainingSteps } from './guards';
import { SMOKE_STEPS, planSmoke, renderStepTable, type StepStatus } from './smoke-steps';

const BEFORE_C = '2026-10-08T12:00:00+01:00';
const AFTER_C = '2026-10-09T09:00:00+01:00';
const allChapters = new Set(['03', '04', '05', '06', '08', '09', '10', '11']);

describe('smoke step registry', () => {
  it('covers the nine journey steps plus Stop, in order, each with owner chapters and an assertion', () => {
    expect(SMOKE_STEPS.map((s) => s.id)).toEqual([
      'access-and-import',
      'consent-before-send',
      'assistant-and-citation',
      'human-dispositions',
      'freeze-save-readback',
      'approve-send-confirm',
      'export-and-verify',
      'tamper-detection',
      'supersede-and-revoke',
      'stop-cancellation',
    ]);
    for (const step of SMOKE_STEPS) {
      expect(step.requires.length).toBeGreaterThan(0);
      expect(step.assertion).not.toBe('');
    }
  });
});

describe('smoke planning', () => {
  const none = new Map<string, StepStatus>();

  it('reports every step pending with its missing chapters while features are absent', () => {
    const report = planSmoke({
      completedChapters: new Set(['01', '02', '03']),
      drivers: none,
      now: BEFORE_C,
    });
    expect(report.steps.every((s) => s.status === 'pending')).toBe(true);
    expect(report.steps.find((s) => s.id === 'tamper-detection')?.dependencies).toEqual([
      'chapter-11',
    ]);
    expect(report.status).toBe('incomplete');
  });

  it('becomes a failure, not merely incomplete, once Gate C is entered; no flag waives it', () => {
    const report = planSmoke({ completedChapters: new Set(['03']), drivers: none, now: AFTER_C });
    expect(report.status).toBe('failed');
  });

  it('is blocked, never passed, when prerequisites exist but no driver ran the step', () => {
    const report = planSmoke({ completedChapters: allChapters, drivers: none, now: BEFORE_C });
    expect(report.steps.every((s) => s.status === 'blocked')).toBe(true);
    expect(report.steps[0]?.dependencies).toEqual(['browser-driver']);
    expect(report.status).toBe('incomplete');
  });

  it('passes only when a driver reports every step passed', () => {
    const drivers = new Map(SMOKE_STEPS.map((s): [string, StepStatus] => [s.id, 'passed']));
    expect(planSmoke({ completedChapters: allChapters, drivers, now: AFTER_C }).status).toBe(
      'passed',
    );
    drivers.set('tamper-detection', 'failed');
    expect(planSmoke({ completedChapters: allChapters, drivers, now: BEFORE_C }).status).toBe(
      'failed',
    );
  });

  it('renders a compact table that keeps pending steps visible', () => {
    const table = renderStepTable(
      planSmoke({ completedChapters: new Set(), drivers: none, now: BEFORE_C }),
    );
    expect(table).toContain('pending');
    expect(table).toContain('chapter-04');
    expect(table).toContain('run: incomplete');
  });
});

const GOOD_ENV = {
  NEXT_PUBLIC_CHAIN_ID: '10143',
  SMOKE_CHAIN_ID: '10143',
  NEXT_PUBLIC_REGISTRY_ADDRESS: `0x${'ab'.repeat(20)}`,
  SMOKE_APP_ORIGIN: 'https://app.example.test',
  SMOKE_VERIFIER_ORIGIN: 'https://verify.example.test',
  SMOKE_APPROVED_ORIGINS: 'https://app.example.test,https://verify.example.test',
  SMOKE_ACCOUNT_LABEL: 'synthetic-demo-01',
};
const START = ['--operator-start'];
const failing = (env: Record<string, string | undefined>, argv = START) =>
  preflightTestnet(env, argv)
    .filter((r) => !r.ok)
    .map((r) => r.id);

describe('smoke:testnet preflight', () => {
  it('passes with every guard satisfied', () => {
    expect(guardsPass(preflightTestnet(GOOD_ENV, START))).toBe(true);
  });

  it('refuses CI, a missing operator start, mainnet, wrong chain and missing configuration', () => {
    expect(failing({ ...GOOD_ENV, CI: 'true' })).toEqual(['not-ci']);
    expect(failing({ ...GOOD_ENV, GITHUB_ACTIONS: 'true' })).toEqual(['not-ci']);
    expect(failing(GOOD_ENV, [])).toEqual(['operator-start']);
    expect(failing({ ...GOOD_ENV, NEXT_PUBLIC_CHAIN_ID: '143', SMOKE_CHAIN_ID: '143' })).toEqual([
      'not-mainnet',
      'chain-10143',
    ]);
    expect(failing({ ...GOOD_ENV, NEXT_PUBLIC_CHAIN_ID: '31337' })).toEqual(['chain-10143']);
    expect(failing({ ...GOOD_ENV, NEXT_PUBLIC_REGISTRY_ADDRESS: undefined })).toEqual([
      'registry-configured',
    ]);
    expect(failing({ ...GOOD_ENV, NEXT_PUBLIC_REGISTRY_ADDRESS: `0x${'00'.repeat(20)}` })).toEqual([
      'registry-configured',
    ]);
    expect(failing({})).toEqual(
      expect.arrayContaining([
        'chain-10143',
        'registry-configured',
        'app-origin',
        'verifier-origin',
        'synthetic-account',
      ]),
    );
  });

  it('refuses unapproved or non-https origins and non-synthetic accounts', () => {
    expect(failing({ ...GOOD_ENV, SMOKE_APP_ORIGIN: 'https://evil.example.test' })).toEqual([
      'app-origin',
    ]);
    expect(
      failing({
        ...GOOD_ENV,
        SMOKE_APP_ORIGIN: 'http://app.example.test',
        SMOKE_APPROVED_ORIGINS: 'http://app.example.test,https://verify.example.test',
      }),
    ).toEqual(['app-origin']);
    expect(failing({ ...GOOD_ENV, SMOKE_ACCOUNT_LABEL: 'alice@example.com' })).toEqual([
      'synthetic-account',
    ]);
  });

  it('refuses replay providers, virtual authenticators and test signers', () => {
    for (const name of [
      'LEXAEGIS_REPLAY_PROVIDER',
      'LEXAEGIS_VIRTUAL_AUTHENTICATOR',
      'LEXAEGIS_TEST_SIGNER',
    ]) {
      expect(failing({ ...GOOD_ENV, [name]: '1' })).toEqual(['no-simulation']);
    }
  });

  it('resumes without repeating completed steps', () => {
    const ledger = {
      runId: 'run-1',
      completed: {
        'access-and-import': {},
        'consent-before-send': {},
        'approve-send-confirm': { transactionHash: `0x${'ab'.repeat(32)}` },
      },
    };
    const next = remainingSteps(ledger);
    expect(next).not.toContain('approve-send-confirm');
    expect(next).not.toContain('access-and-import');
    expect(next[0]).toBe('assistant-and-citation');
    expect(remainingSteps({ runId: 'r', completed: {} })).toHaveLength(SMOKE_STEPS.length);
  });
});
