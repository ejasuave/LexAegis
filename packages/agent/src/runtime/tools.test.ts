import { describe, expect, it } from 'vitest';
import { toolResultSchema, type AssistantIntent, type ToolOutput } from '../contracts';
import { reconcilePayments } from '../review';
import {
  TEST_IDS,
  syntheticContext,
  syntheticMatter,
  type SyntheticMatter,
} from '../testing/fixtures';
import { ToolRunner, type StatusPort, type ToolContext } from './tools';

const never = new AbortController().signal;
const status: StatusPort = { liveChain: () => Promise.resolve('not_configured') };

function runner(
  matter: SyntheticMatter,
  intent: AssistantIntent,
  overrides: Partial<ToolContext> = {},
) {
  let id = 0;
  return new ToolRunner({
    ownerId: TEST_IDS.reviewer,
    runId: 'run_1',
    intent,
    matterId: TEST_IDS.matter,
    snapshotDigest: matter.snapshotDigest,
    context: syntheticContext(matter),
    rulePack: matter.rulePack,
    clientObserved: null,
    status,
    provider: { id: 'scripted-test', capability: 'test' },
    newId: () => `toolcall_${++id}`,
    ...overrides,
  });
}

const call = (name: string, args: unknown) => ({
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args),
});

async function output<T extends ToolOutput['tool']>(
  tools: ToolRunner,
  name: T,
  args: unknown,
): Promise<Extract<ToolOutput, { tool: T }>> {
  const executed = await tools.execute(call(name, args), never);
  if (executed.kind !== 'executed' || executed.result.output?.tool !== name)
    throw new Error(`not executed: ${JSON.stringify(executed)}`);
  return executed.result.output as Extract<ToolOutput, { tool: T }>;
}

