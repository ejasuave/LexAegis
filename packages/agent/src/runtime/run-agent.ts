import { createApplicationError, fail, ok, type ErrorCode, type Result } from '@lexaegis/protocol';
import {
  REVIEW_PROFILE,
  assistantEventSchema,
  assistantResponseSchema,
  type AgentConfig,
  type AgentConfigV1,
  type AgentIdentityRef,
  type AgentRunMetadataV1,
  type AnswerBlock,
  type AssistantAvailability,
  type AssistantEvent,
  type AssistantIntent,
  type AssistantPlan,
  type AssistantRequest,
  type AssistantResponse,
  type AssistantRunState,
  type AssistantToolName,
  type IntentSelectionV1,
  type ProviderScope,
  type RunBudget,
  type RunFailureCode,
  type RunOutcome,
  type UnresolvedItem,
} from '../contracts';
import type { CancelOutcome, ReviewAgent, StartRunContext, StartedRun } from '../ports';
import { disclosureDigest, loadRulePack, paymentGroups, type LoadedRulePack } from '../review';
import type { CapabilityRecord } from '../server/capability-record';
import { BudgetTracker, usageOf } from './budget';
import { parseIntentSelection, routeRequest } from './intent-router';
import {
  finalRound,
  initialMessages,
  promptManifestRef,
  repairRound,
  routerRound,
  toolRepairInstruction,
} from './prompts';
import {
  RETRYABLE_FAILURES,
  type ChatMessage,
  type ChatProvider,
  type ProviderFailure,
  type ProviderRequest,
  type ProviderResult,
} from './provider';
import {
  HEARTBEAT_MS,
  LEASE_MS,
  isActive,
  toRunMetadata,
  type AdmissionLimits,
  type RunRow,
  type RunStore,
  type TerminalState,
} from './run-store';
import { providerTool, toolsForIntent } from './tool-schemas';
import { ToolRunner, type StatusPort } from './tools';
import { validateModelOutput, type OutputContext } from './validate-output';

/*
 * The ReviewAgent runtime: one bounded application state machine per run. Code admits the run,
 * chooses the intent, authorises every tool call, validates the final output and decides the
 * single terminal state. The model only proposes. Nothing here can approve, freeze, sign or
 * broadcast, and nothing continues in the background: active plaintext and the AbortController
 * live in this process only, and a run that loses its worker is interrupted, never resumed.
 */

export const RUNTIME_VERSION = 'lexaegis.agent-runtime.v1';
/** A consent older than this, or dated in the future, is not accepted for a new run. */
export const CONSENT_MAX_AGE_MS = 10 * 60 * 1000;
const CONSENT_CLOCK_SKEW_MS = 60 * 1000;
/** How long a cancel request waits for the worker's acknowledgement before answering "stopping". */
const CANCEL_ACK_WAIT_MS = 1_500;
const MAX_QUEUED_EVENTS = 256;

export interface AgentDeps {
  /** Null when no provider is configured: model-assisted work is then NOT_CONFIGURED. */
  readonly provider: ChatProvider | null;
  readonly store: RunStore;
  readonly status: StatusPort;
  readonly budget: RunBudget;
  readonly admission: AdmissionLimits;
  readonly flags: { readonly briefingEnabled: boolean };
  /** What is known about the provider's handling, shown before any disclosure. */
  readonly notices: readonly string[];
  readonly now: () => Date;
  /** Lowercase UUIDv4. */
  readonly newId: () => string;
  readonly heartbeatMs?: number;
  readonly cancelAckWaitMs?: number;
  readonly rulePack?: () => Promise<LoadedRulePack | null>;
  /**
   * An ERC-8004 reference from verified operator configuration (a confirmed registration and a
   * successful identity read in this session). Unset in production until that exists. Model output,
   * documents, cards and client payloads can never set it.
   */
  readonly agentIdentity?: AgentIdentityRef;
}

type Capability = { state: 'verified' | 'configured' | 'test'; record: CapabilityRecord | null };

class Stop extends Error {}
class Failure extends Error {
  constructor(readonly failure: RunFailureCode) {
    super(failure);
  }
}

