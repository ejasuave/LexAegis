import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_ADMISSION,
  DEFAULT_BUDGET,
  createQwenProvider,
  createReviewAgent,
  validateTestBaseUrl,
} from '@lexaegis/agent';
import type { AssistantEvent } from '@lexaegis/agent/contracts';
import {
  TEST_IDS,
  createMemoryRunStore,
  syntheticMatter,
  syntheticRequest,
} from '@lexaegis/agent/testing';
import {
  startScriptedQwenServer,
  type ScriptedQwenServer,
} from '@/test-support/scripted-qwen-server';

/*
 * The real HTTP adapter and the real runtime against the loopback scripted provider: the same
 * path the browser check uses. Wire-format compatibility only; no model and no paid inference.
 */

let server: ScriptedQwenServer;
beforeAll(async () => {
  server = await startScriptedQwenServer();
});
afterAll(async () => {
  await server.stop();
});

function agent() {
  const endpoint = validateTestBaseUrl(server.baseUrl);
  if (!endpoint.ok) throw new Error(endpoint.reason);
  const started = Date.now();
  const store = createMemoryRunStore();
  return {
    store,
    agent: createReviewAgent({
      provider: createQwenProvider({
        id: 'scripted-test',
        apiKey: 'scripted-test-no-key',
        endpoint,
        model: 'qwen3.8-max',
        outputMode: 'json_schema',
      }),
      store,
      status: { liveChain: () => Promise.resolve('not_configured') },
      budget: DEFAULT_BUDGET,
      admission: DEFAULT_ADMISSION,
      flags: { briefingEnabled: true },
      notices: [],
      now: () => new Date(Date.parse('2026-10-10T09:05:10.000Z') + (Date.now() - started)),
      newId: () => crypto.randomUUID(),
      heartbeatMs: 10,
      cancelAckWaitMs: 500,
    }),
  };
}

const scope = { provider: 'scripted-test' as const, model: 'qwen3.8-max', region: 'test-loopback' };
const context = (signal = new AbortController().signal) => ({
  ownerId: TEST_IDS.reviewer,
  signal,
  sessionValid: () => Promise.resolve(true),
});

async function run(overrides: Parameters<typeof syntheticRequest>[1]) {
  const matter = await syntheticMatter();
  const { agent: a } = agent();
  const before = server.requests.length;
  const started = await a.start(
    await syntheticRequest(matter, { providerScope: scope, ...overrides }),
    context(),
  );
  if (!started.ok) throw new Error(started.error.code);
  const events: AssistantEvent[] = [];
  for await (const event of started.data.events ?? []) events.push(event);
  return { events, sent: server.requests.slice(before), matter };
}