describe('read-only tools', () => {
  it('read_sources returns only consented catalog excerpts with coverage', async () => {
    const matter = await syntheticMatter();
    const tools = runner(matter, 'summarise');
    const out = await output(tools, 'read_sources', { sourceIds: ['S1'] });
    expect(out.sources).toEqual([
      {
        handle: 'S1',
        documentVersionId: TEST_IDS.version,
        page: 1,
        text: matter.refs.total.quote,
        coverage: 'complete',
        warnings: [],
      },
    ]);
    expect(out.searchedScope).toBe('selected_excerpts');
    // The injected paragraph was not selected, so no tool can return it.
    expect(JSON.stringify(tools.results)).not.toContain('IGNORE ALL PREVIOUS');
    expect(await tools.execute(call('read_sources', { sourceIds: ['S9'] }), never)).toEqual({
      kind: 'rejected',
      codes: ['UNKNOWN_SOURCE_HANDLE'],
    });
  });

  it('check_payments returns the real calculator result for the 24,000 vector', async () => {
    const matter = await syntheticMatter();
    const out = await output(runner(matter, 'check_payments'), 'check_payments', {
      groupId: 'settlement',
    });
    expect(out.result).toMatchObject({
      mode: 'review',
      outcome: 'mismatch',
      statedTotalPence: '2400000',
      comparableSumPence: '2200000',
      differencePence: '200000',
    });
  });

  it('a SIMULATED second instalment of 1,400,000 changes nothing a review tool returns', async () => {
    const matter = await syntheticMatter();
    const tools = runner(matter, 'check_payments');
    const before = await output(tools, 'check_payments', { groupId: 'settlement' });
    const simulated = reconcilePayments({
      mode: 'simulation',
      group: 'settlement',
      statedTotal: { amount: '24000.00', currency: 'GBP', basis: 'gross', confirmed: true },
      items: [
        {
          lineItemId: 'instalment-1',
          amount: '10000.00',
          currency: 'GBP',
          basis: 'gross',
          sourceKey: 'a',
          factId: null,
          confirmed: true,
        },
        {
          lineItemId: 'instalment-2',
          amount: '14000.00',
          currency: 'GBP',
          basis: 'gross',
          sourceKey: 'b',
          factId: null,
          confirmed: true,
        },
      ],
    });
    expect(simulated).toMatchObject({ mode: 'simulation', outcome: 'match' });
    const after = await output(runner(matter, 'check_payments'), 'check_payments', {
      groupId: 'settlement',
    });
    expect(after.result).toEqual(before.result);
    expect(after.result.differencePence).toBe('200000');
    // No argument can inject a line item, an amount or a simulation mode.
    for (const args of [
      { groupId: 'settlement', mode: 'simulation' },
      { groupId: 'settlement', items: [{ amount: '14000.00' }] },
      { groupId: 'settlement', facts: [] },
    ]) {
      expect(await tools.execute(call('check_payments', args), never)).toEqual({
        kind: 'rejected',
        codes: ['TOOL_ARGUMENTS_INVALID'],
      });
    }
  });

  it('unconfirmed or incomplete payment inputs give needs_input, never an estimate', async () => {
    const matter = await syntheticMatter();
    const partial = matter.facts.filter((f) => f.field !== 'payment_instalment');
    const tools = runner(matter, 'check_payments', {
      context: syntheticContext(matter, { facts: partial }),
    });
    const out = await output(tools, 'check_payments', { groupId: 'settlement' });
    expect(out.result.outcome).toBe('needs_input');
    expect(out.result.differencePence).toBeNull();
    const other = await output(tools, 'check_payments', { groupId: 'another-group' });
    expect(other.result.outcome).toBe('needs_input');
  });

  it('get_rules exposes the pinned pack with its real demo_draft review state', async () => {
    const matter = await syntheticMatter();
    const tools = runner(matter, 'explain');
    const out = await output(tools, 'get_rules', { ruleIds: ['independent-advice'] });
    expect(out).toMatchObject({ reviewState: 'demo_draft', packDigest: matter.rulePack.digest });
    expect(out.rules.map((r) => r.ruleId)).toEqual(['independent-advice']);
    expect((await output(tools, 'get_rules', { ruleIds: ['all'] })).rules.length).toBe(
      matter.rulePack.pack.rules.length,
    );
    expect(await tools.execute(call('get_rules', { ruleIds: ['made-up-rule'] }), never)).toEqual({
      kind: 'rejected',
      codes: ['UNKNOWN_RULE'],
    });
  });

  it('check_evidence reports reviewer links for the searched scope, not legal conclusions', async () => {
    const matter = await syntheticMatter();
    const out = await output(runner(matter, 'missing_evidence'), 'check_evidence', { ruleIds: [] });
    expect(out).toMatchObject({
      searchedScope: 'reviewer_links_for_selected_documents',
      searchedDocumentVersionIds: [TEST_IDS.version],
      assessed: true,
    });
    const state = (requirement: string) =>
      out.items.find((i) => i.requirement === requirement)?.state;
    expect(state('written-agreement')).toBe('confirmed_for_check');
    // The advice clause is present in the document, yet the requirement stays missing: a clause
    // being present is not evidence that advice was given.
    expect(state('independent-advice')).toBe('missing');
  });

  it('get_status keeps server, client-observed, chain and indexer readings apart', async () => {
    const matter = await syntheticMatter();
    const tools = runner(matter, 'status', {
      clientObserved: {
        provenance: 'client_observed',
        account: 'unlocked',
        vault: 'unlocked',
        vaultSave: 'unsaved',
        checks: 'stale',
        selectedDocuments: 1,
        confirmedFacts: 4,
        savedPackages: 0,
      },
      status: { liveChain: () => Promise.reject(new Error('rpc down')) },
    });
    const { status: reading } = await output(tools, 'get_status', { scope: 'selected_receipt' });
    expect(reading).toMatchObject({
      assistant: { provenance: 'server', provider: 'scripted-test', capability: 'test' },
      client: { provenance: 'client_observed', vault: 'unlocked' },
      // An RPC failure is unknown, never ready and never a failure of the receipt.
      liveChain: { state: 'unknown' },
      indexedHistory: { state: 'not_connected' },
      receipt: { lifecycle: 'not_selected', provenance: 'none' },
    });
  });

  it('prepare_review lists outstanding requirements and saves or freezes nothing', async () => {
    const matter = await syntheticMatter();
    const out = await output(runner(matter, 'prepare_review'), 'prepare_review', {});
    expect(out).toMatchObject({ saved: false, frozen: false });
    const codes = out.requirements.map((r) => `${r.code}|${r.detail}`);
    expect(codes).toContain('FINDING_UNRESOLVED|payment_reconciliation:settlement:mismatch');
    expect(codes).toContain('EVIDENCE_NOT_CONFIRMED|independent-advice:missing');
    expect(codes).toContain('INPUT_NOT_CONFIRMED|required-inputs:employer');
    expect(out.requirements.map((r) => r.code)).toEqual(
      expect.arrayContaining([
        'AGENT_CONFIG_MISSING',
        'DECISION_LOG_MISSING',
        'HUMAN_REVIEW_GATE_PENDING',
      ]),
    );
  });
});