const FAILURE_TEXT: Readonly<Record<RunFailureCode, readonly [ErrorCode, string]>> = {
  NOT_CONFIGURED: ['NOT_CONFIGURED', 'The review assistant is not configured.'],
  NOT_VERIFIED: ['UNAVAILABLE', 'The assistant configuration has not been verified.'],
  FEATURE_DISABLED: ['NOT_FOUND', 'This request is not available.'],
  UNSUPPORTED_REQUEST: ['INVALID_INPUT', 'The assistant cannot do this request.'],
  STALE_SNAPSHOT: ['CONFLICT', 'The review inputs changed. Start a new request.'],
  SESSION_INVALID: ['UNAUTHENTICATED', 'Your sign-in ended, so the run was stopped.'],
  PROVIDER_AUTHENTICATION: [
    'UNAVAILABLE',
    'The model provider rejected the configured credentials.',
  ],
  PROVIDER_CAPABILITY: ['UNAVAILABLE', 'The model provider did not accept this request format.'],
  PROVIDER_RATE_LIMITED: ['RATE_LIMITED', 'The model provider is rate limiting requests.'],
  PROVIDER_TIMEOUT: ['UNAVAILABLE', 'The model provider did not answer in time.'],
  PROVIDER_TRANSPORT: ['UNAVAILABLE', 'The model provider could not be reached.'],
  PROVIDER_REFUSAL: ['UNAVAILABLE', 'The model provider declined this request.'],
  OUTPUT_MALFORMED: ['UNAVAILABLE', 'The model output failed validation and was discarded.'],
  OUTPUT_TRUNCATED: ['UNAVAILABLE', 'The model output was cut off and was discarded.'],
  PARALLEL_TOOL_CALLS: ['UNAVAILABLE', 'The model requested several tools at once; none was run.'],
  TOOL_LIMIT: ['UNAVAILABLE', 'The tool limit for one run was reached.'],
  BUDGET_EXHAUSTED: ['UNAVAILABLE', 'The run reached its budget before an answer was validated.'],
  DEADLINE_EXCEEDED: ['UNAVAILABLE', 'The run reached its time limit.'],
  INTERNAL: ['INTERNAL', 'Unexpected server error.'],
};

const PROVIDER_FAILURES: Readonly<Record<ProviderFailure, RunFailureCode>> = {
  authentication: 'PROVIDER_AUTHENTICATION',
  capability: 'PROVIDER_CAPABILITY',
  rate_limit: 'PROVIDER_RATE_LIMITED',
  timeout: 'PROVIDER_TIMEOUT',
  transport: 'PROVIDER_TRANSPORT',
  malformed_output: 'OUTPUT_MALFORMED',
  refusal: 'PROVIDER_REFUSAL',
  aborted: 'INTERNAL',
};

const PLAN_LABELS = {
  model: [
    'Check the request and consent',
    'Read selected material and run checks',
    'Draft the answer',
    'Validate references',
  ],
  direct: ['Check the request', 'Run the check', 'Report the result'],
} as const;

const CLARIFY_QUESTION =
  'Which do you want: summarise the selection, explain a clause, check the payments, list missing evidence, prepare the review, or show status?';
const OUT_OF_SCOPE_TEXT =
  'Aegis cannot do this. Approval, signing and changes to facts or rules are done by you, with their own controls.';

/** A small in-process queue between the worker and the response stream. */
class EventChannel {
  readonly #queue: AssistantEvent[] = [];
  #waiting: ((result: IteratorResult<AssistantEvent>) => void) | null = null;
  #closed = false;
  overflowed = false;