describe('runtime over the loopback scripted provider', () => {
  it('completes an explanation with a native tool call and a cited, validated answer', async () => {
    const { events, sent, matter } = await run({
      intent: 'explain',
      trigger: 'ui_action',
      utterance: '',
    });
    expect(events.at(-1)?.type).toBe('run_completed');
    const tool = events.find((e) => e.type === 'tool_result');
    expect(tool?.type === 'tool_result' && tool.payload.result).toMatchObject({
      toolName: 'read_sources',
      outcome: 'succeeded',
    });
    expect(
      events.flatMap((e) => (e.type === 'response_delta' ? [e.payload.block.kind] : [])),
    ).toEqual(['quotation', 'explanation']);
    // What reached the provider: fixed parameters, tools on tool rounds only, a strict schema last.
    for (const body of sent) {
      expect(body).toMatchObject({
        model: 'qwen3.8-max',
        stream: false,
        enable_thinking: false,
        enable_search: false,
      });
    }
    expect(sent[0]?.tools?.map((t) => t.function.name)).toEqual(['read_sources', 'get_rules']);
    expect(sent[0]?.parallel_tool_calls).toBe(false);
    expect(sent.at(-1)?.tools).toBeUndefined();
    expect(sent.at(-1)?.response_format?.type).toBe('json_schema');
    // The excerpt reached the provider only as the result of the read_sources call.
    expect(JSON.stringify(sent[0])).not.toContain(matter.refs.total.quote);
    expect(JSON.stringify(sent[1])).toContain(matter.refs.total.quote);
    // No private identifier is sent at all.
    const all = JSON.stringify(sent);
    for (const secret of [
      TEST_IDS.matter,
      TEST_IDS.version,
      TEST_IDS.reviewer,
      matter.snapshotDigest,
    ]) {
      expect(all).not.toContain(secret);
    }
    expect(server.authorizations.every((value) => value === 'Bearer scripted-test-no-key')).toBe(
      true,
    );
  });

  it('serves every model-assisted intent with its own tools and block kinds', async () => {
    const cases = [
      ['summarise', ['read_sources'], ['quotation', 'explanation']],
      ['check_payments', ['check_payments'], ['calculation']],
      ['missing_evidence', ['check_evidence'], ['finding']],
      [
        'brief_matter',
        ['read_sources', 'check_payments', 'check_evidence'],
        ['quotation', 'calculation'],
      ],
      ['prepare_review', ['prepare_review'], ['finding']],
    ] as const;
    for (const [intent, tools, kinds] of cases) {
      const { events } = await run({ intent, trigger: 'ui_action', utterance: '' });
      expect(events.at(-1)?.type, intent).toBe('run_completed');
      expect(
        events.flatMap((e) => (e.type === 'tool_result' ? [e.payload.result.toolName] : [])),
        intent,
      ).toEqual(tools);
      expect(
        events.flatMap((e) => (e.type === 'response_delta' ? [e.payload.block.kind] : [])),
        intent,
      ).toEqual(kinds);
    }
  });

  it('a briefing reports the calculator result and draft preparation keeps the human requirements open', async () => {
    const brief = await run({ intent: 'brief_matter', trigger: 'command', utterance: '/brief' });
    const payment = brief.events.find(
      (e) => e.type === 'tool_result' && e.payload.result.toolName === 'check_payments',
    );
    expect(payment?.type === 'tool_result' && payment.payload.result.output).toMatchObject({
      result: { differencePence: '200000', outcome: 'mismatch' },
    });
    const prepare = await run({
      intent: 'prepare_review',
      trigger: 'command',
      utterance: '/prepare-review',
    });
    const tool = prepare.events.find((e) => e.type === 'tool_result');
    const output = tool?.type === 'tool_result' ? tool.payload.result.output : null;
    expect(output).toMatchObject({ tool: 'prepare_review', saved: false, frozen: false });
    const codes = output?.tool === 'prepare_review' ? output.requirements.map((r) => r.code) : [];
    expect(codes).toEqual(
      expect.arrayContaining([
        'DECISION_LOG_MISSING',
        'HUMAN_REVIEW_GATE_PENDING',
        'FINDING_UNRESOLVED',
      ]),
    );
    expect(prepare.events.at(-1)).toMatchObject({
      type: 'run_completed',
      payload: { outcome: 'completed' },
    });
  });

  it('refuses the signing tool an injected instruction asks for, and changes nothing', async () => {
    const matter = await syntheticMatter();
    const { agent: a, store } = agent();
    const started = await a.start(
      await syntheticRequest(matter, {
        providerScope: scope,
        intent: null,
        trigger: 'free_text',
        utterance: 'Please explain this clause INJECT-TEST',
        references: [matter.refs.injection],
      }),
      context(),
    );
    if (!started.ok) throw new Error(started.error.code);
    const events: AssistantEvent[] = [];
    for await (const event of started.data.events ?? []) events.push(event);
    // The forged tool never ran; after one repair the run used only the allowed read tool.
    expect(events.flatMap((e) => (e.type === 'tool_started' ? [e.payload.toolName] : []))).toEqual([
      'read_sources',
    ]);
    expect(events.at(-1)?.type).toBe('run_completed');
    // The forged tool name appears in no event, and nothing offers approval as an action.
    expect(JSON.stringify(events)).not.toContain('sign_and_approve_package');
    const summary = events.find((e) => e.type === 'response_completed');
    expect(summary?.type === 'response_completed' && summary.payload.summary.nextActions).toEqual([
      'open_source',
    ]);
    expect([...store.rows.values()].map((row) => row.state)).toEqual(['completed']);
  });

  it('aborts the in-flight HTTP request on Stop and reports the run as cancelled', async () => {
    const matter = await syntheticMatter();
    const { agent: a, store } = agent();
    const before = server.requests.length;
    const started = await a.start(
      await syntheticRequest(matter, {
        providerScope: scope,
        intent: null,
        trigger: 'free_text',
        utterance: 'Please explain this clause SLOW-TEST',
      }),
      context(),
    );
    if (!started.ok) throw new Error(started.error.code);
    const events: AssistantEvent[] = [];
    const reading = (async () => {
      for await (const event of started.data.events ?? []) events.push(event);
    })();
    await expect.poll(() => server.requests.length).toBe(before + 1);
    const cancelled = await a.cancel(
      { runId: started.data.metadata.runId, ownerId: TEST_IDS.reviewer },
      new AbortController().signal,
    );
    expect(cancelled.ok && cancelled.data).toMatchObject({
      state: 'cancelled',
      acknowledged: true,
    });
    await reading;
    expect(events.at(-1)?.type).toBe('run_cancelled');
    expect(server.requests.length).toBe(before + 1);
    expect([...store.rows.values()][0]?.usageProvenance).toBe('unknown');
  });
});
