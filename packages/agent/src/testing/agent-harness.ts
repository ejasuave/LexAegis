import type { AssistantEvent, AssistantRequest, RunBudget } from '../contracts';
import type { StartedRun } from '../ports';
import { DEFAULT_BUDGET } from '../runtime/budget';
import type { ModelOutput } from '../runtime/model-schemas';
import { createReviewAgent, type AgentDeps } from '../runtime/run-agent';
import { DEFAULT_ADMISSION, type AdmissionLimits } from '../runtime/run-store';
import type { StatusPort } from '../runtime/tools';
import { TEST_IDS } from './fixtures';
import { createMemoryRunStore } from './memory-run-store';
import {
  createScriptedProvider,
  json,
  type ScriptStep,
  type ScriptedProvider,
} from './scripted-provider';

/*
 * Test harness: the real runtime on a scripted provider and a run store. The clock starts ten
 * seconds after the synthetic consent time and advances with real time. Tests only.
 */

const CONSENT_TIME = Date.parse('2026-10-10T09:05:10.000Z');

export interface HarnessOptions {
  readonly budget?: RunBudget;
  readonly admission?: AdmissionLimits;
  readonly briefingEnabled?: boolean;
  readonly status?: StatusPort;
  readonly provider?: ScriptedProvider | null;
  readonly deps?: Partial<AgentDeps>;
}

export function agentHarness(script: readonly ScriptStep[], options: HarnessOptions = {}) {
  const started = Date.now();
  const clock = { offsetMs: 0 };
  const now = () => new Date(CONSENT_TIME + (Date.now() - started) + clock.offsetMs);
  const store = createMemoryRunStore();
  const provider =
    options.provider === undefined ? createScriptedProvider(script) : options.provider;
  const session = { valid: true };
  const agent = createReviewAgent({
    provider,
    store,
    status: options.status ?? { liveChain: () => Promise.resolve('not_configured') },
    budget: options.budget ?? DEFAULT_BUDGET,
    admission: options.admission ?? DEFAULT_ADMISSION,
    flags: { briefingEnabled: options.briefingEnabled ?? true },
    notices: [],
    now,
    newId: () => crypto.randomUUID(),
    heartbeatMs: 5,
    cancelAckWaitMs: 300,
    ...options.deps,
  });
  const connection = new AbortController();
  const start = (request: AssistantRequest, ownerId: string = TEST_IDS.reviewer) =>
    agent.start(request, {
      ownerId,
      signal: connection.signal,
      sessionValid: () => Promise.resolve(session.valid),
    });
  return {
    agent,
    store,
    provider: provider as ScriptedProvider,
    clock,
    session,
    connection,
    start,
    now,
  };
}

export async function collect(run: StartedRun): Promise<AssistantEvent[]> {
  const events: AssistantEvent[] = [];
  if (run.events === null) return events;
  for await (const event of run.events) events.push(event);
  return events;
}

export function started<T>(
  result: { ok: true; data: T } | { ok: false; error: { code: string } },
): T {
  if (!result.ok) throw new Error(`run did not start: ${result.error.code}`);
  return result.data;
}

/** A schema-valid final answer; override any part. */
export const answer = (overrides: Partial<ModelOutput> = {}) =>
  json({
    outcome: 'answer',
    blocks: [
      {
        kind: 'explanation',
        text: 'The selected clause states the total settlement sum.',
        basis: 'supported',
        sources: ['S1'],
        rules: [],
        tools: [],
      },
    ],
    factProposals: [],
    unresolved: [],
    questions: [],
    scopeLimitations: [],
    nextActions: [],
    ...overrides,
  } satisfies ModelOutput);

export const terminalOf = (events: readonly AssistantEvent[]) =>
  events.filter((event) => event.type.startsWith('run_'));
