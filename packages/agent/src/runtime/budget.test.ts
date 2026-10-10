import { describe, expect, it } from 'vitest';
import { runBudgetSchema } from '../contracts';
import { failure, text } from '../testing/scripted-provider';
import {
  BudgetTracker,
  DEFAULT_BUDGET,
  FRAMING_RESERVE_TOKENS,
  estimateInputTokens,
  resolveBudget,
} from './budget';
import type { ProviderRequest } from './provider';

const request = (
  purpose: ProviderRequest['purpose'],
  content = 'synthetic',
): Pick<ProviderRequest, 'purpose' | 'messages' | 'tools' | 'responseFormat'> => ({
  purpose,
  messages: [{ role: 'user', content }],
});

function tracker(budget = DEFAULT_BUDGET) {
  const clock = { ms: 1_000_000 };
  return { clock, budget: new BudgetTracker(budget, clock.ms, () => clock.ms) };
}
const granted = (reservation: ReturnType<BudgetTracker['reserve']>) => {
  if (!reservation.ok) throw new Error(reservation.reason);
  return reservation;
};

describe('run budget', () => {
  it('has the documented default ceilings, which configuration can lower but not raise', () => {
    expect(DEFAULT_BUDGET).toEqual({
      providerAttempts: 6,
      toolExecutions: 8,
      totalMs: 120_000,
      attemptMs: 25_000,
      completionTokensPerAttempt: 2048,
      completionTokensPerRun: 8192,
      inputTokensPerAttempt: 65_536,
      inputTokensPerRun: 196_608,
    });
    expect(resolveBudget({ runSeconds: 30, providerAttempts: 3, toolExecutions: 2 })).toMatchObject(
      {
        totalMs: 30_000,
        providerAttempts: 3,
        toolExecutions: 2,
      },
    );
    expect(resolveBudget({ runSeconds: 900, providerAttempts: 60, toolExecutions: 99 })).toEqual(
      DEFAULT_BUDGET,
    );
    expect(runBudgetSchema.safeParse({ ...DEFAULT_BUDGET, providerAttempts: 7 }).success).toBe(
      false,
    );
  });

  it('estimates input conservatively from UTF-8 bytes plus the framing reserve', () => {
    const ascii = estimateInputTokens(request('final', 'abcd'));
    const wide = estimateInputTokens(request('final', '££££'));
    expect(wide - ascii).toBe(4);
    expect(ascii).toBeGreaterThan(FRAMING_RESERVE_TOKENS);
    // Never characters divided by four.
    expect(estimateInputTokens(request('final', 'x'.repeat(4000)))).toBeGreaterThan(
      4000 + FRAMING_RESERVE_TOKENS,
    );
  });

  it('allows six provider attempts in total, counting routing, repair and retries', () => {
    const { budget } = tracker();
    for (const purpose of [
      'route',
      'tool_round',
      'tool_round',
      'final',
      'repair',
      'final',
    ] as const) {
      expect(budget.reserve(request(purpose)).ok).toBe(true);
    }
    expect(budget.reserve(request('final'))).toEqual({ ok: false, reason: 'ATTEMPTS' });
    expect(budget.counters().providerAttempts).toBe(6);
  });

  it('keeps an attempt and output room for the final answer instead of spending all on tools', () => {
    const { budget } = tracker();
    let rounds = 0;
    while (budget.canStartToolRound()) {
      granted(budget.reserve(request('tool_round')));
      rounds += 1;
    }
    expect(rounds).toBe(5);
    expect(budget.attemptsLeft()).toBe(1);
    const final = granted(budget.reserve(request('final')));
    expect(final.maxCompletionTokens).toBe(2048 - 10);
  });

  it('caps completion tokens per attempt and per run, with headroom for the provider tolerance', () => {
    const { budget } = tracker({ ...DEFAULT_BUDGET, completionTokensPerRun: 4096 });
    expect(granted(budget.reserve(request('final'))).maxCompletionTokens).toBe(2038);
    expect(granted(budget.reserve(request('repair'))).maxCompletionTokens).toBe(2038);
    expect(budget.reserve(request('final'))).toEqual({ ok: false, reason: 'OUTPUT_TOKENS' });
  });

  it('refuses an attempt whose reserved input exceeds the per-attempt or per-run ceiling', () => {
    const small = tracker({
      ...DEFAULT_BUDGET,
      inputTokensPerAttempt: 8000,
      inputTokensPerRun: 12_000,
    });
    expect(small.budget.reserve(request('final', 'x'.repeat(5000)))).toEqual({
      ok: false,
      reason: 'INPUT_TOKENS',
    });
    expect(small.budget.reserve(request('final', 'x'.repeat(100))).ok).toBe(true);
    expect(small.budget.reserve(request('final', 'x'.repeat(100))).ok).toBe(true);
    expect(small.budget.reserve(request('final', 'x'.repeat(100)))).toEqual({
      ok: false,
      reason: 'INPUT_TOKENS',
    });
    // A refused attempt is not counted as dispatched.
    expect(small.budget.counters().providerAttempts).toBe(2);
  });

  it('stops at the 120-second deadline and shortens the last attempt timeout', () => {
    const { budget, clock } = tracker();
    expect(granted(budget.reserve(request('tool_round'))).timeoutMs).toBe(25_000);
    clock.ms += 110_000;
    expect(granted(budget.reserve(request('final'))).timeoutMs).toBe(10_000);
    clock.ms += 9_500;
    expect(budget.reserve(request('repair'))).toEqual({ ok: false, reason: 'DEADLINE' });
    expect(budget.canStartToolRound()).toBe(false);
  });

  it('reconciles reported usage and frees reserved input for later attempts', () => {
    const { budget } = tracker({ ...DEFAULT_BUDGET, inputTokensPerRun: 10_000 });
    const first = granted(budget.reserve(request('tool_round')));
    budget.settle(first, text('DONE', { usage: { promptTokens: 300, completionTokens: 5 } }));
    const second = granted(budget.reserve(request('final')));
    budget.settle(second, text('{}', { usage: { promptTokens: 320, completionTokens: 40 } }));
    expect(budget.counters()).toMatchObject({
      providerAttempts: 2,
      reportedInputTokens: 620,
      reportedOutputTokens: 45,
      usageProvenance: 'provider_reported',
    });
    // Reserved totals remain the labelled estimates, not the reported counts.
    expect(budget.usage()).toMatchObject({ inputEstimate: 'conservative_utf8_bytes' });
    expect(budget.usage().reservedInputTokens).toBeGreaterThan(2 * FRAMING_RESERVE_TOKENS);
    expect(budget.reserve(request('repair')).ok).toBe(true);
  });

  it('keeps usage unknown, and the reservation charged, when a response reports none or is aborted', () => {
    const { budget } = tracker({ ...DEFAULT_BUDGET, inputTokensPerRun: 9000 });
    const first = granted(budget.reserve(request('tool_round')));
    budget.settle(first, text('DONE', { usage: null }));
    expect(budget.counters()).toMatchObject({
      reportedInputTokens: null,
      reportedOutputTokens: null,
      usageProvenance: 'unknown',
    });
    const second = granted(budget.reserve(request('final')));
    budget.settle(second, failure('aborted'));
    expect(budget.counters().usageProvenance).toBe('unknown');
    // Both reservations still count against the run ceiling.
    expect(budget.reserve(request('final'))).toEqual({ ok: false, reason: 'INPUT_TOKENS' });
    const mixed = tracker();
    mixed.budget.settle(granted(mixed.budget.reserve(request('tool_round'))), text('DONE'));
    mixed.budget.settle(
      granted(mixed.budget.reserve(request('final'))),
      text('{}', { usage: null }),
    );
    expect(mixed.budget.counters().usageProvenance).toBe('partially_reported');
    expect(tracker().budget.usage()).toMatchObject({ provenance: 'none', inputEstimate: 'none' });
  });

  it('permits one retry and one repair per run, and eight tool executions', () => {
    const { budget } = tracker();
    expect(budget.takeRetry()).toBe(true);
    expect(budget.takeRetry()).toBe(false);
    expect(budget.takeRepair()).toBe(true);
    expect(budget.takeRepair()).toBe(false);
    for (let i = 0; i < 8; i += 1) expect(budget.takeTool()).toBe(true);
    expect(budget.takeTool()).toBe(false);
    expect(budget.counters().toolExecutions).toBe(8);
  });

  it('offers no retry once attempts or time are spent', () => {
    const { budget, clock } = tracker({ ...DEFAULT_BUDGET, providerAttempts: 1 });
    granted(budget.reserve(request('final')));
    expect(budget.takeRetry()).toBe(false);
    const late = tracker();
    late.clock.ms += 119_000;
    expect(late.budget.takeRetry()).toBe(false);
    expect(clock.ms).toBe(1_000_000);
  });
});
