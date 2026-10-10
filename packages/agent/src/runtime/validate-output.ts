import {
  ASSISTANT_LIMITS,
  assistantResponseSchema,
  utf8Bytes,
  type AnswerBlock,
  type AssistantIntent,
  type AssistantResponse,
  type FactProposal,
  type ModelExecution,
  type NextAction,
  type SelectedContextV1,
  type UnresolvedItem,
} from '../contracts';
import { parseCandidate, parseGbpAmount, type LoadedRulePack } from '../review';
import { modelOutputSchema, type ModelBlock, type ModelOutput } from './model-schemas';
import type { ToolRunner } from './tools';

/*
 * Validates a model's final output before anything is shown. The output is a set of proposals
 * that refer to sources, rules and tool results by handle. This code resolves every handle
 * against the consented catalog, the pinned rule pack and this run's own successful tool results,
 * and rejects anything that does not resolve.
 *
 * What this establishes is reference integrity and schema conformance. It does not establish
 * that a statement follows from its citation, that a PDF was transcribed correctly, or that
 * anything is legally correct, and nothing downstream may present it as such a guarantee.
 */

export interface OutputContext {
  readonly runId: string;
  readonly matterId: string;
  readonly intent: AssistantIntent | null;
  readonly modelExecution: ModelExecution;
  readonly context: SelectedContextV1;
  readonly rulePack: LoadedRulePack;
  readonly tools: Pick<ToolRunner, 'result' | 'results'>;
  readonly snapshotDigest: string;
  readonly vaultGeneration: number;
  /** Lowercase UUIDv4 for fact candidates. */
  readonly newId: () => string;
}

export type OutputValidation =
  | { readonly ok: true; readonly response: AssistantResponse }
  /** Compact machine codes only: suitable for one repair request, never a copy of the case. */
  | { readonly ok: false; readonly codes: readonly string[] };

const SCOPE_NOTE =
  'Only the selected excerpts were read. Nothing can be concluded about text that was not selected.';
const OUT_OF_SCOPE =
  'Aegis cannot do this. Approval, signing and changes to facts or rules are yours alone.';

/**
 * Generated text is shown as plain text only. Control characters and bidirectional overrides are
 * removed here; the interface never interprets it as HTML or Markdown and never turns it into a
 * link or an action.
 */
/** Control characters, zero-width characters and bidirectional overrides, as code-point ranges. */
const REMOVED: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

export function plainText(text: string): string {
  let out = '';
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    if (!REMOVED.some(([from, to]) => point >= from && point <= to)) out += character;
  }
  return out.trim();
}

const AMOUNT = /£\s?[0-9][0-9,]*(?:\.[0-9]{1,2})?/g;

function amountsIn(text: string): bigint[] {
  const out: bigint[] = [];
  for (const match of text.matchAll(AMOUNT)) {
    const parsed = parseGbpAmount(match[0].replace(/\s/g, '').replace(/,$/, ''));
    if (parsed.ok) out.push(parsed.pence);
    else out.push(-1n);
  }
  return out;
}

export function validateModelOutput(content: string | null, ctx: OutputContext): OutputValidation {
  const raw = content ?? '';
  if (utf8Bytes(raw) > ASSISTANT_LIMITS.outputBytes)
    return { ok: false, codes: ['OUTPUT_TOO_LARGE'] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, codes: ['OUTPUT_NOT_JSON'] };
  }
  const parsed = modelOutputSchema.safeParse(json);
  if (!parsed.success) {
    const paths = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.slice(0, 3).join('.'))),
    ];
    return { ok: false, codes: paths.slice(0, 6).map((path) => `OUTPUT_SCHEMA_INVALID:${path}`) };
  }
  return resolve(parsed.data, ctx);
}