describe('tool authorisation and limits', () => {
  it('refuses tools outside the intent allowlist and anything that is not a registered tool', async () => {
    const matter = await syntheticMatter();
    const tools = runner(matter, 'summarise');
    for (const [name, code] of [
      ['check_payments', 'TOOL_NOT_ALLOWED_FOR_INTENT'],
      ['prepare_review', 'TOOL_NOT_ALLOWED_FOR_INTENT'],
      ['sign_package', 'TOOL_UNKNOWN'],
      ['fetch_url', 'TOOL_UNKNOWN'],
      ['confirm_fact', 'TOOL_UNKNOWN'],
      ['run_code', 'TOOL_UNKNOWN'],
    ] as const) {
      expect(await tools.execute(call(name, {}), never)).toEqual({
        kind: 'rejected',
        codes: [code],
      });
    }
    expect(tools.executions).toBe(0);
  });

  it('rejects arguments that try to choose an account, matter, URL or secret', async () => {
    const matter = await syntheticMatter();
    const tools = runner(matter, 'brief_matter');
    for (const [name, args] of [
      ['read_sources', { sourceIds: ['S1'], matterId: TEST_IDS.otherMatter }],
      ['read_sources', { sourceIds: ['S1'], url: 'https://example.invalid/steal' }],
      ['read_sources', { sourceIds: ['https://example.invalid/steal'] }],
      ['get_status', { scope: 'matter', ownerId: TEST_IDS.otherReviewer }],
      ['get_status', { scope: 'secrets' }],
      ['check_payments', { groupId: '../../etc/passwd' }],
      ['check_evidence', { ruleIds: [], confirmedForCheck: true }],
    ] as const) {
      const executed = await tools.execute(call(name, args), never);
      expect(executed.kind).toBe('rejected');
    }
    expect(await tools.execute(call('read_sources', '{"sourceIds":["S1"]'), never)).toEqual({
      kind: 'rejected',
      codes: ['TOOL_ARGUMENTS_NOT_JSON'],
    });
    expect(
      await tools.execute(
        call('read_sources', JSON.stringify({ sourceIds: ['S1'], pad: 'x'.repeat(5000) })),
        never,
      ),
    ).toEqual({ kind: 'rejected', codes: ['TOOL_ARGUMENTS_TOO_LARGE'] });
    expect(tools.executions).toBe(0);
  });

  it('issues run-local handles in order and reuses an identical call within the run', async () => {
    const matter = await syntheticMatter();
    const tools = runner(matter, 'brief_matter');
    const first = await tools.execute(call('read_sources', { sourceIds: ['S1'] }), never);
    const second = await tools.execute(call('check_payments', { groupId: 'settlement' }), never);
    const again = await tools.execute(call('read_sources', { sourceIds: ['S1'] }), never);
    expect(first.kind === 'executed' && [first.result.handle, first.cached]).toEqual(['T1', false]);
    expect(second.kind === 'executed' && second.result.handle).toBe('T2');
    expect(again.kind === 'executed' && [again.result.handle, again.cached]).toEqual(['T1', true]);
    expect(tools.executions).toBe(2);
    for (const result of tools.results)
      expect(toolResultSchema.safeParse(result).success).toBe(true);
    // Another run knows nothing of these handles.
    expect(runner(matter, 'brief_matter').result('T1')).toBeUndefined();
  });

  it('returns a narrowing requirement instead of a truncated oversized result', async () => {
    const matter = await syntheticMatter();
    const long = 'x'.repeat(3900);
    const context = syntheticContext(matter);
    const sources = Array.from({ length: 6 }, (_, i) => ({
      ...(context.sources[0] as (typeof context.sources)[number]),
      handle: `S${i + 1}`,
      reference: {
        ...(context.sources[0] as (typeof context.sources)[number]).reference,
        quote: long,
      },
    }));
    const tools = runner(matter, 'summarise', { context: { ...context, sources } });
    const executed = await tools.execute(
      call('read_sources', { sourceIds: sources.map((s) => s.handle) }),
      never,
    );
    expect(executed).toMatchObject({
      kind: 'executed',
      result: { outcome: 'needs_narrowing', code: 'RESULT_TOO_LARGE', output: null },
    });
    const narrowed = await tools.execute(call('read_sources', { sourceIds: ['S1', 'S2'] }), never);
    expect(narrowed).toMatchObject({ kind: 'executed', result: { outcome: 'succeeded' } });
  });

  it('does nothing once cancelled and discards a result finished after cancellation', async () => {
    const matter = await syntheticMatter();
    const controller = new AbortController();
    let release: (value: 'ready') => void = () => undefined;
    const tools = runner(matter, 'status', {
      status: { liveChain: () => new Promise((resolve) => (release = resolve)) },
    });
    const pending = tools.execute(call('get_status', { scope: 'matter' }), controller.signal);
    controller.abort();
    release('ready');
    expect(await pending).toEqual({ kind: 'cancelled' });
    expect(tools.executions).toBe(0);
    expect(await tools.execute(call('get_status', { scope: 'matter' }), controller.signal)).toEqual(
      {
        kind: 'cancelled',
      },
    );
  });

  it('gives the model a minimal projection without document or artifact identifiers', async () => {
    const matter = await syntheticMatter();
    const executed = await runner(matter, 'summarise').execute(
      call('read_sources', { sourceIds: ['S1'] }),
      never,
    );
    if (executed.kind !== 'executed') throw new Error('expected execution');
    expect(executed.modelText).toContain('"handle":"T1"');
    expect(executed.modelText).toContain(matter.refs.total.quote);
    expect(executed.modelText).not.toContain(TEST_IDS.version);
    expect(executed.modelText).not.toContain('0x');
  });
});
