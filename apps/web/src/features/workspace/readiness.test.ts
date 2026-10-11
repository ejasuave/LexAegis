import { describe, expect, it } from 'vitest';
import { guard, selectReadiness, type WorkspaceInputs } from './public';

const finding = (id: string, state: 'ok' | 'attention' | 'technical_failure', digest = 'd1') => ({
  findingId: id,
  digest,
  state,
  summary: `finding ${id}`,
});

function base(patch: Partial<WorkspaceInputs> = {}): WorkspaceInputs {
  return {
    account: { address: '0xabc', signing: 'unlocked', backend: 'signed_in' },
    vault: { state: 'unlocked', selectedMatterId: 'm1' },
    review: { documents: 1, checks: 'fresh', unresolvedFacts: 0, save: 'saved', findings: [] },
    decisions: { dispositions: [], recorded: true, stale: false },
    capture: { state: 'recoverable', commitment: '0x' + '11'.repeat(32) },
    transaction: { stage: 'none' },
    lifecycle: { status: 'not_found', asOfBlock: '5' },
    chain: 'ready',
    indexer: 'caught_up',
    assistant: 'idle',
    ...patch,
  };
}

describe('workspace readiness', () => {
  it('permits the approval preview only when nothing blocks and a verified capture exists', () => {
    expect(selectReadiness(base()).mayPreviewApproval).toBe(true);
    expect(
      selectReadiness(base({ capture: { state: 'saved_unverified' } })).mayPreviewApproval,
    ).toBe(false);
    expect(
      selectReadiness(
        base({ account: { address: '0xabc', signing: 'locked', backend: 'signed_in' } }),
      ).mayPreviewApproval,
    ).toBe(false);
  });

  it('keeps an attention finding blocking until its current digest has a disposition', () => {
    const findings = [finding('f1', 'attention')];
    const open = selectReadiness(base({ review: { ...base().review, findings } }));
    expect(open.outstandingDecisions).toHaveLength(1);
    expect(open.mayPreviewApproval).toBe(false);
    const decided = selectReadiness(
      base({
        review: { ...base().review, findings },
        decisions: {
          dispositions: [{ findingId: 'f1', digest: 'd1', kind: 'acknowledged' }],
          recorded: true,
          stale: false,
        },
      }),
    );
    expect(decided.outstandingDecisions).toHaveLength(0);
    expect(decided.mayPreviewApproval).toBe(true);
    // A changed input digest invalidates the earlier disposition.
    const changed = selectReadiness(
      base({
        review: { ...base().review, findings: [finding('f1', 'attention', 'd2')] },
        decisions: {
          dispositions: [{ findingId: 'f1', digest: 'd1', kind: 'acknowledged' }],
          recorded: true,
          stale: false,
        },
      }),
    );
    expect(changed.outstandingDecisions).toHaveLength(1);
  });

  it('never lets a decision waive a technical failure', () => {
    const r = selectReadiness(
      base({
        review: { ...base().review, findings: [finding('t', 'technical_failure')] },
        decisions: {
          dispositions: [{ findingId: 't', digest: 'd1', kind: 'acknowledged' }],
          recorded: true,
          stale: false,
        },
      }),
    );
    expect(r.blockers.some((b) => b.code === 'TECHNICAL_FAILURE')).toBe(true);
    expect(r.mayPreviewApproval).toBe(false);
  });

  it('keeps indexer and lifecycle separate from approval readiness', () => {
    expect(selectReadiness(base({ indexer: 'unavailable' })).mayPreviewApproval).toBe(true);
    const unknown = selectReadiness(base({ lifecycle: { status: 'unknown', asOfBlock: null } }));
    expect(unknown.mayPreviewApproval).toBe(false);
    expect(unknown.dimensions.lifecycle).toBe('unknown');
  });

  it('derives stages as views of controller state', () => {
    expect(
      selectReadiness(
        base({
          capture: { state: 'none' },
          decisions: { dispositions: [], recorded: false, stale: false },
        }),
      ).stage,
    ).toBe('working_draft');
    expect(selectReadiness(base({ capture: { state: 'none' } })).stage).toBe('decisions_recorded');
    expect(selectReadiness(base({ capture: { state: 'saving' } })).stage).toBe('capture_saving');
    expect(selectReadiness(base()).stage).toBe('capture_verified');
    expect(
      selectReadiness(base({ transaction: { stage: 'submitted', outcome: 'pending' } })).stage,
    ).toBe('submission_observed');
  });
});

describe('operation scope guard', () => {
  it('rejects a completion after any identity part changes', () => {
    let scope = {
      accountAddress: '0xabc',
      accountGeneration: 1,
      vaultGeneration: 1,
      matterId: 'm',
      documentVersionIds: ['v1'],
      snapshotDigest: 's1',
      operationId: 'op',
    };
    const g = guard(() => scope);
    expect(g.stillCurrent()).toBe(true);
    scope = { ...scope, snapshotDigest: 's2' };
    expect(g.stillCurrent()).toBe(false);
  });
});
