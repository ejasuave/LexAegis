import { describe, expect, it } from 'vitest';
import {
  GATE_CUTOFFS,
  GATE_IDS,
  SUBMISSION_TARGETS,
  evaluateGate,
  evaluateGates,
  gateConsequences,
  gatesRequiredFor,
  pendingT0IsFailure,
} from './gates';
import {
  DEPLOYMENT_FACTS,
  FINGERPRINT,
  PROVIDER_FACTS,
  OTHER_FINGERPRINT,
  gateAEvidence,
  gateBEvidence,
  gateCEvidence,
  gateDEvidence,
  result,
} from './test-helpers';

const BEFORE_A = '2026-10-05T12:00:00+01:00';
const AFTER_A = '2026-10-07T09:00:00+01:00';
const context = (now: string, currentFingerprint = FINGERPRINT) => ({ now, currentFingerprint });
const outcome = (
  gate: 'A' | 'B' | 'C' | 'D',
  evidence: ReturnType<typeof gateAEvidence>,
  now: string,
) => evaluateGate(gate, evidence, context(now)).outcome;

describe('targets', () => {
  it('records explicit Europe/London offsets and keeps submission targets distinct', () => {
    for (const cutoff of Object.values(GATE_CUTOFFS)) expect(cutoff).toMatch(/\+01:00$/);
    expect(GATE_CUTOFFS).toEqual({
      A: '2026-10-06T23:59:59+01:00',
      B: '2026-10-08T23:59:59+01:00',
      C: '2026-10-10T23:59:59+01:00',
      D: '2026-10-11T23:59:59+01:00',
    });
    expect(SUBMISSION_TARGETS).toEqual({
      internalTarget: '2026-10-12',
      latestPlanned: '2026-10-13T22:00:00+01:00',
      hardDeadline: '2026-10-14T04:59:00+01:00',
    });
  });
});

describe('Gate A', () => {
  it('passes only with an observed successful deployment receipt that matches the identity', () => {
    expect(outcome('A', gateAEvidence(), BEFORE_A)).toBe('pass');
  });

  it('does not accept a populated address string as a deployment', () => {
    const { receiptStatus: _r, identityMatches: _i, ...bare } = DEPLOYMENT_FACTS;
    const evidence = [gateAEvidence()[0] as never, result('registry-deployment', { facts: bare })];
    const evaluation = evaluateGate('A', evidence, context(BEFORE_A));
    expect(evaluation.outcome).toBe('fail');
    expect(evaluation.reasons).toContain('IDENTITY_MISMATCH:A2');
  });

  it('fails a deployment on the wrong chain', () => {
    const wrong = [
      gateAEvidence()[0] as never,
      result('registry-deployment', { facts: { ...DEPLOYMENT_FACTS, chainId: '143' } }),
    ];
    expect(evaluateGate('A', wrong, context(BEFORE_A)).reasons).toContain('WRONG_NETWORK:A2');
  });

  it('cannot be satisfied by local or virtual evidence', () => {
    for (const evidenceClass of [
      'local_anvil',
      'local_scripted',
      'virtual_authenticator',
      'offline_unit',
    ] as const) {
      const evidence = [
        gateAEvidence()[0] as never,
        result('registry-deployment', { evidenceClass, facts: { ...DEPLOYMENT_FACTS } }),
      ];
      const evaluation = evaluateGate('A', evidence, context(BEFORE_A));
      expect(evaluation.outcome).not.toBe('pass');
      expect(evaluation.reasons).toContain('INSUFFICIENT_CLASS:A2');
    }
  });

  it('is unknown while evidence is missing before the cutoff and a failure once it passes', () => {
    expect(outcome('A', [], BEFORE_A)).toBe('unknown');
    const due = evaluateGate('A', [], context(AFTER_A));
    expect(due.outcome).toBe('fail');
    expect(due.reasons).toContain('UNPROVEN_AT_CUTOFF');
  });

  it('keeps an actual failed check a failure, not unknown, even before the cutoff', () => {
    const evidence = [
      result('chapters-1-3-checks', { evidenceClass: 'local_scripted', outcome: 'fail' }),
    ];
    expect(outcome('A', evidence, BEFORE_A)).toBe('fail');
  });

  it('treats stale evidence as not passing', () => {
    const evaluation = evaluateGate('A', gateAEvidence(), context(BEFORE_A, OTHER_FINGERPRINT));
    expect(evaluation.outcome).toBe('unknown');
    expect(evaluation.reasons).toEqual(['STALE:A1', 'STALE:A2']);
  });

  it('uses the latest result for a subject, so a newer failure overrides an older pass', () => {
    const older = result('chapters-1-3-checks', { evidenceClass: 'local_scripted' });
    const newer = result('chapters-1-3-checks', {
      evidenceClass: 'local_scripted',
      outcome: 'fail',
      checkedAt: '2026-10-06T13:00:00+01:00',
    });
    expect(outcome('A', [older, newer, gateAEvidence()[1] as never], BEFORE_A)).toBe('fail');
  });

  it('pending or blocked results are not passes', () => {
    for (const state of ['pending', 'blocked', 'unknown'] as const) {
      const evidence = [
        result('chapters-1-3-checks', { evidenceClass: 'local_scripted', outcome: state }),
      ];
      expect(evaluateGate('A', evidence, context(BEFORE_A)).requirements[0]?.state).toBe('missing');
    }
  });
});

