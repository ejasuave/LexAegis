import { describe, expect, it } from 'vitest';
import { assistantEventSchema, type AssistantEvent } from '../contracts';
import { agentHarness, answer, collect, started, terminalOf } from '../testing/agent-harness';
import { TEST_IDS, syntheticMatter, syntheticRequest } from '../testing/fixtures';
import {
  createScriptedProvider,
  done,
  failure,
  hangUntilAborted,
  json,
  text,
  toolCall,
} from '../testing/scripted-provider';

const types = (events: readonly AssistantEvent[]) => events.map((event) => event.type);
const last = (events: readonly AssistantEvent[]) => events[events.length - 1];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a model-assisted run', () => {
  it('reads a source through a native tool call and returns a validated, cited answer', async () => {
    const matter = await syntheticMatter();
    const h = agentHarness([
      toolCall('read_sources', { sourceIds: ['S1'] }, 'call_a'),
      done(),
      answer(),
    ]);
    const run = started(await h.start(await syntheticRequest(matter)));
    expect(run.metadata).toMatchObject({ state: 'queued', repeatedAdmission: false });
    const events = await collect(run);

    for (const event of events) expect(assistantEventSchema.safeParse(event).success).toBe(true);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(types(events)).toEqual([
      'state_changed',
      'plan_updated',
      'tool_started',
      'tool_result',
      'plan_updated',
      'plan_updated',
      'response_delta',
      'response_completed',
      'output_reference',
      'state_changed',
      'run_completed',
    ]);
    expect(terminalOf(events)).toHaveLength(1);
    const completed = last(events);
    expect(completed?.type === 'run_completed' && completed.payload).toMatchObject({
      outcome: 'completed',
      metadata: {
        state: 'completed',
        outcome: 'completed',
        usage: { providerAttempts: 3, toolExecutions: 1 },
      },
      agentConfig: {
        modelExecution: 'scripted-test',
        provider: {
          id: 'scripted-test',
          requestedModel: 'qwen3.8-max',
          returnedModel: 'scripted-test-model',
          outputMode: 'json_schema',
        },
        parameters: {
          enableThinking: false,
          parallelToolCalls: false,
          enableSearch: false,
          stream: false,
        },
        run: { intent: 'summarise', outcome: 'completed' },
      },
    });
    // Every event is bound to the run's matter, version, snapshot and vault generation.
    for (const event of events) {
      expect(event).toMatchObject({
        matterId: TEST_IDS.matter,
        documentVersionId: TEST_IDS.version,
        snapshotDigest: matter.snapshotDigest,
        vaultGeneration: 3,
      });
    }

    // Tool rounds carry tools and no response format; the final round the reverse.
    const [first, second, final] = h.provider.requests;
    expect(first?.tools?.map((t) => t.name)).toEqual(['read_sources']);
    expect(first?.responseFormat).toBeUndefined();
    expect(second?.tools?.length).toBe(1);
    expect(final?.tools).toBeUndefined();
    expect(final?.responseFormat).toMatchObject({ mode: 'json_schema', name: 'aegis_answer' });
    // The transcript keeps the assistant call and its matching tool result in order.
    expect(final?.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
    const call = final?.messages[2];
    const result = final?.messages[3];
    expect(call?.role === 'assistant' && call.toolCalls[0]?.id).toBe('call_a');
    expect(result?.role === 'tool' && result.toolCallId).toBe('call_a');
    expect(result?.role === 'tool' && result.content).toContain(matter.refs.total.quote);
    // Nothing private is in the operational row.
    const row = JSON.stringify([...h.store.rows.values()]);
    expect(row).not.toContain(TEST_IDS.matter);
    expect(row).not.toContain(matter.snapshotDigest);
    expect(row).not.toContain('24,000');
  });

  it('shows payment figures from the calculator result, never from model text', async () => {
    const matter = await syntheticMatter();
    const h = agentHarness([
      toolCall('check_payments', { groupId: 'settlement' }),
      done(),
      answer({
        blocks: [
          {
            kind: 'calculation',
            text: 'The instalments are lower than the stated total.',
            basis: 'supported',
            sources: [],
            rules: [],
            tools: ['T1'],
          },
        ],
      }),
    ]);
    const events = await collect(
      started(
        await h.start(
          await syntheticRequest(matter, {
            intent: 'check_payments',
            trigger: 'ui_action',
            utterance: '',
          }),
        ),
      ),
    );
    const tool = events.find((e) => e.type === 'tool_result');
    expect(tool?.type === 'tool_result' && tool.payload.result).toMatchObject({
      handle: 'T1',
      toolName: 'check_payments',
      output: {
        result: {
          statedTotalPence: '2400000',
          comparableSumPence: '2200000',
          differencePence: '200000',
          outcome: 'mismatch',
        },
      },
    });
    const block = events.find((e) => e.type === 'response_delta');
    expect(block?.type === 'response_delta' && block.payload.block).toEqual({
      kind: 'calculation',
      tool: 'T1',
      comment: 'The instalments are lower than the stated total.',
    });
  });

  it('finishes as awaiting input when the answer needs the reviewer, and waits for nothing', async () => {
    const matter = await syntheticMatter();
    const h = agentHarness([
      done(),
      answer({
        outcome: 'needs_input',
        blocks: [],
        factProposals: [
          {
            field: 'employer',
            group: 'settlement',
            slot: 'employer',
            value: 'Northwind Ltd',
            sources: ['S1'],
          },
        ],
        questions: ['Is the employer Northwind Ltd?'],
      }),
    ]);
    const events = await collect(started(await h.start(await syntheticRequest(matter))));
    const completed = last(events);
    expect(completed?.type === 'run_completed' && completed.payload).toMatchObject({
      outcome: 'needs_input',
      metadata: { state: 'awaiting_input' },
    });
    const summary = events.find((e) => e.type === 'response_completed');
    expect(summary?.type === 'response_completed' && summary.payload.summary).toMatchObject({
      factProposals: [{ proposalId: 'P1', value: 'Northwind Ltd' }],
      nextActions: ['confirm_fact'],
    });
    // The run is over: the account can start a new one for its reply.
    expect([...h.store.rows.values()].every((row) => row.state === 'awaiting_input')).toBe(true);
  });

  it('repairs a malformed final answer once, with codes only', async () => {
    const matter = await syntheticMatter();
    const h = agentHarness([
      done(),
      answer({
        blocks: [
          {
            kind: 'explanation',
            text: 'x',
            basis: 'supported',
            sources: ['S9'],
            rules: [],
            tools: [],
          },
        ],
      }),
      answer(),
    ]);
    const events = await collect(started(await h.start(await syntheticRequest(matter))));
    expect(last(events)?.type).toBe('run_completed');
    expect(h.provider.requests).toHaveLength(3);
    const repair = h.provider.requests[2];
    expect(repair?.purpose).toBe('repair');
    const instruction = repair?.messages[repair.messages.length - 1];
    expect(instruction?.role === 'user' && instruction.content).toContain('UNKNOWN_SOURCE_HANDLE');
    expect(instruction?.role === 'user' && instruction.content).not.toContain('CONTEXT');
  });

  it('fails after a second invalid output and keeps validated tool results as partial work', async () => {
    const matter = await syntheticMatter();
    const h = agentHarness([
      toolCall('read_sources', { sourceIds: ['S1'] }),
      done(),
      text('Here is my answer in prose.'),
      text('{"outcome":"answer"}'),
      answer(),
    ]);
    const events = await collect(started(await h.start(await syntheticRequest(matter))));
    const failed = last(events);
    expect(failed?.type === 'run_failed' && failed.payload).toMatchObject({
      failure: 'OUTPUT_MALFORMED',
      partial: true,
      metadata: { state: 'failed', outcome: 'failed' },
    });
    expect(types(events)).toContain('tool_result');
    expect(types(events)).not.toContain('response_delta');
    expect(h.provider.requests).toHaveLength(4);
  });

  it('treats a length-truncated answer as a failure, not a completed analysis', async () => {
    const matter = await syntheticMatter();
    const h = agentHarness([done(), json({ outcome: 'answer' }, { finishReason: 'length' })]);
    const events = await collect(started(await h.start(await syntheticRequest(matter))));
    expect(last(events)).toMatchObject({
      type: 'run_failed',
      payload: { failure: 'OUTPUT_TRUNCATED' },
    });
    expect(types(events)).not.toContain('response_delta');
  });

  it('never executes parallel tool calls, an unknown tool or one outside the intent', async () => {
    const matter = await syntheticMatter();
    const parallel = {
      ...toolCall('read_sources', { sourceIds: ['S1'] }),
      toolCalls: [
        { id: 'a', name: 'read_sources', arguments: '{"sourceIds":["S1"]}' },
        { id: 'b', name: 'read_sources', arguments: '{"sourceIds":["S2"]}' },
      ],
    };
    const h = agentHarness([
      parallel,
      toolCall('read_sources', { sourceIds: ['S1'] }),
      done(),
      answer(),
    ]);
    const events = await collect(started(await h.start(await syntheticRequest(matter))));
    expect(types(events).filter((t) => t === 'tool_result')).toHaveLength(1);
    const instruction = h.provider.requests[1]?.messages.at(-1);
    expect(instruction?.role === 'user' && instruction.content).toContain('PARALLEL_TOOL_CALLS');
    expect(last(events)?.type).toBe('run_completed');

    for (const bad of [
      toolCall('sign_package', {}),
      toolCall('check_payments', { groupId: 'settlement' }),
    ]) {
      const g = agentHarness([bad, bad, answer()]);
      const out = await collect(started(await g.start(await syntheticRequest(matter))));
      // One repair is allowed; the second rejection ends the run. Nothing was executed.
      expect(last(out)).toMatchObject({
        type: 'run_failed',
        payload: { failure: 'OUTPUT_MALFORMED', partial: false },
      });
      expect(types(out)).not.toContain('tool_started');
    }
  });

  it('keeps an attempt for the final answer instead of spending the budget on tools', async () => {
    const matter = await syntheticMatter();
    const calls = ['S1', 'S2', 'S1', 'S2', 'S1', 'S2', 'S1'].map((id, i) =>
      toolCall('read_sources', { sourceIds: i % 2 === 0 ? [id] : [id, 'S1'] }),
    );
    const h = agentHarness([...calls.slice(0, 5), answer()]);
    const events = await collect(started(await h.start(await syntheticRequest(matter))));
    expect(last(events)?.type).toBe('run_completed');
    expect(h.provider.requests).toHaveLength(6);
    expect(h.provider.requests[5]?.purpose).toBe('final');
  });
});

