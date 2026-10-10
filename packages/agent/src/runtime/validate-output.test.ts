import { describe, expect, it } from 'vitest';
import {
  TEST_IDS,
  syntheticContext,
  syntheticMatter,
  type SyntheticMatter,
} from '../testing/fixtures';
import type { ModelOutput } from './model-schemas';
import { ToolRunner } from './tools';
import { plainText, validateModelOutput, type OutputContext } from './validate-output';

const never = new AbortController().signal;

async function setup(matter?: SyntheticMatter) {
  const m = matter ?? (await syntheticMatter());
  let id = 0;
  const tools = new ToolRunner({
    ownerId: TEST_IDS.reviewer,
    runId: 'run_1',
    intent: 'brief_matter',
    matterId: TEST_IDS.matter,
    snapshotDigest: m.snapshotDigest,
    context: syntheticContext(m),
    rulePack: m.rulePack,
    clientObserved: null,
    status: { liveChain: () => Promise.resolve('unknown') },
    provider: { id: 'scripted-test', capability: 'test' },
    newId: () => `toolcall_${++id}`,
  });
  await tools.execute({ name: 'check_payments', arguments: '{"groupId":"settlement"}' }, never); // T1
  await tools.execute({ name: 'get_status', arguments: '{"scope":"matter"}' }, never); // T2
  const ctx: OutputContext = {
    runId: 'run_1',
    matterId: TEST_IDS.matter,
    intent: 'brief_matter',
    modelExecution: 'scripted-test',
    context: syntheticContext(m),
    rulePack: m.rulePack,
    tools,
    snapshotDigest: m.snapshotDigest,
    vaultGeneration: 3,
    newId: () => crypto.randomUUID(),
  };
  return { m, tools, ctx };
}

const block = (
  overrides: Partial<ModelOutput['blocks'][number]>,
): ModelOutput['blocks'][number] => ({
  kind: 'explanation',
  text: 'The agreement states a total and two instalments.',
  basis: 'supported',
  sources: ['S1'],
  rules: [],
  tools: [],
  ...overrides,
});

const output = (overrides: Partial<ModelOutput> = {}): string =>
  JSON.stringify({
    outcome: 'answer',
    blocks: [block({})],
    factProposals: [],
    unresolved: [],
    questions: [],
    scopeLimitations: [],
    nextActions: [],
    ...overrides,
  } satisfies ModelOutput);

const codesOf = (result: ReturnType<typeof validateModelOutput>) => (result.ok ? [] : result.codes);