describe('deadline boundaries', () => {
  it('has not passed the cutoff at the cutoff instant, and has one second later', () => {
    expect(outcome('A', [], '2026-10-06T23:59:59+01:00')).toBe('unknown');
    expect(outcome('A', [], '2026-10-07T00:00:00+01:00')).toBe('fail');
    // The same instants expressed in UTC.
    expect(outcome('A', [], '2026-10-06T22:59:59Z')).toBe('unknown');
    expect(outcome('A', [], '2026-10-06T23:00:00Z')).toBe('fail');
  });

  it('rejects a timestamp without an explicit offset', () => {
    expect(() => outcome('A', [], '2026-10-06T12:00:00')).toThrow(/explicit offset/);
  });

  it('enters Gate C when Gate B closes', () => {
    expect(pendingT0IsFailure('2026-10-08T23:59:59+01:00')).toBe(false);
    expect(pendingT0IsFailure('2026-10-09T00:00:00+01:00')).toBe(true);
  });
});

describe('Gate B', () => {
  const NOW = '2026-10-08T12:00:00+01:00';

  it('passes with real-device and live evidence linked to one action, registry and network', () => {
    expect(outcome('B', gateBEvidence(), NOW)).toBe('pass');
  });

  it('is not satisfied by a local or virtual signature', () => {
    for (const evidenceClass of [
      'local_scripted',
      'virtual_authenticator',
      'local_anvil',
    ] as const) {
      const evidence = gateBEvidence();
      evidence[0] = result('mera-signature', { evidenceClass, facts: evidence[0]?.facts as never });
      const evaluation = evaluateGate('B', evidence, context(NOW));
      expect(evaluation.outcome).not.toBe('pass');
      expect(evaluation.reasons).toContain('INSUFFICIENT_CLASS:B1');
    }
  });

  it('requires the signature, transaction and read to describe the same action', () => {
    const evidence = gateBEvidence();
    const other = gateBEvidence('0x' + '22'.repeat(32));
    evidence[2] = other[2] as never;
    const evaluation = evaluateGate('B', evidence, context(NOW));
    expect(evaluation.outcome).toBe('fail');
    expect(evaluation.reasons).toContain('LINK_MISMATCH:B1');
  });

  it('rejects a confirmation that did not come through Alchemy or was not confirmed', () => {
    for (const facts of [
      { provider: 'public-rpc', confirmed: true },
      { provider: 'alchemy', confirmed: false },
    ]) {
      const evidence = gateBEvidence();
      evidence[1] = result('registry-transaction', {
        facts: { ...(evidence[1]?.facts as object), ...facts },
      });
      expect(evaluateGate('B', evidence, context(NOW)).reasons).toContain('PROVENANCE_INVALID:B2');
    }
  });

  it('cannot pass unless Gate A passed', () => {
    const evaluations = evaluateGates(gateBEvidence(), context(NOW));
    expect(evaluations.find((item) => item.gate === 'B')?.outcome).not.toBe('pass');
    expect(evaluations.find((item) => item.gate === 'B')?.reasons).toContain(
      'PREREQUISITE_GATE_NOT_PASSED:A',
    );
  });

  it('records withdrawal of both Mera bounty claims and the release blocker when failed at its cutoff', () => {
    const evaluation = evaluateGate('B', [], context('2026-10-09T00:00:01+01:00'));
    const consequences = gateConsequences(evaluation, '2026-10-09T00:00:01+01:00');
    expect(consequences.meraBountyClaimsWithdrawn).toBe(true);
    expect(consequences.releaseBlockers.join(' ')).toMatch(/NO_DEPLOYABLE_SIGNER/);
    expect(consequences.releaseBlockers.join(' ')).toMatch(/HOSTED_T0_INCOMPLETE/);
    expect(
      gateConsequences(
        evaluateGate('B', [], context('2026-10-08T12:00:00+01:00')),
        '2026-10-08T12:00:00+01:00',
      ),
    ).toEqual({
      meraBountyClaimsWithdrawn: false,
      releaseBlockers: [],
    });
  });
});