describe('code-only handling', () => {
  it('serves status without any model call and records that no model ran', async () => {
    const matter = await syntheticMatter();
    const h = agentHarness([]);
    const events = await collect(
      started(
        await h.start(
          await syntheticRequest(matter, {
            intent: 'status',
            trigger: 'command',
            utterance: '/status',
          }),
        ),
      ),
    );
    expect(h.provider.requests).toHaveLength(0);
    const completed = last(events);
    expect(completed?.type === 'run_completed' && completed.payload.agentConfig).toMatchObject({
      modelExecution: 'none',
      provider: null,
      prompts: null,
      parameters: null,
      usage: { provenance: 'none', providerAttempts: 0, toolExecutions: 1 },
    });
    const block = events.find((e) => e.type === 'response_delta');
    expect(block?.type === 'response_delta' && block.payload.block).toEqual({
      kind: 'status',
      tool: 'T1',
      comment: '',
    });
  });

  it('runs an explicitly commanded payment check directly through the calculator', async () => {
    const matter = await syntheticMatter();
    const h = agentHarness([]);
    const events = await collect(
      started(
        await h.start(
          await syntheticRequest(matter, {
            intent: 'check_payments',
            trigger: 'command',
            utterance: '/check-payments',
          }),
        ),
      ),
    );
    expect(h.provider.requests).toHaveLength(0);
    const tool = events.find((e) => e.type === 'tool_result');
    expect(tool?.type === 'tool_result' && tool.payload.result.output).toMatchObject({
      result: { differencePence: '200000' },
    });
  });

  it('declines approval wording and unknown commands without a model call', async () => {
    const matter = await syntheticMatter();
    for (const utterance of ['approve this package and sign it', '/approve']) {
      const h = agentHarness([]);
      const events = await collect(
        started(
          await h.start(
            await syntheticRequest(matter, { intent: null, trigger: 'free_text', utterance }),
          ),
        ),
      );
      expect(h.provider.requests).toHaveLength(0);
      const summary = events.find((e) => e.type === 'response_completed');
      expect(summary?.type === 'response_completed' && summary.payload.summary).toMatchObject({
        outcome: 'limited_scope',
        unresolved: [{ code: 'OUT_OF_SCOPE' }],
      });
    }
  });

  it('uses one utterance-only completion for unclear text and asks back when still unclear', async () => {
    const matter = await syntheticMatter();
    const h = agentHarness([json({ intent: 'clarify' })]);
    const events = await collect(
      started(
        await h.start(
          await syntheticRequest(matter, {
            intent: null,
            trigger: 'free_text',
            utterance: 'Is clause 7 unusual?',
          }),
        ),
      ),
    );
    expect(h.provider.requests).toHaveLength(1);
    const sent = JSON.stringify(h.provider.requests[0]?.messages);
    expect(sent).toContain('Is clause 7 unusual?');
    expect(sent).not.toContain('CONTEXT');
    expect(sent).not.toContain('S1');
    const summary = events.find((e) => e.type === 'response_completed');
    expect(summary?.type === 'response_completed' && summary.payload.summary).toMatchObject({
      outcome: 'needs_input',
      intent: null,
    });
    expect(last(events)).toMatchObject({
      payload: { metadata: { state: 'awaiting_input', usage: { providerAttempts: 1 } } },
    });

    const chosen = agentHarness([json({ intent: 'explain' }), done(), answer()]);
    const out = await collect(
      started(
        await chosen.start(
          await syntheticRequest(matter, {
            intent: null,
            trigger: 'free_text',
            utterance: 'Is clause 7 unusual?',
          }),
        ),
      ),
    );
    expect(last(out)).toMatchObject({
      type: 'run_completed',
      payload: { agentConfig: { run: { intent: 'explain' } } },
    });
    expect(chosen.provider.requests[1]?.tools?.map((t) => t.name)).toEqual([
      'read_sources',
      'get_rules',
    ]);
  });
});