describe('final output validation', () => {
  it('accepts an answer whose every reference resolves, and adds the excerpt-scope limitation', async () => {
    const { ctx } = await setup();
    const result = validateModelOutput(
      output({
        blocks: [
          block({}),
          block({ kind: 'quotation', text: '', sources: ['S2'] }),
          block({
            kind: 'calculation',
            text: 'The schedule is lower than the total.',
            sources: [],
            tools: ['T1'],
          }),
          block({ kind: 'status', text: '', sources: [], tools: ['T2'] }),
          block({
            kind: 'finding',
            text: 'Advice evidence is not linked.',
            sources: [],
            rules: ['independent-advice'],
            basis: 'interpretation',
          }),
        ],
        nextActions: ['open_source', 'confirm_fact', 'prepare_review'],
      }),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.blocks.map((b) => b.kind)).toEqual([
      'explanation',
      'quotation',
      'calculation',
      'status',
      'finding',
    ]);
    expect(result.response.blocks[1]).toEqual({ kind: 'quotation', source: 'S2', comment: '' });
    expect(result.response.blocks[2]).toEqual({
      kind: 'calculation',
      tool: 'T1',
      comment: 'The schedule is lower than the total.',
    });
    expect(result.response.scopeLimitations[0]).toContain('Only the selected excerpts were read');
    // confirm_fact is dropped: there is no proposal to confirm.
    expect(result.response.nextActions).toEqual(['open_source', 'prepare_review']);
    expect(result.response).toMatchObject({
      outcome: 'completed',
      modelExecution: 'scripted-test',
      runId: 'run_1',
    });
  });

  it('rejects unknown and cross-run handles, unknown rules and failed tool results', async () => {
    const { ctx } = await setup();
    expect(
      codesOf(validateModelOutput(output({ blocks: [block({ sources: ['S9'] })] }), ctx)),
    ).toEqual(['UNKNOWN_SOURCE_HANDLE']);
    expect(
      codesOf(validateModelOutput(output({ blocks: [block({ rules: ['invented-rule'] })] }), ctx)),
    ).toEqual(['UNKNOWN_RULE']);
    // T7 was never issued in this run; a handle from another run resolves to nothing.
    expect(
      codesOf(
        validateModelOutput(
          output({ blocks: [block({ kind: 'calculation', sources: [], tools: ['T7'] })] }),
          ctx,
        ),
      ),
    ).toEqual(['UNKNOWN_TOOL_HANDLE']);
  });

  it('a calculation or status must reference the matching code result', async () => {
    const { ctx } = await setup();
    expect(
      codesOf(
        validateModelOutput(
          output({ blocks: [block({ kind: 'calculation', sources: [], tools: ['T2'] })] }),
          ctx,
        ),
      ),
    ).toEqual(['CALCULATION_NEEDS_CHECK_PAYMENTS_RESULT']);
    expect(
      codesOf(
        validateModelOutput(
          output({ blocks: [block({ kind: 'status', sources: [], tools: ['T1'] })] }),
          ctx,
        ),
      ),
    ).toEqual(['STATUS_NEEDS_GET_STATUS_RESULT']);
    expect(
      codesOf(
        validateModelOutput(
          output({ blocks: [block({ kind: 'calculation', sources: [], tools: [] })] }),
          ctx,
        ),
      ),
    ).toEqual(['CALCULATION_NEEDS_ONE_TOOL_RESULT']);
    expect(
      codesOf(
        validateModelOutput(
          output({ blocks: [block({ kind: 'quotation', sources: ['S1', 'S2'] })] }),
          ctx,
        ),
      ),
    ).toEqual(['QUOTATION_NEEDS_ONE_SOURCE']);
  });

  it('rejects an amount the model typed that no code result, fact or cited quote contains', async () => {
    const { ctx } = await setup();
    const bad = validateModelOutput(
      output({
        blocks: [block({ text: 'The shortfall is £3,500.00.', sources: [], tools: ['T1'] })],
      }),
      ctx,
    );
    expect(codesOf(bad)).toEqual(['AMOUNT_NOT_FROM_RESULT_OR_SOURCE']);
    // The computed difference, the stated total (a confirmed fact) and a quoted amount are all fine.
    const good = validateModelOutput(
      output({
        blocks: [
          block({
            text: 'The shortfall is £2,000.00 against £24,000.00.',
            sources: [],
            tools: ['T1'],
          }),
          block({ text: 'The clause says £24,000.00 gross.', sources: ['S1'] }),
        ],
      }),
      ctx,
    );
    expect(good.ok).toBe(true);
  });

  it('a statement presented as supported must cite something; interpretation may stand alone', async () => {
    const { ctx } = await setup();
    expect(codesOf(validateModelOutput(output({ blocks: [block({ sources: [] })] }), ctx))).toEqual(
      ['SUPPORTED_WITHOUT_REFERENCE'],
    );
    expect(
      validateModelOutput(
        output({ blocks: [block({ sources: [], basis: 'interpretation' })] }),
        ctx,
      ).ok,
    ).toBe(true);
  });

  it('turns fact proposals into proposals only, validated as FactCandidateV1', async () => {
    const { ctx } = await setup();
    const result = validateModelOutput(
      output({
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
          {
            field: 'agreement_date',
            group: 'settlement',
            slot: 'date',
            value: '2026-11-01',
            sources: ['S2'],
          },
        ],
        questions: ['Is the employer Northwind Ltd?'],
      }),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.factProposals).toEqual([
      {
        proposalId: 'P1',
        field: 'employer',
        group: 'settlement',
        slot: 'employer',
        value: 'Northwind Ltd',
        sources: ['S1'],
      },
      {
        proposalId: 'P2',
        field: 'agreement_date',
        group: 'settlement',
        slot: 'date',
        value: '2026-11-01',
        sources: ['S2'],
      },
    ]);
    expect(result.response.nextActions).toEqual(['confirm_fact']);
    expect(JSON.stringify(result.response)).not.toMatch(/confirmed|approved/);
  });

  it('never coerces invalid money or dates in a proposal', async () => {
    const { ctx } = await setup();
    for (const [field, value] of [
      ['payment_total', '£24,000.00'],
      ['payment_total', '24000.00'],
      ['payment_instalment', '-1000'],
      ['agreement_date', '01/11/2026'],
      ['agreement_date', '2026-02-30'],
      ['payment_basis', 'approx'],
    ] as const) {
      const result = validateModelOutput(
        output({
          factProposals: [{ field, group: 'settlement', slot: 'x', value, sources: ['S1'] }],
        }),
        ctx,
      );
      expect(codesOf(result)).toEqual([`PROPOSAL_INVALID:${field}`]);
    }
  });

  it('a proposal with no source becomes an unresolved reviewer-statement item, not a proposal', async () => {
    const { ctx } = await setup();
    const result = validateModelOutput(
      output({
        factProposals: [
          {
            field: 'adviser_name',
            group: 'settlement',
            slot: 'adviser',
            value: 'A. Example',
            sources: [],
          },
        ],
      }),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.factProposals).toEqual([]);
    expect(result.response.unresolved.map((u) => u.code)).toEqual(['REVIEWER_STATEMENT_REQUIRED']);
  });

  it('rejects malformed, oversized, extended and out-of-enum output with compact codes', async () => {
    const { ctx } = await setup();
    expect(codesOf(validateModelOutput('Sure! Here is the answer: {}', ctx))).toEqual([
      'OUTPUT_NOT_JSON',
    ]);
    expect(codesOf(validateModelOutput(null, ctx))).toEqual(['OUTPUT_NOT_JSON']);
    expect(codesOf(validateModelOutput(`{"x":"${'y'.repeat(33_000)}"}`, ctx))).toEqual([
      'OUTPUT_TOO_LARGE',
    ]);
    expect(codesOf(validateModelOutput(JSON.stringify({ outcome: 'answer' }), ctx))[0]).toMatch(
      /^OUTPUT_SCHEMA_INVALID:/,
    );
    for (const extra of [{ approved: true }, { persisted: true }, { sign: 'now' }]) {
      const result = validateModelOutput(
        JSON.stringify({ ...JSON.parse(output()), ...extra }),
        ctx,
      );
      expect(codesOf(result)[0]).toMatch(/^OUTPUT_SCHEMA_INVALID/);
    }
    const bad = JSON.parse(output()) as ModelOutput;
    expect(
      codesOf(
        validateModelOutput(JSON.stringify({ ...bad, nextActions: ['approve_package'] }), ctx),
      )[0],
    ).toMatch(/^OUTPUT_SCHEMA_INVALID:nextActions/);
    expect(
      codesOf(
        validateModelOutput(
          JSON.stringify({ ...bad, blocks: [{ ...bad.blocks[0], hash: `0x${'aa'.repeat(32)}` }] }),
          ctx,
        ),
      )[0],
    ).toMatch(/^OUTPUT_SCHEMA_INVALID:blocks/);
    // Codes carry no case content.
    const codes = codesOf(
      validateModelOutput(
        output({ blocks: [block({ sources: ['S9'], text: 'SECRET-CASE-TEXT' })] }),
        ctx,
      ),
    );
    expect(codes.join(' ')).not.toContain('SECRET-CASE-TEXT');
  });

  it('keeps generated text as inert plain text', async () => {
    const { ctx } = await setup();
    expect(plainText('ok‮gnp.exe\u0000\u0007')).toBe('okgnp.exe');
    const html =
      '<img src=x onerror=alert(1)> [click](javascript:alert(1)) https://example.invalid';
    const result = validateModelOutput(output({ blocks: [block({ text: html })] }), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Stored verbatim as text; no field can mark it as HTML, a link or an action.
    expect(result.response.blocks[0]).toEqual({
      kind: 'explanation',
      text: html,
      basis: 'supported',
      sources: ['S1'],
      rules: [],
      tools: [],
    });
  });

  it('maps an unsupported request to a scoped refusal and needs a question for needs_input', async () => {
    const { ctx } = await setup();
    const refused = validateModelOutput(output({ outcome: 'unsupported', blocks: [] }), ctx);
    expect(refused.ok && refused.response).toMatchObject({
      outcome: 'limited_scope',
      unresolved: [{ code: 'OUT_OF_SCOPE' }],
    });
    expect(
      codesOf(validateModelOutput(output({ outcome: 'needs_input', blocks: [] }), ctx)),
    ).toEqual(['NEEDS_INPUT_WITHOUT_QUESTION']);
    expect(codesOf(validateModelOutput(output({ blocks: [] }), ctx))).toEqual(['EMPTY_ANSWER']);
  });
});