describe('Gates C and D', () => {
  it('Gate C needs live provenance, not a replayed conversation', () => {
    const NOW = '2026-10-10T12:00:00+01:00';
    expect(outcome('C', gateCEvidence(), NOW)).toBe('pass');
    for (const facts of [
      { ...PROVIDER_FACTS, provenance: 'scripted-fixture' },
      { ...PROVIDER_FACTS, replayed: true },
      { ...PROVIDER_FACTS, scriptedProvider: true },
      { ...PROVIDER_FACTS, returnedModel: '' },
      { ...PROVIDER_FACTS, capabilityVerified: false },
      { ...PROVIDER_FACTS, assertionsPassed: false },
      { ...PROVIDER_FACTS, requestIds: '0' },
      { ...PROVIDER_FACTS, toolRequests: '1' },
      { ...PROVIDER_FACTS, citedBlocks: '0' },
      { provenance: 'live-provider', replayed: false },
    ]) {
      const evidence = gateCEvidence();
      evidence[0] = result('qwen-run', { evidenceClass: 'live_provider', facts });
      expect(evaluateGate('C', evidence, context(NOW)).reasons).toContain('PROVENANCE_INVALID:C1');
    }
    const local = gateCEvidence();
    local[1] = result('browser-t0-journey', {
      evidenceClass: 'local_scripted',
      facts: { chainId: '10143', transactionChecked: true, verificationChecked: true },
    });
    expect(evaluateGate('C', local, context(NOW)).reasons).toContain('INSUFFICIENT_CLASS:C2');
  });

  it('a model run is its own evidence class: no other class satisfies C1, and it satisfies nothing else', () => {
    const NOW = '2026-10-10T12:00:00+01:00';
    for (const evidenceClass of [
      'live_testnet',
      'real_device',
      'local_scripted',
      'virtual_authenticator',
    ] as const) {
      const evidence = gateCEvidence();
      evidence[0] = result('qwen-run', { evidenceClass, facts: { ...PROVIDER_FACTS } });
      expect(evaluateGate('C', evidence, context(NOW)).reasons).toContain('INSUFFICIENT_CLASS:C1');
    }
    // A provider run cannot stand in for a chain or device requirement.
    const deployment = gateAEvidence();
    deployment[1] = result('registry-deployment', {
      evidenceClass: 'live_provider',
      facts: { ...DEPLOYMENT_FACTS },
    });
    expect(evaluateGate('A', deployment, context(NOW)).reasons).toContain('INSUFFICIENT_CLASS:A2');
    const journey = gateCEvidence();
    journey[1] = result('browser-t0-journey', {
      evidenceClass: 'live_provider',
      facts: { chainId: '10143', transactionChecked: true, verificationChecked: true },
    });
    expect(evaluateGate('C', journey, context(NOW)).reasons).toContain('INSUFFICIENT_CLASS:C2');
  });

  it('Gate C needs independently checked transaction and verification evidence on testnet', () => {
    const evidence = gateCEvidence();
    evidence[1] = result('browser-t0-journey', {
      facts: { chainId: '10143', transactionChecked: false, verificationChecked: true },
    });
    expect(evaluateGate('C', evidence, context('2026-10-10T12:00:00+01:00')).outcome).toBe('fail');
  });

  it('Gate D needs every deliverable, and a public repository that is anonymously accessible', () => {
    const NOW = '2026-10-11T12:00:00+01:00';
    expect(outcome('D', gateDEvidence(), NOW)).toBe('pass');
    const missingCli = gateDEvidence().filter((item) => item.subject !== 'cli-deliverable');
    expect(evaluateGate('D', missingCli, context(NOW)).reasons).toContain('MISSING:D4');
    const private_ = gateDEvidence();
    private_[5] = result('public-repository', { facts: { anonymousAccess: false } });
    expect(evaluateGate('D', private_, context(NOW)).reasons).toContain('PROVENANCE_INVALID:D6');
  });

  it('chains prerequisites so --require D also enforces A, B and C', () => {
    expect(gatesRequiredFor('A')).toEqual(['A']);
    expect(gatesRequiredFor('C')).toEqual(['A', 'B', 'C']);
    expect([...GATE_IDS]).toEqual(gatesRequiredFor('D'));
    const all = [...gateAEvidence(), ...gateBEvidence(), ...gateCEvidence(), ...gateDEvidence()];
    const evaluations = evaluateGates(all, context('2026-10-11T12:00:00+01:00'));
    expect(evaluations.map((item) => item.outcome)).toEqual(['pass', 'pass', 'pass', 'pass']);
  });
});