describe('admission and consent', () => {
  it('refuses to start without a provider, or on an unverified configuration', async () => {
    const matter = await syntheticMatter();
    const request = await syntheticRequest(matter);
    const none = agentHarness([], { provider: null });
    const missing = await none.start(request);
    expect(!missing.ok && missing.error.code).toBe('NOT_CONFIGURED');
    expect((await none.agent.availability()).state).toBe('not_configured');

    const qwenScope = { provider: 'qwen' as const, model: 'qwen3.8-max', region: 'ap-southeast-1' };
    const qwen = createScriptedProvider([done(), answer()], {
      id: 'qwen',
      region: 'ap-southeast-1',
      fingerprint: `0x${'9a'.repeat(32)}`,
    });
    const unverified = agentHarness([], { provider: qwen });
    expect((await unverified.agent.availability()).state).toBe('configured_unverified');
    const refused = await unverified.start(
      await syntheticRequest(matter, { providerScope: qwenScope }),
    );
    expect(!refused.ok && refused.error.message).toBe(
      'The assistant configuration has not been verified.',
    );
    expect(qwen.requests).toHaveLength(0);
    expect(unverified.store.rows.size).toBe(0);

    await unverified.store.saveCapability({
      schema: 'lexaegis.assistant-capability.v1',
      fingerprint: qwen.descriptor.fingerprint,
      provider: 'qwen',
      model: 'qwen3.8-max',
      region: 'ap-southeast-1',
      outputMode: 'json_schema',
      nativeToolCalls: true,
      structuredOutput: true,
      usageReported: true,
      cancellation: true,
      returnedModel: 'qwen3.8-max-0902',
      requestIds: [],
      failures: [],
      checkedAt: '2026-10-10T08:00:00.000Z',
      verified: true,
    });
    expect((await unverified.agent.availability()).state).toBe('verified');
    const ok = await unverified.start(await syntheticRequest(matter, { providerScope: qwenScope }));
    expect(ok.ok).toBe(true);
    const events = await collect(started(ok));
    expect(last(events)).toMatchObject({
      type: 'run_completed',
      payload: {
        agentConfig: {
          provider: { capability: { state: 'verified', checkedAt: '2026-10-10T08:00:00.000Z' } },
        },
      },
    });
  });

  it('rejects a request whose consent does not cover its exact content or provider', async () => {
    const matter = await syntheticMatter();
    const request = await syntheticRequest(matter);
    const h = agentHarness([done(), answer()]);
    for (const tampered of [
      { ...request, utterance: '/summarise everything else too' },
      { ...request, vaultGeneration: 4 },
      { ...request, history: [{ role: 'user' as const, text: 'added later' }] },
      {
        ...request,
        consent: {
          ...request.consent,
          providerScope: { ...request.consent.providerScope, region: 'ap-southeast-1' },
        },
      },
      { ...request, consent: { ...request.consent, consentedAt: '2026-10-10T08:00:00.000Z' } },
    ]) {
      const result = await h.start(tampered);
      expect(!result.ok && result.error).toMatchObject({
        code: 'INVALID_INPUT',
        message: 'The disclosure consent does not match this request.',
      });
    }
    expect(h.provider.requests).toHaveLength(0);
    expect(h.store.rows.size).toBe(0);
  });

  it('returns the existing run for a repeated request ID and runs nothing again', async () => {
    const matter = await syntheticMatter();
    const request = await syntheticRequest(matter);
    const h = agentHarness([done(), answer()]);
    const first = started(await h.start(request));
    await collect(first);
    const again = started(await h.start(request));
    expect(again.events).toBeNull();
    expect(again.metadata).toMatchObject({
      runId: first.metadata.runId,
      repeatedAdmission: true,
      state: 'completed',
    });
    expect(h.provider.requests).toHaveLength(2);
  });

  it('allows one active run per account and reports the limit without starting inference', async () => {
    const matter = await syntheticMatter();
    const h = agentHarness([hangUntilAborted]);
    const first = started(await h.start(await syntheticRequest(matter)));
    const second = await h.start(
      await syntheticRequest(matter, { clientRequestId: '88888888-8888-4888-8888-888888888888' }),
    );
    expect(!second.ok && second.error).toMatchObject({ code: 'RATE_LIMITED' });
    await h.agent.cancel(
      { runId: first.metadata.runId, ownerId: TEST_IDS.reviewer },
      new AbortController().signal,
    );
    await collect(first);
    expect(h.provider.requests).toHaveLength(1);
  });
});

