import { runBudgetSchema, utf8Bytes, type RunBudget, type RunUsage } from '../contracts';
import type { ProviderRequest, ProviderResult } from './provider';
import type { RunCounters } from './run-store';

/*
 * Hard per-run ceilings. They bound attempts, tool executions, time and reserved tokens; they do
 * not promise an invoice cap. Input size is reserved before dispatch from a conservative UTF-8
 * byte count (a token is never shorter than a byte) plus a framing reserve, and is labelled an
 * estimate everywhere. Reported usage replaces the reservation when the provider supplies it;
 * when it does not, usage is unknown and the reservation stays charged.
 */

export const DEFAULT_BUDGET: RunBudget = Object.freeze({
  providerAttempts: 6,
  toolExecutions: 8,
  totalMs: 120_000,
  attemptMs: 25_000,
  completionTokensPerAttempt: 2048,
  completionTokensPerRun: 8192,
  inputTokensPerAttempt: 65_536,
  inputTokensPerRun: 196_608,
});

/** Reserved for the provider's message framing, tool schemas overhead and tokenizer differences. */
export const FRAMING_RESERVE_TOKENS = 4096;
/** The provider documents that a completion may exceed max_completion_tokens by up to 10 tokens. */
export const OUTPUT_TOLERANCE_TOKENS = 10;
/** Kept back from tool and routing rounds so a final answer always has room. */
const FINAL_OUTPUT_RESERVE = 2048;
const MIN_OUTPUT_TOKENS = 128;

const OUTPUT_BY_PURPOSE: Readonly<Record<ProviderRequest['purpose'], number>> = {
  route: 256,
  tool_round: 512,
  final: 2048,
  repair: 2048,
  capability: 256,
};

/** Operator overrides can lower a ceiling. A higher or malformed value leaves the default. */
export function resolveBudget(
  overrides: Partial<Record<'runSeconds' | 'providerAttempts' | 'toolExecutions', number>> = {},
): RunBudget {
  const lower = (value: number | undefined, ceiling: number, floor: number): number =>
    value === undefined || !Number.isInteger(value) || value < floor
      ? ceiling
      : Math.min(value, ceiling);
  return runBudgetSchema.parse({
    ...DEFAULT_BUDGET,
    providerAttempts: lower(overrides.providerAttempts, DEFAULT_BUDGET.providerAttempts, 1),
    toolExecutions: lower(overrides.toolExecutions, DEFAULT_BUDGET.toolExecutions, 0),
    totalMs: lower(
      overrides.runSeconds === undefined ? undefined : overrides.runSeconds * 1000,
      DEFAULT_BUDGET.totalMs,
      1000,
    ),
  });
}

/** Conservative input estimate: every byte of what is sent, plus the framing reserve. */
export function estimateInputTokens(
  request: Pick<ProviderRequest, 'messages' | 'tools' | 'responseFormat'>,
): number {
  return (
    utf8Bytes(
      JSON.stringify([request.messages, request.tools ?? [], request.responseFormat ?? null]),
    ) + FRAMING_RESERVE_TOKENS
  );
}

export type BudgetDenial = 'ATTEMPTS' | 'DEADLINE' | 'INPUT_TOKENS' | 'OUTPUT_TOKENS';

export type Reservation =
  | {
      readonly ok: true;
      readonly maxCompletionTokens: number;
      readonly timeoutMs: number;
      readonly inputEstimate: number;
      readonly outputReserved: number;
    }
  | { readonly ok: false; readonly reason: BudgetDenial };

export class BudgetTracker {
  readonly budget: RunBudget;
  readonly #deadlineMs: number;
  readonly #now: () => number;
  #attempts = 0;
  #tools = 0;
  #reservedInput = 0;
  #reservedOutput = 0;
  #chargedInput = 0;
  #chargedOutput = 0;
  #reportedInput = 0;
  #reportedOutput = 0;
  #reportedAttempts = 0;
  #retryUsed = false;
  #repairUsed = false;

  constructor(budget: RunBudget, startedAtMs: number, now: () => number) {
    this.budget = budget;
    this.#deadlineMs = startedAtMs + budget.totalMs;
    this.#now = now;
  }

