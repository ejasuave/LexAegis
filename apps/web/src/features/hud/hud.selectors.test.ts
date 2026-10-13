import { describe, expect, it } from 'vitest';
import { BoundedIdentitySet, RunEventGate } from './hud.events';
import { ageText, freshnessOf } from './hud.freshness';
import {
  indexerReading,
  meraSessionReading,
  selectActivity,
  selectAttention,
  selectCeiling,
  selectHud,
  transactionReading,
} from './hud.selectors';
import type {
  AccountInput,
  ActiveRunInput,
  AssistantInput,
  CeilingInput,
  FindingInput,
  HudInput,
  IndexerInput,
} from './hud.types';

const NOW = Date.parse('2026-10-13T12:00:00Z');

const account: AccountInput = {
  availability: 'available',
  ceremony: 'idle',
  address: '0x7e03648f1111111111111111111111111111aaaa',
  signing: 'unlocked',
  signingExpiresAtMs: NOW + 600_000,
  lastEvent: null,
  backend: 'signed_in',
};
const indexer: IndexerInput = {
  availability: 'available',
  freshness: 'caught_up',
  indexConsistency: 'consistent',
  observedAtMs: NOW - 10_000,
  indexedBlock: '70156819',
  sourceLag: '0',
  confirmedLag: '0',
};
const ceiling: CeilingInput = {
  nowMs: NOW,
  matterTitle: 'Synthetic matter',
  selectedVersionIds: ['abcdef0123456789'],
  networkLabel: 'Monad Testnet (10143)',
  chainId: '10143',
  account,
  vaultLabel: 'Saved',
  transaction: { stage: 'idle', mayHaveBroadcast: false },
  indexer,
};
const run: ActiveRunInput = {
  state: 'running',
  toolsStarted: 2,
  toolsFinished: 1,
  stepsCompleted: 1,
  stepsTotal: 4,
  operation: 'payment check',
  outOfDate: false,
  failureMessage: null,
  failureCode: null,
  lastEventAtMs: NOW - 2_000,
};
const assistant: AssistantInput = {
  phase: 'running',
  orb: 'running',
  availability: 'ready',
  activeRun: run,
};
const finding = (over: Partial<FindingInput> & { id: string }): FindingInput => ({
  state: 'attention',
  resolved: false,
  visible: true,
  selected: false,
  ...over,
});

const reading = (id: string, c: CeilingInput = ceiling) =>
  selectCeiling(c).find((r) => r.id === id);

describe('freshness', () => {
  it('is unknown with no observation or with a future timestamp, never live', () => {
    expect(freshnessOf(null, NOW, 1000)).toBe('unknown');
    expect(freshnessOf(NOW + 60_000, NOW, 1000)).toBe('unknown');
  });
  it('is stale past the threshold and live inside it', () => {
    expect(freshnessOf(NOW - 500, NOW, 1000)).toBe('live');
    expect(freshnessOf(NOW - 5_000, NOW, 1000)).toBe('stale');
  });
  it('words ages from a local clock', () => {
    expect(ageText(NOW - 1000, NOW)).toBe('just now');
    expect(ageText(NOW - 12_000, NOW)).toBe('12 s ago');
    expect(ageText(NOW - 180_000, NOW)).toBe('3 min ago');
  });
});

describe('ceiling readings stay separate', () => {
  it('reports seven readings plus server sign-in, each from its own input', () => {
    const ids = selectCeiling(ceiling).map((r) => r.id);
    expect(ids).toEqual([
      'matter',
      'network',
      'indexer',
      'mera-session',
      'public-account',
      'vault',
      'transaction',
      'server-sign-in',
    ]);
  });

  it('a usable passkey session says nothing about the vault, and the reverse', () => {
    const locked = { ...ceiling, vaultLabel: 'Locked' };
    expect(reading('mera-session', locked)?.text).toMatch(/^Authenticated until /);
    expect(reading('vault', locked)?.text).toBe('Locked');
    const expired = {
      ...ceiling,
      account: { ...account, signing: 'locked' as const, lastEvent: 'signing_expired' },
    };
    expect(reading('mera-session', expired)?.text).toBe('Expired');
    expect(reading('vault', expired)?.text).toBe('Saved');
  });

  it('shows a passed expiry as expired even if the snapshot has not locked yet', () => {
    const late = { ...account, signingExpiresAtMs: NOW - 1 };
    expect(meraSessionReading(late, NOW).text).toBe('Expired');
  });

  it('states testnet and shows only the public address, shortened with the full value kept', () => {
    expect(reading('network')?.text).toContain('Testnet');
    const pub = reading('public-account');
    expect(pub?.text).toBe('0x7e03…aaaa');
    expect(pub?.fullValue).toBe(account.address);
  });

  it('keeps unsupported and unavailable apart from locked', () => {
    expect(meraSessionReading({ ...account, availability: 'unsupported' }, NOW).text).toMatch(
      /Unsupported/,
    );
    expect(meraSessionReading({ ...account, availability: 'misconfigured' }, NOW).text).toBe(
      'Unavailable',
    );
    expect(meraSessionReading({ ...account, address: null }, NOW).text).toBe('No account');
  });

  it('never calls a transaction confirmed before the controller does', () => {
    for (const stage of ['signing', 'sending', 'pending', 'checking_execution'] as const) {
      expect(transactionReading(stage, true).text).not.toMatch(/confirmed/i);
    }
    expect(transactionReading('confirmed', true).text).toBe('Confirmed');
    expect(transactionReading('unknown', true).text).toMatch(/may have been broadcast/);
    expect(transactionReading('failed', false).text).toBe('Not sent');
  });
});