function resolve(output: ModelOutput, ctx: OutputContext): OutputValidation {
  const codes = new Set<string>();
  const catalog = new Map(ctx.context.sources.map((entry) => [entry.handle, entry]));
  const rules = new Set(ctx.rulePack.pack.rules.map((rule) => rule.ruleId));

  // Amounts a statement may mention: code results of this run, confirmed facts, and cited quotes.
  const computed = new Set<bigint>();
  for (const result of ctx.tools.results) {
    if (result.output?.tool !== 'check_payments') continue;
    const r = result.output.result;
    for (const value of [r.statedTotalPence, r.comparableSumPence, r.incompleteSubtotalPence]) {
      if (value !== null) computed.add(BigInt(value));
    }
    if (r.differencePence !== null) {
      const difference = BigInt(r.differencePence);
      computed.add(difference < 0n ? -difference : difference);
    }
    for (const item of r.includedItems) computed.add(BigInt(item.amountPence));
  }
  for (const fact of ctx.context.facts) {
    if (fact.field === 'payment_total' || fact.field === 'payment_instalment')
      computed.add(BigInt(fact.value));
  }

  const checkRefs = (block: ModelBlock): boolean => {
    let good = true;
    for (const handle of block.sources) {
      if (!catalog.has(handle)) {
        codes.add('UNKNOWN_SOURCE_HANDLE');
        good = false;
      }
    }
    for (const rule of block.rules) {
      if (!rules.has(rule)) {
        codes.add('UNKNOWN_RULE');
        good = false;
      }
    }
    for (const handle of block.tools) {
      const result = ctx.tools.result(handle);
      if (result === undefined) {
        codes.add('UNKNOWN_TOOL_HANDLE');
        good = false;
      } else if (result.outcome !== 'succeeded') {
        codes.add('TOOL_RESULT_NOT_SUCCEEDED');
        good = false;
      }
    }
    return good;
  };

  /** A typed amount must come from a referenced code result, a confirmed fact or a cited quote. */
  const checkAmounts = (text: string, block: ModelBlock): void => {
    const quoted = new Set<bigint>();
    for (const handle of block.sources) {
      for (const amount of amountsIn(catalog.get(handle)?.reference.quote ?? ''))
        quoted.add(amount);
    }
    for (const amount of amountsIn(text)) {
      if (!computed.has(amount) && !quoted.has(amount))
        codes.add('AMOUNT_NOT_FROM_RESULT_OR_SOURCE');
    }
  };

  const blocks: AnswerBlock[] = [];
  for (const block of output.blocks) {
    if (!checkRefs(block)) continue;
    const text = plainText(block.text);
    checkAmounts(text, block);
    switch (block.kind) {
      case 'quotation': {
        const [source] = block.sources;
        if (block.sources.length !== 1 || source === undefined)
          codes.add('QUOTATION_NEEDS_ONE_SOURCE');
        else blocks.push({ kind: 'quotation', source, comment: text.slice(0, 500) });
        break;
      }
      case 'calculation':
      case 'status': {
        const [handle] = block.tools;
        const expected = block.kind === 'calculation' ? 'check_payments' : 'get_status';
        if (block.tools.length !== 1 || handle === undefined) {
          codes.add(`${block.kind.toUpperCase()}_NEEDS_ONE_TOOL_RESULT`);
        } else if (ctx.tools.result(handle)?.toolName !== expected) {
          codes.add(`${block.kind.toUpperCase()}_NEEDS_${expected.toUpperCase()}_RESULT`);
        } else {
          blocks.push({ kind: block.kind, tool: handle, comment: text.slice(0, 500) });
        }
        break;
      }
      default: {
        if (text === '') {
          codes.add('EMPTY_TEXT');
          break;
        }
        const referenced = block.sources.length + block.rules.length + block.tools.length > 0;
        // A statement presented as supported must name what supports it.
        if (block.basis === 'supported' && !referenced) {
          codes.add('SUPPORTED_WITHOUT_REFERENCE');
          break;
        }
        blocks.push({
          kind: block.kind,
          text,
          basis: block.basis,
          sources: [...new Set(block.sources)],
          rules: [...new Set(block.rules)],
          tools: [...new Set(block.tools)],
        });
      }
    }
  }

  const unresolved: UnresolvedItem[] = output.unresolved.map((item) => ({
    code: item.code,
    text: plainText(item.text) || item.code,
  }));
  const factProposals: FactProposal[] = [];
  for (const proposal of output.factProposals) {
    if (proposal.sources.length === 0) {
      // Nothing in the selected sources shows it: only the reviewer's own statement could carry it.
      unresolved.push({
        code: 'REVIEWER_STATEMENT_REQUIRED',
        text: `${proposal.field}: proposed without a source. It needs your own statement, entered and confirmed by you.`,
      });
      continue;
    }
    const references = proposal.sources.map((handle) => catalog.get(handle)?.reference);
    if (references.some((reference) => reference === undefined)) {
      codes.add('UNKNOWN_SOURCE_HANDLE');
      continue;
    }
    // The model's value is tested against Chapter 8's candidate schema as it stands: an invalid
    // amount or date is rejected, never coerced into shape.
    const candidate = parseCandidate({
      schema: 'lexaegis.fact-candidate.v1',
      factId: ctx.newId(),
      matterId: ctx.matterId,
      field: proposal.field,
      group: proposal.group,
      slot: proposal.slot,
      value: proposal.value,
      provenance: 'model',
      references,
    });
    if (!candidate.ok) {
      codes.add(`PROPOSAL_INVALID:${proposal.field}`);
      continue;
    }
    factProposals.push({
      proposalId: `P${factProposals.length + 1}`,
      field: proposal.field,
      group: proposal.group,
      slot: proposal.slot,
      value: proposal.value,
      sources: [...new Set(proposal.sources)],
    });
  }

  const questions = output.questions.map(plainText).filter((question) => question !== '');
  if (output.outcome === 'answer' && blocks.length === 0 && codes.size === 0)
    codes.add('EMPTY_ANSWER');
  if (
    output.outcome === 'needs_input' &&
    questions.length + unresolved.length + factProposals.length === 0 &&
    codes.size === 0
  )
    codes.add('NEEDS_INPUT_WITHOUT_QUESTION');
  if (output.outcome === 'unsupported' && !unresolved.some((item) => item.code === 'OUT_OF_SCOPE'))
    unresolved.unshift({ code: 'OUT_OF_SCOPE', text: OUT_OF_SCOPE });
  if (unresolved.length > ASSISTANT_LIMITS.unresolvedItems) codes.add('TOO_MANY_UNRESOLVED');
  if (codes.size > 0) return { ok: false, codes: [...codes].sort() };

  const limitations = output.scopeLimitations.map(plainText).filter((item) => item !== '');
  // Stated by code on every answer built from excerpts, whatever the model wrote.
  const scopeLimitations = (
    ctx.context.sources.length > 0 ? [SCOPE_NOTE, ...limitations] : limitations
  ).slice(0, 8);

  const cited = blocks.some(
    (block) => block.kind === 'quotation' || ('sources' in block && block.sources.length > 0),
  );
  const applicable = (action: NextAction): boolean =>
    action === 'confirm_fact' ? factProposals.length > 0 : action === 'open_source' ? cited : true;
  const nextActions = [...new Set(output.nextActions)].filter(applicable);
  if (factProposals.length > 0 && !nextActions.includes('confirm_fact'))
    nextActions.unshift('confirm_fact');

  const response = assistantResponseSchema.safeParse({
    schema: 'lexaegis.assistant-response.v1',
    runId: ctx.runId,
    intent: ctx.intent,
    outcome:
      output.outcome === 'answer'
        ? 'completed'
        : output.outcome === 'needs_input'
          ? 'needs_input'
          : 'limited_scope',
    modelExecution: ctx.modelExecution,
    blocks,
    factProposals,
    unresolved,
    questions: output.outcome === 'needs_input' ? questions : [],
    scopeLimitations,
    nextActions: nextActions.slice(0, 6),
    snapshotDigest: ctx.snapshotDigest,
    vaultGeneration: ctx.vaultGeneration,
  });
  return response.success
    ? { ok: true, response: response.data }
    : { ok: false, codes: ['OUTPUT_TOO_LARGE'] };
}