  get deadlineMs(): number {
    return this.#deadlineMs;
  }
  remainingMs(): number {
    return Math.max(0, this.#deadlineMs - this.#now());
  }
  attemptsLeft(): number {
    return this.budget.providerAttempts - this.#attempts;
  }
  toolsLeft(): number {
    return this.budget.toolExecutions - this.#tools;
  }

  /** A tool round may start only while an attempt remains for the final answer afterwards. */
  canStartToolRound(): boolean {
    return this.attemptsLeft() >= 2 && this.toolsLeft() > 0 && this.remainingMs() > 1000;
  }

  /** Reserves one provider attempt before dispatch, or says which ceiling prevents it. */
  reserve(
    request: Pick<ProviderRequest, 'purpose' | 'messages' | 'tools' | 'responseFormat'>,
  ): Reservation {
    if (this.attemptsLeft() <= 0) return { ok: false, reason: 'ATTEMPTS' };
    const remainingMs = this.remainingMs();
    if (remainingMs < 1000) return { ok: false, reason: 'DEADLINE' };
    const inputEstimate = estimateInputTokens(request);
    if (
      inputEstimate > this.budget.inputTokensPerAttempt ||
      this.#chargedInput + inputEstimate > this.budget.inputTokensPerRun
    )
      return { ok: false, reason: 'INPUT_TOKENS' };
    const closing = request.purpose === 'final' || request.purpose === 'repair';
    const available =
      this.budget.completionTokensPerRun -
      this.#chargedOutput -
      (closing ? 0 : FINAL_OUTPUT_RESERVE);
    const granted = Math.min(
      OUTPUT_BY_PURPOSE[request.purpose],
      this.budget.completionTokensPerAttempt,
      available,
    );
    if (granted < MIN_OUTPUT_TOKENS) return { ok: false, reason: 'OUTPUT_TOKENS' };
    this.#attempts += 1;
    this.#reservedInput += inputEstimate;
    this.#reservedOutput += granted;
    this.#chargedInput += inputEstimate;
    this.#chargedOutput += granted;
    return {
      ok: true,
      // Headroom for the documented tolerance stays inside the reservation.
      maxCompletionTokens: granted - OUTPUT_TOLERANCE_TOKENS,
      timeoutMs: Math.min(this.budget.attemptMs, remainingMs),
      inputEstimate,
      outputReserved: granted,
    };
  }

  /** Reconciles a finished attempt. Missing or aborted usage stays unknown and stays charged. */
  settle(reservation: Extract<Reservation, { ok: true }>, result: ProviderResult): void {
    if (!result.ok || result.usage === null) return;
    this.#reportedAttempts += 1;
    this.#reportedInput += result.usage.promptTokens;
    this.#reportedOutput += result.usage.completionTokens;
    this.#chargedInput += result.usage.promptTokens - reservation.inputEstimate;
    this.#chargedOutput += result.usage.completionTokens - reservation.outputReserved;
  }

  /** Counts one tool execution. False when the ceiling is reached: the tool must not run. */
  takeTool(): boolean {
    if (this.toolsLeft() <= 0) return false;
    this.#tools += 1;
    return true;
  }

  /** The single transient retry of a run. The first attempt stays charged: it may be billed. */
  takeRetry(): boolean {
    if (this.#retryUsed || this.attemptsLeft() <= 0 || this.remainingMs() < 2000) return false;
    this.#retryUsed = true;
    return true;
  }

  /** The single repair completion of a run, for malformed arguments or output. */
  takeRepair(): boolean {
    if (this.#repairUsed || this.attemptsLeft() <= 0 || this.remainingMs() < 2000) return false;
    this.#repairUsed = true;
    return true;
  }

  counters(): RunCounters {
    const none = this.#attempts === 0;
    return {
      providerAttempts: this.#attempts,
      toolExecutions: this.#tools,
      reservedInputTokens: this.#reservedInput,
      reservedOutputTokens: this.#reservedOutput,
      reportedInputTokens: this.#reportedAttempts === 0 ? null : this.#reportedInput,
      reportedOutputTokens: this.#reportedAttempts === 0 ? null : this.#reportedOutput,
      usageProvenance: none
        ? 'none'
        : this.#reportedAttempts === 0
          ? 'unknown'
          : this.#reportedAttempts === this.#attempts
            ? 'provider_reported'
            : 'partially_reported',
    };
  }

  usage(): RunUsage {
    return usageOf(this.counters());
  }
}

export function usageOf(counters: RunCounters): RunUsage {
  return {
    provenance: counters.usageProvenance,
    providerAttempts: counters.providerAttempts,
    toolExecutions: counters.toolExecutions,
    reservedInputTokens: counters.reservedInputTokens,
    reservedOutputTokens: counters.reservedOutputTokens,
    inputEstimate: counters.providerAttempts === 0 ? 'none' : 'conservative_utf8_bytes',
    reportedInputTokens: counters.reportedInputTokens,
    reportedOutputTokens: counters.reportedOutputTokens,
  };
}