describe('indexer reading', () => {
  it('shows block, lag and age when known', () => {
    expect(indexerReading(indexer, NOW).text).toBe(
      'Caught up, block 70156819, 0 behind, updated 10 s ago',
    );
  });
  it('shows lag unknown, not zero, when the heads cannot be compared', () => {
    const r = indexerReading({ ...indexer, sourceLag: null, confirmedLag: null }, NOW);
    expect(r.text).toContain('lag unknown');
    expect(r.text).not.toContain('Caught up');
  });
  it('labels an old observation stale rather than current', () => {
    const r = indexerReading({ ...indexer, observedAtMs: NOW - 600_000 }, NOW);
    expect(r.text).toMatch(/^Stale/);
    expect(r.tone).toBe('warn');
  });
  it('says unavailable with the last update and never a block that is not observed', () => {
    const r = indexerReading({ ...indexer, availability: 'unavailable', indexedBlock: null }, NOW);
    expect(r.text).toMatch(/^Unavailable; last updated/);
    expect(r.tone).toBe('bad');
    expect(indexerReading(null, NOW).text).toBe('Not checked');
  });
});

describe('activity', () => {
  it('runs only while an accepted event is recent, and shows step counts only when the total is known', () => {
    const a = selectActivity(assistant, NOW);
    expect(a.state).toBe('running');
    expect(a.toolsRunning).toBe(true);
    expect(a.statusText).toBe('Running payment check, step 2 of 4.');
    const noTotal = selectActivity({ ...assistant, activeRun: { ...run, stepsTotal: null } }, NOW);
    expect(noTotal.statusText).toBe('Running payment check.');
    expect(noTotal.stepsTotal).toBeNull();
  });

  it('stops claiming activity when the stream goes quiet (stale) or has no event at all (unknown)', () => {
    const quiet = selectActivity(
      { ...assistant, activeRun: { ...run, lastEventAtMs: NOW - 120_000 } },
      NOW,
    );
    expect(quiet.state).toBe('stale');
    expect(quiet.toolsRunning).toBe(false);
    expect(quiet.connection).toBe('stale');
    const none = selectActivity({ ...assistant, activeRun: { ...run, lastEventAtMs: null } }, NOW);
    expect(none.state).toBe('stale');
    expect(none.connection).toBe('unknown');
    expect(none.toolsRunning).toBe(false);
  });

  it('shows no tool particles when no tool is executing', () => {
    const idleTools = selectActivity(
      { ...assistant, activeRun: { ...run, toolsStarted: 2, toolsFinished: 2 } },
      NOW,
    );
    expect(idleTools.state).toBe('running');
    expect(idleTools.toolsRunning).toBe(false);
  });

  it('stopping is not cancelled: no completion is implied until acknowledged', () => {
    const stopping = selectActivity({ ...assistant, phase: 'stopping', orb: 'stopping' }, NOW);
    expect(stopping.state).toBe('stopping');
    expect(stopping.toolsRunning).toBe(false);
    expect(stopping.statusText).not.toMatch(/cancelled/i);
    const done = selectActivity(
      {
        phase: 'idle',
        orb: 'cancelled',
        availability: 'ready',
        activeRun: { ...run, state: 'cancelled' },
      },
      NOW,
    );
    expect(done.state).toBe('cancelled');
    expect(done.toolsRunning).toBe(false);
  });

  it('a finished run says it approves nothing; failed names the failure; interrupted is unknown', () => {
    const base = { phase: 'idle', availability: 'ready', activeRun: run } as const;
    expect(selectActivity({ ...base, orb: 'completed' }, NOW).statusText).toMatch(
      /approves nothing/,
    );
    expect(
      selectActivity(
        { ...base, orb: 'failed', activeRun: { ...run, failureMessage: 'Tool failed' } },
        NOW,
      ).statusText,
    ).toBe('Tool failed');
    expect(selectActivity({ ...base, orb: 'interrupted' }, NOW).statusText).toMatch(/not known/);
  });

  it('offline and unavailable are static and honest', () => {
    const offline = selectActivity({ ...assistant, availability: 'unreachable' }, NOW);
    expect(offline.state).toBe('offline');
    expect(offline.connection).toBe('offline');
    expect(offline.toolsRunning).toBe(false);
    const signedOut = selectActivity(
      { phase: 'idle', orb: 'unavailable', availability: 'signed_out', activeRun: null },
      NOW,
    );
    expect(signedOut.state).toBe('unavailable');
    expect(
      selectActivity({ phase: 'idle', orb: 'ready', availability: 'ready', activeRun: null }, NOW)
        .state,
    ).toBe('idle');
  });

  it('a controller that says running with no held run is not shown as working', () => {
    expect(
      selectActivity({ phase: 'idle', orb: 'running', availability: 'ready', activeRun: null }, NOW)
        .state,
    ).toBe('stale');
  });
});