describe('cancellation', () => {
  it('stops during a provider wait, acknowledges, and dispatches nothing afterwards', async () => {
    const matter = await syntheticMatter();
    const h = agentHarness([hangUntilAborted, answer(), answer()]);
    const run = started(await h.start(await syntheticRequest(matter)));
    const seen: AssistantEvent[] = [];
    const reading = (async () => {
      for await (const event of run.events ?? []) seen.push(event);
    })();
    await wait(30);
    const cancelled = await h.agent.cancel(
      { runId: run.metadata.runId, ownerId: TEST_IDS.reviewer },
      new AbortController().signal,
    );
    expect(cancelled.ok && cancelled.data).toMatchObject({
      state: 'cancelled',
      acknowledged: true,
    });
    await reading;
    expect(types(seen).slice(-2)).toEqual(['state_changed', 'run_cancelled']);
    expect(seen.at(-2)).toMatchObject({ payload: { state: 'stopping' } });
    expect(terminalOf(seen)).toHaveLength(1);
    await wait(30);
    expect(h.provider.requests).toHaveLength(1);
    expect(h.provider.answered()).toBe(0);
    // Repeated Stop is idempotent and reports the same terminal state.
    const again = await h.agent.cancel(
      { runId: run.metadata.runId, ownerId: TEST_IDS.reviewer },
      new AbortController().signal,
    );
    expect(again.ok && again.data.state).toBe('cancelled');
  });

  it('binds cancellation and status to the owner', async () => {
    const matter = await syntheticMatter();
    const h = agentHarness([hangUntilAborted]);
    const run = started(await h.start(await syntheticRequest(matter)));
    const signal = new AbortController().signal;
    const other = await h.agent.cancel(
      { runId: run.metadata.runId, ownerId: TEST_IDS.otherReviewer },
      signal,
    );
    expect(!other.ok && other.error.code).toBe('NOT_FOUND');
    const peek = await h.agent.status(run.metadata.runId, TEST_IDS.otherReviewer);
    expect(!peek.ok && peek.error.code).toBe('NOT_FOUND');
    const unknown = await h.agent.status('00000000-0000-4000-8000-000000000000', TEST_IDS.reviewer);
    expect(!unknown.ok && unknown.error).toMatchObject(
      !peek.ok ? { code: peek.error.code, message: peek.error.message } : {},
    );
    const mine = await h.agent.status(run.metadata.runId, TEST_IDS.reviewer);
    expect(mine.ok && mine.data.state).toBe('running');
    expect(JSON.stringify(mine)).not.toContain(TEST_IDS.matter);
    await h.agent.cancel({ runId: run.metadata.runId, ownerId: TEST_IDS.reviewer }, signal);
    await collect(run);
  });

  it('a cancellation recorded by another replica is picked up through the durable flag', async () => {
    const matter = await syntheticMatter();
    const h = agentHarness([hangUntilAborted, answer()]);
    const run = started(await h.start(await syntheticRequest(matter)));
    await wait(20);
    // Written straight to the store, as a different process would: no in-process abort handle.
    await h.store.requestCancel(run.metadata.runId, TEST_IDS.reviewer, h.now());
    const events = await collect(run);
    expect(last(events)).toMatchObject({
      type: 'run_cancelled',
      payload: { metadata: { state: 'cancelled' } },
    });
    expect(h.provider.requests).toHaveLength(1);
  });

  it('gives exactly one terminal outcome when completion and cancellation coincide', async () => {
    const matter = await syntheticMatter();
    let runId = '';
    const h = agentHarness([
      done(),
      async () => {
        // The cancel lands while the final answer is being produced.
        await h.store.requestCancel(runId, TEST_IDS.reviewer, h.now());
        const step = answer();
        return typeof step === 'function' ? failure('malformed_output') : step;
      },
    ]);
    const run = started(await h.start(await syntheticRequest(matter)));
    runId = run.metadata.runId;
    const events = await collect(run);
    expect(terminalOf(events)).toHaveLength(1);
    expect(last(events)?.type).toBe('run_cancelled');
    // The validated answer arrived too late and was discarded.
    expect(types(events)).not.toContain('response_delta');
    expect((await h.store.get(runId, TEST_IDS.reviewer))?.state).toBe('cancelled');
  });

  it('cancels on client disconnect and continues nothing in the background', async () => {
    const matter = await syntheticMatter();
    const h = agentHarness([hangUntilAborted, answer()]);
    const run = started(await h.start(await syntheticRequest(matter)));
    await wait(20);
    h.connection.abort();
    const events = await collect(run);
    expect(last(events)?.type).toBe('run_cancelled');
    await wait(30);
    expect(h.provider.requests).toHaveLength(1);
    expect((await h.store.get(run.metadata.runId, TEST_IDS.reviewer))?.state).toBe('cancelled');
  });

  it('stops before dispatch when the session is no longer valid', async () => {
    const matter = await syntheticMatter();
    const h = agentHarness([done(), answer()]);
    h.session.valid = false;
    const events = await collect(started(await h.start(await syntheticRequest(matter))));
    expect(last(events)).toMatchObject({
      type: 'run_failed',
      payload: { failure: 'SESSION_INVALID' },
    });
    expect(h.provider.requests).toHaveLength(0);
  });

  it('becomes interrupted, with no result claimed, when the worker loses its lease', async () => {
    const matter = await syntheticMatter();
    const h = agentHarness([hangUntilAborted, answer()]);
    const run = started(await h.start(await syntheticRequest(matter)));
    await wait(20);
    // The lease lapses and another process sweeps it: this worker is fenced.
    await h.store.sweep(new Date(h.now().getTime() + 60_000));
    const events = await collect(run);
    expect(last(events)).toMatchObject({
      type: 'run_interrupted',
      payload: { metadata: { state: 'interrupted', outcome: 'interrupted' } },
    });
    expect(types(events)).not.toContain('run_completed');
    const status = await h.agent.status(run.metadata.runId, TEST_IDS.reviewer);
    expect(status.ok && status.data.state).toBe('interrupted');
    await wait(30);
    expect(h.provider.requests).toHaveLength(1);
  });
});