  push(event: AssistantEvent): void {
    if (this.#closed) return;
    if (this.#waiting !== null) {
      const resolve = this.#waiting;
      this.#waiting = null;
      resolve({ done: false, value: event });
      return;
    }
    if (this.#queue.length >= MAX_QUEUED_EVENTS) {
      this.overflowed = true;
      return;
    }
    this.#queue.push(event);
  }

  close(): void {
    this.#closed = true;
    if (this.#waiting !== null) {
      const resolve = this.#waiting;
      this.#waiting = null;
      resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AssistantEvent> {
    return {
      next: () => {
        const queued = this.#queue.shift();
        if (queued !== undefined) return Promise.resolve({ done: false, value: queued });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
    };
  }
}

export function scopeOf(provider: ChatProvider): ProviderScope {
  const { id, model, region } = provider.descriptor;
  return { provider: id, model, region };
}

export function createReviewAgent(deps: AgentDeps): ReviewAgent {
  const { provider, store } = deps;
  /** Runs this process is working on. Plaintext and abort handles never leave this map. */
  const active = new Map<string, { owner: string; stop: () => void }>();
  const loadPack =
    deps.rulePack ??
    (async () => {
      const loaded = await loadRulePack();
      return loaded.ok ? loaded.data : null;
    });
  const error = (failure: RunFailureCode) => {
    const [code, message] = FAILURE_TEXT[failure];
    return createApplicationError(code, message);
  };

  async function capability(): Promise<Capability | null> {
    if (provider === null) return null;
    if (provider.descriptor.id === 'scripted-test') return { state: 'test', record: null };
    const record = await store.capability(provider.descriptor.fingerprint);
    return { state: record?.verified === true ? 'verified' : 'configured', record };
  }

  async function availability(): Promise<AssistantAvailability> {
    const current = await capability();
    return {
      schema: 'lexaegis.assistant-availability.v1',
      state:
        provider === null || current === null
          ? 'not_configured'
          : current.state === 'test'
            ? 'test_provider'
            : current.state === 'verified'
              ? 'verified'
              : 'configured_unverified',
      providerScope: provider === null ? null : scopeOf(provider),
      notices: [...deps.notices],
      briefingEnabled: deps.flags.briefingEnabled,
    };
  }

  async function start(
    request: AssistantRequest,
    context: StartRunContext,
  ): Promise<Result<StartedRun>> {
    if (provider === null) return fail(error('NOT_CONFIGURED'));
    const current = await capability();
    // Real-matter inference runs only on a configuration whose capability checks passed.
    if (current === null || current.state === 'configured') return fail(error('NOT_VERIFIED'));

    const scope = scopeOf(provider);
    const { consent, ...body } = request;
    const consentedAt = Date.parse(consent.consentedAt);
    const now = deps.now();
    if (
      consent.providerScope.provider !== scope.provider ||
      consent.providerScope.model !== scope.model ||
      consent.providerScope.region !== scope.region ||
      consent.disclosureDigest !== (await disclosureDigest(body, scope)) ||
      consentedAt > now.getTime() + CONSENT_CLOCK_SKEW_MS ||
      consentedAt < now.getTime() - CONSENT_MAX_AGE_MS
    ) {
      return fail(
        createApplicationError(
          'INVALID_INPUT',
          'The disclosure consent does not match this request.',
        ),
      );
    }

    const runId = deps.newId();
    const leaseToken = deps.newId();
    const admitted = await store.admit({
      runId,
      owner: context.ownerId,
      clientRequestId: request.clientRequestId,
      leaseToken,
      now,
      deadlineAt: new Date(now.getTime() + deps.budget.totalMs),
      limits: deps.admission,
    });
    if (admitted.kind === 'denied') {
      return fail(
        createApplicationError(
          'RATE_LIMITED',
          admitted.reason === 'OWNER_ACTIVE'
            ? 'You already have an assistant run in progress.'
            : admitted.reason === 'GLOBAL_ACTIVE'
              ? 'The assistant is busy. Try again shortly.'
              : 'The daily assistant limit has been reached.',
        ),
      );
    }
    // A repeated request ID is a repeated admission: nothing runs again and no result is replayed.
    if (admitted.kind === 'duplicate')
      return ok({ metadata: toRunMetadata(admitted.row, true), events: null });

    const channel = new EventChannel();
    void execute({ request, context, row: admitted.row, leaseToken, channel, capability: current });
    return ok({ metadata: toRunMetadata(admitted.row), events: channel });
  }

  interface Execution {
    readonly request: AssistantRequest;
    readonly context: StartRunContext;
    readonly row: RunRow;
    readonly leaseToken: string;
    readonly channel: EventChannel;
    readonly capability: Capability;
  }

  async function execute(run: Execution): Promise<void> {
    const { request, context, row, leaseToken, channel } = run;
    const runId = row.runId;
    if (provider === null) return;
    const controller = new AbortController();
    const aborted = () => controller.signal.aborted;
    const startedAt = deps.now();
    const budget = new BudgetTracker(deps.budget, startedAt.getTime(), () => deps.now().getTime());
    let seq = 0;
    let state: AssistantRunState = 'queued';
    // Set from timers and callbacks, so kept on an object rather than in narrowed locals.
    const flags = { fenced: false, deadlineHit: false };
    let terminal = false;
    const requestIds: string[] = [];
    let returnedModel: string | null = null;
    const toolsOffered = new Set<AssistantToolName>();
    let intent: AssistantIntent | null = null;

    const emit = (event: { type: AssistantEvent['type']; payload: unknown }): void => {
      if (terminal) return;
      seq += 1;
      // Every payload is validated before it can leave the process.
      channel.push(
        assistantEventSchema.parse({
          schema: 'lexaegis.assistant-event.v1',
          runId,
          matterId: request.matterId,
          documentVersionId: request.documentVersionId,
          snapshotDigest: request.snapshot.digest,
          vaultGeneration: request.vaultGeneration,
          seq,
          timestamp: deps.now().toISOString(),
          ...event,
        }),
      );
    };
    const setState = (next: AssistantRunState): void => {
      if (state === next || terminal) return;
      state = next;
      emit({ type: 'state_changed', payload: { state: next } });
    };

    // Stop enters "stopping" at once, in whichever way it arrives.
    const stop = (): void => {
      if (aborted() || terminal) return;
      controller.abort();
      setState('stopping');
    };
    active.set(runId, { owner: row.owner, stop });
    const onDisconnect = (): void => {
      // The client went away: record the cancellation durably and stop. No background continuation.
      void store.requestCancel(runId, row.owner, deps.now()).catch(() => undefined);
      stop();
    };
    if (context.signal.aborted) onDisconnect();
    else context.signal.addEventListener('abort', onDisconnect, { once: true });

    const deadlineTimer = setTimeout(() => {
      flags.deadlineHit = true;
      controller.abort();
    }, deps.budget.totalMs);

    let lastBeat = startedAt.getTime();
    let beating = false;
    const beat = async (): Promise<void> => {
      if (beating || terminal) return;
      beating = true;
      try {
        const result = await store.heartbeat(runId, leaseToken, deps.now(), budget.counters());
        lastBeat = deps.now().getTime();
        if (!result.owned) {
          flags.fenced = true;
          controller.abort();
        } else if (result.cancelRequested) stop();
      } catch {
        // The store is unreachable. Once the lease has certainly lapsed this worker must stop.
        if (deps.now().getTime() - lastBeat > LEASE_MS) {
          flags.fenced = true;
          controller.abort();
        }
      } finally {
        beating = false;
      }
    };
    const heartbeat = setInterval(() => void beat(), deps.heartbeatMs ?? HEARTBEAT_MS);

    const plan = (kind: keyof typeof PLAN_LABELS, current: number, failedAt?: number): void => {
      const steps: AssistantPlan['steps'] = PLAN_LABELS[kind].map((label, index) => ({
        stepId: `step-${index + 1}`,
        label,
        status:
          failedAt === index
            ? 'failed'
            : index < current
              ? 'completed'
              : index === current
                ? 'running'
                : 'pending',
      }));
      emit({
        type: 'plan_updated',
        payload: { plan: { schema: 'lexaegis.assistant-plan.v1', steps } },
      });
    };

    /** One provider attempt. Every guard is re-checked here, immediately before dispatch. */
    const dispatch = async (
      built: Pick<ProviderRequest, 'purpose' | 'messages' | 'tools' | 'responseFormat'>,
    ): Promise<Extract<ProviderResult, { ok: true }>> => {
      if (aborted()) throw new Stop();
      if (!(await context.sessionValid().catch(() => false))) throw new Failure('SESSION_INVALID');
      await beat();
      const current = scopeOf(provider);
      const consented = request.consent.providerScope;
      if (
        current.provider !== consented.provider ||
        current.model !== consented.model ||
        current.region !== consented.region
      )
        throw new Failure('STALE_SNAPSHOT');
      const reservation = budget.reserve(built);
      if (!reservation.ok) {
        throw new Failure(
          reservation.reason === 'DEADLINE' ? 'DEADLINE_EXCEEDED' : 'BUDGET_EXHAUSTED',
        );
      }
      // Checked synchronously with the dispatch below: nothing is sent after a stop was observed.
      if (aborted()) throw new Stop();
      const result = await provider.complete({
        ...built,
        // A snapshot: the transcript keeps growing after this attempt.
        messages: [...built.messages],
        maxCompletionTokens: reservation.maxCompletionTokens,
        timeoutMs: reservation.timeoutMs,
        signal: controller.signal,
      });
      budget.settle(reservation, result);
      if (result.requestId !== null && requestIds.length < 6)
        requestIds.push(result.requestId.slice(0, 128));
      // Output that arrives after a stop is discarded, whatever it contains.
      if (aborted()) throw new Stop();
      if (!result.ok) {
        if (result.failure === 'aborted') throw new Stop();
        // One transient retry per run. The first attempt stays charged: it may have been billed.
        if (RETRYABLE_FAILURES.includes(result.failure) && budget.takeRetry())
          return dispatch(built);
        throw new Failure(PROVIDER_FAILURES[result.failure]);
      }
      returnedModel = result.returnedModel ?? returnedModel;
      // A cut-off answer is not a completed analysis.
      if (result.finishReason === 'length') throw new Failure('OUTPUT_TRUNCATED');
      return result;
    };

    const baseConfig = (outcome: RunOutcome, finishedAt: Date): AgentConfigV1 => {
      const counters = budget.counters();
      const modelRan = counters.providerAttempts > 0;
      const snapshot = returnedModel !== null && /-\d{4}(?:-\d{2}-\d{2})?$/.test(returnedModel);
      return {
        schema: 'lexaegis.agent-config.v1',
        profile: { ...REVIEW_PROFILE },
        runtimeVersion: RUNTIME_VERSION,
        modelExecution: modelRan ? provider.descriptor.id : 'none',
        provider: modelRan
          ? {
              id: provider.descriptor.id,
              region: provider.descriptor.region,
              requestedModel: provider.descriptor.model,
              returnedModel,
              modelSnapshot: {
                status: snapshot ? 'known' : 'unknown',
                id: snapshot ? returnedModel : null,
              },
              outputMode: provider.descriptor.outputMode,
              capability: {
                state: run.capability.state,
                checkedAt: run.capability.record?.checkedAt ?? null,
              },
              requestIds,
            }
          : null,
        prompts: modelRan ? promptManifestRef(intent, [...toolsOffered]) : null,
        parameters: modelRan
          ? {
              enableThinking: false,
              parallelToolCalls: false,
              enableSearch: false,
              stream: false,
              temperature: '0',
            }
          : null,
        budget: deps.budget,
        usage: usageOf(counters),
        run: {
          runId,
          intent,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          outcome,
        },
      };
    };

    /** The identity comes only from verified operator configuration in `deps`; never from this run. */
    const agentConfig = (outcome: RunOutcome, finishedAt: Date): AgentConfig => {
      const config = baseConfig(outcome, finishedAt);
      if (deps.agentIdentity === undefined) return config;
      const { schema: _schema, ...rest } = config;
      return { ...rest, schema: 'lexaegis.agent-config.v2', agentIdentity: deps.agentIdentity };
    };

    /** The single terminal transition and its one terminal event. */
    const finish = async (
      desired: { state: TerminalState; outcome: RunOutcome },
      build: (
        metadata: AgentRunMetadataV1,
        finishedAt: Date,
      ) => { type: AssistantEvent['type']; payload: unknown } | null,
    ): Promise<void> => {
      if (terminal) return;
      const finishedAt = deps.now();
      const final: RunRow | null = flags.fenced
        ? null
        : await store
            .finish(runId, leaseToken, desired, budget.counters(), finishedAt)
            .catch(() => null);
      if (final === null) {
        // The lease is gone or the store is unreachable: the run is interrupted and the provider
        // outcome is unknown. This worker dispatches nothing further and claims no result.
        const current = await store.get(runId, row.owner).catch(() => null);
        const metadata = toRunMetadata(
          current ?? {
            ...row,
            ...budget.counters(),
            state: 'interrupted',
            outcome: 'interrupted',
            updatedAt: finishedAt,
          },
        );
        emit({
          type: 'run_interrupted',
          payload: { metadata: { ...metadata, state: 'interrupted', outcome: 'interrupted' } },
        });
      } else if (final.state === 'cancelled') {
        // Cancellation won, even if an answer had just been validated: the late output is discarded.
        emit({ type: 'run_cancelled', payload: { metadata: toRunMetadata(final) } });
      } else {
        const event = build(toRunMetadata(final), finishedAt);
        if (event !== null) emit(event);
      }
      terminal = true;
      channel.close();
    };

    const complete = async (response: AssistantResponse): Promise<void> => {
      const outcome = response.outcome;
      await finish(
        { state: outcome === 'needs_input' ? 'awaiting_input' : 'completed', outcome },
        (metadata, finishedAt) => {
          // Blocks are published only now: validated, and with the terminal state already decided.
          response.blocks.forEach((block, index) =>
            emit({ type: 'response_delta', payload: { index, block } }),
          );
          const {
            blocks,
            schema: _schema,
            runId: _runId,
            snapshotDigest: _digest,
            vaultGeneration: _generation,
            ...summary
          } = response;
          emit({
            type: 'response_completed',
            payload: { summary: { ...summary, blockCount: blocks.length } },
          });
          emit({ type: 'output_reference', payload: { outputId: runId, kind: 'response' } });
          state = metadata.state;
          emit({ type: 'state_changed', payload: { state: metadata.state } });
          return {
            type: 'run_completed',
            payload: { outcome, metadata, agentConfig: agentConfig(outcome, finishedAt) },
          };
        },
      );
    };

    const codeResponse = (
      outcome: AssistantResponse['outcome'],
      parts: {
        blocks?: AnswerBlock[];
        unresolved?: UnresolvedItem[];
        questions?: string[];
        scopeLimitations?: string[];
      },
    ): AssistantResponse =>
      assistantResponseSchema.parse({
        schema: 'lexaegis.assistant-response.v1',
        runId,
        intent,
        outcome,
        modelExecution: budget.counters().providerAttempts > 0 ? provider.descriptor.id : 'none',
        blocks: parts.blocks ?? [],
        factProposals: [],
        unresolved: parts.unresolved ?? [],
        questions: parts.questions ?? [],
        scopeLimitations: parts.scopeLimitations ?? [],
        nextActions: [],
        snapshotDigest: request.snapshot.digest,
        vaultGeneration: request.vaultGeneration,
      });

    let toolRunner: ToolRunner | null = null;
    try {
      if (!(await store.begin(runId, leaseToken, deps.now()))) throw new Stop();
      if (aborted()) throw new Stop();
      setState('running');

      // ---- Intent -------------------------------------------------------------------------------
      let selection: IntentSelectionV1;
      const routed = routeRequest(request, deps.flags);
      if (routed.kind === 'decided') selection = routed.selection;
      else {
        // The one bounded selection completion: utterance only, same budget as everything else.
        const round = routerRound(provider.descriptor.outputMode, request.utterance);
        const result = await dispatch({
          purpose: 'route',
          messages: round.messages,
          responseFormat: round.format,
        });
        selection = parseIntentSelection(result.content, deps.flags).selection;
      }
      intent = selection.intent;
      if (intent === null) {
        await complete(
          selection.disposition === 'clarify'
            ? codeResponse('needs_input', { questions: [CLARIFY_QUESTION] })
            : codeResponse('limited_scope', {
                unresolved: [{ code: 'OUT_OF_SCOPE', text: OUT_OF_SCOPE_TEXT }],
              }),
        );
        return;
      }

      const rulePack = await loadPack();
      if (rulePack === null) throw new Failure('INTERNAL');
      toolRunner = new ToolRunner({
        ownerId: row.owner,
        runId,
        intent,
        matterId: request.matterId,
        snapshotDigest: request.snapshot.digest,
        context: request.context,
        rulePack,
        clientObserved: request.clientObserved,
        status: deps.status,
        provider: { id: provider.descriptor.id, capability: run.capability.state },
        newId: deps.newId,
      });
      const tools = toolRunner;

      const runTool = async (name: AssistantToolName, args: unknown) => {
        if (!budget.takeTool()) throw new Failure('TOOL_LIMIT');
        const executed = await tools.execute(
          { name, arguments: JSON.stringify(args) },
          controller.signal,
        );
        if (executed.kind === 'cancelled') throw new Stop();
        if (executed.kind === 'rejected') throw new Failure('INTERNAL');
        emit({
          type: 'tool_started',
          payload: { toolCallId: executed.result.toolCallId, toolName: name },
        });
        emit({ type: 'tool_result', payload: { result: executed.result } });
        return executed.result;
      };

      // ---- Direct code handlers: no model interpretation is needed --------------------------------
      const direct =
        intent === 'status' ||
        (request.trigger === 'command' &&
          (intent === 'check_payments' || intent === 'missing_evidence'));
      if (direct) {
        plan('direct', 1);
        const blocks: AnswerBlock[] = [];
        const unresolved: UnresolvedItem[] = [];
        if (intent === 'status') {
          const result = await runTool('get_status', { scope: 'matter' });
          blocks.push({ kind: 'status', tool: result.handle, comment: '' });
        } else if (intent === 'check_payments') {
          const groups = paymentGroups(request.context.facts);
          for (const groupId of (groups.length === 0 ? ['settlement'] : groups).slice(0, 4)) {
            const result = await runTool('check_payments', { groupId });
            blocks.push({ kind: 'calculation', tool: result.handle, comment: '' });
            const outcome =
              result.output?.tool === 'check_payments' ? result.output.result.outcome : null;
            if (outcome === 'needs_input' || outcome === 'not_comparable')
              unresolved.push({
                code: 'MISSING_INPUT',
                text: `Payment inputs for "${groupId}" are incomplete or not comparable.`,
              });
          }
        } else {
          const result = await runTool('check_evidence', { ruleIds: [] });
          const items = result.output?.tool === 'check_evidence' ? result.output.items : [];
          const open = items.filter(
            (item) => item.state !== 'confirmed_for_check' && item.state !== 'not_applicable',
          );
          blocks.push({
            kind: 'finding',
            text:
              open.length === 0
                ? 'Every checklist requirement has evidence linked by you or is marked not applicable.'
                : `Not yet linked or confirmed by you: ${open.map((item) => `${item.requirement} (${item.state.replaceAll('_', ' ')})`).join('; ')}.`.slice(
                    0,
                    2000,
                  ),
            basis: 'supported',
            sources: [],
            rules: open.map((item) => item.ruleId).slice(0, 8),
            tools: [result.handle],
          });
        }
        plan('direct', 2);
        await complete(
          codeResponse(unresolved.length > 0 ? 'needs_input' : 'completed', {
            blocks,
            unresolved,
            scopeLimitations:
              intent === 'missing_evidence'
                ? ['Evidence state reflects only the links you made for the selected documents.']
                : [],
          }),
        );
        return;
      }

      // ---- Model-assisted: tool rounds, then one structured final round ---------------------------
      plan('model', 1);
      const offered = toolsForIntent(intent);
      for (const name of offered) toolsOffered.add(name);
      const providerTools = offered.map(providerTool);
      const messages: ChatMessage[] = initialMessages(intent, request);

      while (budget.canStartToolRound()) {
        const result = await dispatch({ purpose: 'tool_round', messages, tools: providerTools });
        if (result.toolCalls.length === 0) {
          messages.push({ role: 'assistant', content: result.content ?? 'DONE', toolCalls: [] });
          break;
        }
        const [call] = result.toolCalls;
        const authorised =
          result.toolCalls.length === 1 && call !== undefined
            ? tools.authorise(call)
            : // Parallel calls are never executed, not even the first of them.
              ({ ok: false, codes: ['PARALLEL_TOOL_CALLS'] } as const);
        if (!authorised.ok || call === undefined) {
          // One repair for a malformed or unauthorised call, charged to the normal limits.
          if (!budget.takeRepair()) {
            throw new Failure(
              result.toolCalls.length > 1 ? 'PARALLEL_TOOL_CALLS' : 'OUTPUT_MALFORMED',
            );
          }
          messages.push(
            { role: 'assistant', content: result.content ?? '', toolCalls: [] },
            { role: 'user', content: toolRepairInstruction(authorised.ok ? [] : authorised.codes) },
          );
          continue;
        }
        const known = tools.results.length;
        const executed = await tools.execute(call, controller.signal);
        if (executed.kind === 'cancelled') throw new Stop();
        if (executed.kind === 'rejected') throw new Failure('INTERNAL');
        if (!executed.cached) {
          // Counted after the fact so an identical cached call costs nothing; the ceiling still holds
          // because a ninth distinct execution is refused before its result is used.
          if (!budget.takeTool()) throw new Failure('TOOL_LIMIT');
          if (tools.results.length > known) {
            emit({
              type: 'tool_started',
              payload: {
                toolCallId: executed.result.toolCallId,
                toolName: executed.result.toolName,
              },
            });
            emit({ type: 'tool_result', payload: { result: executed.result } });
          }
        }
        // The assistant's call and its matching tool result, in order.
        messages.push(
          { role: 'assistant', content: result.content, toolCalls: [call] },
          { role: 'tool', toolCallId: call.id, content: executed.modelText },
        );
      }

      plan('model', 2);
      const outputContext: OutputContext = {
        runId,
        matterId: request.matterId,
        intent,
        modelExecution: provider.descriptor.id,
        context: request.context,
        rulePack,
        tools,
        snapshotDigest: request.snapshot.digest,
        vaultGeneration: request.vaultGeneration,
        newId: deps.newId,
      };
      const final = finalRound(provider.descriptor.outputMode);
      messages.push({ role: 'user', content: final.instruction });
      const drafted = await dispatch({ purpose: 'final', messages, responseFormat: final.format });
      plan('model', 3);
      let validation = validateModelOutput(drafted.content, outputContext);
      if (!validation.ok) {
        // At most one repair per run, given compact codes only.
        if (!budget.takeRepair()) throw new Failure('OUTPUT_MALFORMED');
        const repair = repairRound(provider.descriptor.outputMode, validation.codes);
        messages.push(
          { role: 'assistant', content: drafted.content ?? '', toolCalls: [] },
          { role: 'user', content: repair.instruction },
        );
        const repaired = await dispatch({
          purpose: 'repair',
          messages,
          responseFormat: repair.format,
        });
        validation = validateModelOutput(repaired.content, outputContext);
        if (!validation.ok) throw new Failure('OUTPUT_MALFORMED');
      }
      await complete(validation.response);
    } catch (thrown) {
      const partial = toolRunner?.results.some((result) => result.outcome === 'succeeded') ?? false;
      if (flags.fenced) {
        await finish({ state: 'interrupted', outcome: 'interrupted' }, () => null);
      } else if (thrown instanceof Stop && !flags.deadlineHit) {
        setState('stopping');
        // Acknowledgement: this worker dispatches nothing further.
        await finish({ state: 'cancelled', outcome: 'cancelled' }, (metadata) => ({
          type: 'run_cancelled',
          payload: { metadata },
        }));
      } else {
        const failure: RunFailureCode = flags.deadlineHit
          ? 'DEADLINE_EXCEEDED'
          : thrown instanceof Failure
            ? thrown.failure
            : 'INTERNAL';
        await finish({ state: 'failed', outcome: 'failed' }, (metadata) => ({
          type: 'run_failed',
          payload: { error: error(failure), failure, partial, metadata },
        }));
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadlineTimer);
      context.signal.removeEventListener('abort', onDisconnect);
      active.delete(runId);
      terminal = true;
      channel.close();
    }
  }

  async function status(runId: string, ownerId: string): Promise<Result<AgentRunMetadataV1>> {
    const now = deps.now();
    await store.sweep(now);
    const row = await store.get(runId, ownerId);
    // Another account's run and a missing run look the same.
    if (row === null) return fail(createApplicationError('NOT_FOUND', 'The run was not found.'));
    return ok(toRunMetadata(row));
  }

  async function cancel(
    input: { runId: string; ownerId: string },
    signal: AbortSignal,
  ): Promise<Result<CancelOutcome>> {
    await store.sweep(deps.now());
    let row = await store.requestCancel(input.runId, input.ownerId, deps.now());
    if (row === null) return fail(createApplicationError('NOT_FOUND', 'The run was not found.'));
    // A run on this process stops immediately; a run on another replica sees the durable flag.
    const local = active.get(input.runId);
    if (local !== undefined && local.owner === input.ownerId) local.stop();
    const waitUntil = Date.now() + (deps.cancelAckWaitMs ?? CANCEL_ACK_WAIT_MS);
    while (isActive(row.state) && Date.now() < waitUntil && !signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      row = (await store.get(input.runId, input.ownerId)) ?? row;
    }
    return ok({
      state: row.state,
      acknowledged: !isActive(row.state),
      metadata: toRunMetadata(row),
    });
  }

  return { availability, start, status, cancel };
}