describe('attention', () => {
  const findings = [
    finding({ id: 'a', state: 'needs_input' }),
    finding({ id: 'b', state: 'attention' }),
    finding({ id: 'c', state: 'technical_failure' }),
    finding({ id: 'd', state: 'attention' }),
    finding({ id: 'e', state: 'attention', visible: false }),
    finding({ id: 'f', state: 'ok' }),
    finding({ id: 'g', state: 'attention', resolved: true }),
  ];

  it('highlights at most three visible unresolved findings, the selected one first', () => {
    const view = selectAttention([
      ...findings,
      finding({ id: 'z', state: 'needs_input', selected: true }),
    ]);
    expect(view.highlighted).toHaveLength(3);
    expect(view.highlighted[0]).toBe('z');
    expect(view.highlighted[1]).toBe('c');
  });

  it('counts unresolved findings that are off-screen so the canvas can point at the Findings control', () => {
    const view = selectAttention(findings);
    expect(view.unresolvedCount).toBe(5);
    expect(view.offscreenUnresolved).toBe(1);
    expect(view.highlighted).not.toContain('e');
    expect(view.highlighted).not.toContain('f');
    expect(view.highlighted).not.toContain('g');
  });

  it('is blocking only for failures and missing input, not for an arithmetic attention state', () => {
    expect(selectAttention([finding({ id: 'b' })]).blocking).toBe(false);
    expect(selectAttention([finding({ id: 'c', state: 'technical_failure' })]).blocking).toBe(true);
    expect(selectAttention([finding({ id: 'a', state: 'needs_input' })]).blocking).toBe(true);
  });

  it('keeps a nonblocking finding next to a running run without merging them', () => {
    const input: HudInput = {
      ceiling,
      assistant,
      findings: [finding({ id: 'b' })],
      vaultUnlocked: true,
      matterSelected: true,
    };
    const view = selectHud(input);
    expect(view.activity.state).toBe('running');
    expect(view.attention.highlighted).toEqual(['b']);
    expect(view.attention.blocking).toBe(false);
  });

  it('clears private anchors the moment the vault locks, leaving public readings alone', () => {
    const view = selectHud({
      ceiling: {
        ...ceiling,
        vaultLabel: 'Locked',
        transaction: { stage: 'pending', mayHaveBroadcast: true },
      },
      assistant,
      findings: [finding({ id: 'b' })],
      vaultUnlocked: false,
      matterSelected: true,
    });
    expect(view.clearPrivateAnchors).toBe(true);
    expect(view.attention.highlighted).toEqual([]);
    expect(view.attention.unresolvedCount).toBe(0);
    expect(view.readings.find((r) => r.id === 'transaction')?.text).toBe('Pending');
  });
});

describe('run event gate', () => {
  const ctx = { runId: 'r1', matterId: 'm1', documentVersionId: 'v1' };
  const ev = (seq: number, over: Partial<typeof ctx> = {}) => ({ ...ctx, ...over, seq });

  it('accepts in order, drops duplicates and out-of-order events, and flags gaps', () => {
    const gate = new RunEventGate();
    gate.setContext(ctx);
    expect(gate.accept(ev(1))).toBe('accepted');
    expect(gate.accept(ev(2))).toBe('accepted');
    expect(gate.accept(ev(2))).toBe('duplicate');
    expect(gate.accept(ev(1))).toBe('out_of_order');
    expect(gate.accept(ev(4))).toBe('gap');
    expect(gate.accept(ev(3))).toBe('accepted');
  });

  it('treats events for another run, matter or version as obsolete, and a context switch resets', () => {
    const gate = new RunEventGate();
    expect(gate.accept(ev(1))).toBe('obsolete');
    gate.setContext(ctx);
    gate.accept(ev(1));
    expect(gate.accept(ev(2, { matterId: 'm2' }))).toBe('obsolete');
    expect(gate.accept(ev(2, { runId: 'r0' }))).toBe('obsolete');
    expect(gate.accept(ev(2, { documentVersionId: 'v2' }))).toBe('obsolete');
    gate.setContext({ ...ctx, matterId: 'm2' });
    expect(gate.accept(ev(1, { matterId: 'm2' }))).toBe('accepted');
    expect(gate.accept(ev(2))).toBe('obsolete');
  });

  it('rejects invalid sequence numbers', () => {
    const gate = new RunEventGate();
    gate.setContext(ctx);
    expect(gate.accept(ev(0))).toBe('out_of_order');
    expect(gate.accept(ev(1.5))).toBe('out_of_order');
  });

  it('bounds remembered identities', () => {
    const set = new BoundedIdentitySet(3);
    for (const id of ['a', 'b', 'c', 'd']) expect(set.add(id)).toBe(true);
    expect(set.size).toBe(3);
    expect(set.has('a')).toBe(false);
    expect(set.add('d')).toBe(false);
    expect(() => new BoundedIdentitySet(0)).toThrow();
  });
});