describe('provider failures', () => {
  it('retries one transient failure and accounts for both attempts', async () => {
    const matter = await syntheticMatter();
    const h = agentHarness([failure('timeout'), done(), answer()]);
    const events = await collect(started(await h.start(await syntheticRequest(matter))));
    expect(last(events)).toMatchObject({
      type: 'run_completed',
      payload: { metadata: { usage: { providerAttempts: 3, provenance: 'partially_reported' } } },
    });
    const twice = agentHarness([failure('transport'), failure('transport'), answer()]);
    const out = await collect(started(await twice.start(await syntheticRequest(matter))));
    expect(last(out)).toMatchObject({
      type: 'run_failed',
      payload: { failure: 'PROVIDER_TRANSPORT' },
    });
    expect(twice.provider.requests).toHaveLength(2);
  });

  it('does not retry authentication, capability or refusal failures, and never switches provider', async () => {
    const matter = await syntheticMatter();
    for (const [kind, code] of [
      ['authentication', 'PROVIDER_AUTHENTICATION'],
      ['capability', 'PROVIDER_CAPABILITY'],
      ['refusal', 'PROVIDER_REFUSAL'],
    ] as const) {
      const h = agentHarness([failure(kind), answer()]);
      const events = await collect(started(await h.start(await syntheticRequest(matter))));
      const failed = last(events);
      expect(failed).toMatchObject({ type: 'run_failed', payload: { failure: code } });
      expect(h.provider.requests).toHaveLength(1);
      expect(failed?.type === 'run_failed' && failed.payload.error.message).not.toMatch(
        /http|key|aliyun/i,
      );
    }
    const limited = agentHarness([failure('rate_limit'), failure('rate_limit')]);
    const out = await collect(started(await limited.start(await syntheticRequest(matter))));
    expect(last(out)).toMatchObject({
      type: 'run_failed',
      payload: { failure: 'PROVIDER_RATE_LIMITED' },
    });
  });
});
