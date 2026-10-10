import {
  ASSISTANT_LIMITS,
  TOOL_VERSION,
  assistantToolNameSchema,
  jsonBytes,
  toolResultSchema,
  utf8Bytes,
  type AssistantIntent,
  type AssistantToolName,
  type ClientObservedStatus,
  type ProviderId,
  type SelectedContextV1,
  type StatusReading,
  type ToolOutput,
  type ToolResult,
} from '../contracts';
import {
  buildChecklist,
  demoDraftReview,
  requirementsPreview,
  toolGetRules,
  toolReconcilePayments,
  type LoadedRulePack,
  type SourceSet,
} from '../review';
import { TOOL_INPUTS, toolsForIntent, type ToolInput } from './tool-schemas';

/*
 * Executes the six read-only tools for one run. The tool context is created by the server from
 * the authenticated session and the consented request, and is immutable: no argument can select
 * another account, matter, version or snapshot, supply a fact, mark a confirmation, change a
 * rule, reach a URL or obtain a secret. A model's tool call is a request; this code authorises
 * the tool for the intent and its arguments before anything runs.
 */

/** Server-side status adapter. Anything it cannot read is unknown, never assumed. */
export interface StatusPort {
  liveChain(signal: AbortSignal): Promise<StatusReading['liveChain']['state']>;
}

export interface ToolContext {
  readonly ownerId: string;
  readonly runId: string;
  readonly intent: AssistantIntent;
  readonly matterId: string;
  readonly snapshotDigest: string;
  /** The consented context. Tools read nothing outside it. */
  readonly context: SelectedContextV1;
  readonly rulePack: LoadedRulePack;
  readonly clientObserved: ClientObservedStatus | null;
  readonly status: StatusPort;
  readonly provider: {
    readonly id: ProviderId;
    readonly capability: 'verified' | 'configured' | 'test';
  };
  readonly newId: () => string;
}

export interface ToolRequest {
  readonly name: string;
  /** Raw JSON text from the provider. */
  readonly arguments: string;
}

export type ToolExecution =
  /** Not executed: the tool or its arguments were not authorised. Codes go to one repair attempt. */
  | { readonly kind: 'rejected'; readonly codes: readonly string[] }
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'executed';
      readonly result: ToolResult;
      /** True when an identical call in this run already produced this result. */
      readonly cached: boolean;
      /** The compact text returned to the model. It is untrusted input to later model calls. */
      readonly modelText: string;
    };

type Outcome =
  | { readonly ok: true; readonly output: ToolOutput }
  | { readonly ok: false; readonly code: string };

const ok = (output: ToolOutput): Outcome => ({ ok: true, output });
const failed = (code: string): Outcome => ({ ok: false, code });

export class ToolRunner {
  readonly #context: ToolContext;
  readonly #allowed: ReadonlySet<AssistantToolName>;
  readonly #results: ToolResult[] = [];
  readonly #cache = new Map<string, ToolResult>();

  constructor(context: ToolContext) {
    this.#context = context;
    this.#allowed = new Set(toolsForIntent(context.intent));
  }

  /** Results of this run, in handle order. A handle from anywhere else resolves to nothing. */
  get results(): readonly ToolResult[] {
    return this.#results;
  }

  result(handle: string): ToolResult | undefined {
    return this.#results.find((entry) => entry.handle === handle);
  }

  get executions(): number {
    return this.#results.length;
  }

  /** Validates a requested call without running it. */
  authorise(
    request: ToolRequest,
  ):
    | { ok: true; name: AssistantToolName; input: unknown; key: string }
    | { ok: false; codes: string[] } {
    const name = assistantToolNameSchema.safeParse(request.name);
    if (!name.success) return { ok: false, codes: ['TOOL_UNKNOWN'] };
    if (!this.#allowed.has(name.data)) return { ok: false, codes: ['TOOL_NOT_ALLOWED_FOR_INTENT'] };
    if (utf8Bytes(request.arguments) > ASSISTANT_LIMITS.toolArgumentBytes)
      return { ok: false, codes: ['TOOL_ARGUMENTS_TOO_LARGE'] };
    let raw: unknown;
    try {
      raw = JSON.parse(request.arguments === '' ? '{}' : request.arguments);
    } catch {
      return { ok: false, codes: ['TOOL_ARGUMENTS_NOT_JSON'] };
    }
    const input = TOOL_INPUTS[name.data].safeParse(raw);
    if (!input.success) return { ok: false, codes: ['TOOL_ARGUMENTS_INVALID'] };
    const codes = this.#checkArguments(name.data, input.data);
    if (codes.length > 0) return { ok: false, codes };
    return {
      ok: true,
      name: name.data,
      input: input.data,
      key: `${name.data}:${JSON.stringify(input.data)}`,
    };
  }

  #checkArguments(name: AssistantToolName, input: unknown): string[] {
    const { context, rulePack } = this.#context;
    const rules = new Set(rulePack.pack.rules.map((rule) => rule.ruleId));
    if (name === 'read_sources') {
      const known = new Set(context.sources.map((entry) => entry.handle));
      const ids = (input as ToolInput<'read_sources'>).sourceIds;
      return ids.every((id) => known.has(id)) ? [] : ['UNKNOWN_SOURCE_HANDLE'];
    }
    if (name === 'get_rules') {
      const ids = (input as ToolInput<'get_rules'>).ruleIds;
      return ids.length === 1 && ids[0] === 'all'
        ? []
        : ids.every((id) => rules.has(id))
          ? []
          : ['UNKNOWN_RULE'];
    }
    if (name === 'check_evidence') {
      const ids = (input as ToolInput<'check_evidence'>).ruleIds;
      return ids.every((id) => rules.has(id)) ? [] : ['UNKNOWN_RULE'];
    }
    if (name === 'check_payments') {
      return /^[a-z0-9-]{1,40}$/.test((input as ToolInput<'check_payments'>).groupId)
        ? []
        : ['GROUP_INVALID'];
    }
    return [];
  }

  async execute(request: ToolRequest, signal: AbortSignal): Promise<ToolExecution> {
    const aborted = () => signal.aborted;
    if (aborted()) return { kind: 'cancelled' };
    const authorised = this.authorise(request);
    if (!authorised.ok) return { kind: 'rejected', codes: authorised.codes };
    const cached = this.#cache.get(authorised.key);
    if (cached !== undefined)
      return { kind: 'executed', result: cached, cached: true, modelText: modelText(cached) };

    let outcome: Outcome;
    try {
      outcome = await this.#run(authorised.name, authorised.input, signal);
    } catch {
      outcome = failed('TOOL_FAILED');
    }
    // A result finished after cancellation is discarded, not recorded.
    if (aborted()) return { kind: 'cancelled' };

    const base = {
      schema: 'lexaegis.tool-result.v1' as const,
      handle: `T${this.#results.length + 1}`,
      toolCallId: this.#context.newId(),
      toolName: authorised.name,
      toolVersion: TOOL_VERSION,
    };
    const tooLarge = outcome.ok && jsonBytes(outcome.output) > ASSISTANT_LIMITS.toolResultBytes;
    const result = toolResultSchema.parse(
      outcome.ok && !tooLarge
        ? { ...base, outcome: 'succeeded', code: 'OK', output: outcome.output }
        : tooLarge
          ? // Too much for one result: the caller must ask for less. Nothing partial is returned.
            { ...base, outcome: 'needs_narrowing', code: 'RESULT_TOO_LARGE', output: null }
          : {
              ...base,
              outcome: 'failed',
              code: outcome.ok ? 'TOOL_FAILED' : outcome.code,
              output: null,
            },
    );
    this.#results.push(result);
    this.#cache.set(authorised.key, result);
    return { kind: 'executed', result, cached: false, modelText: modelText(result) };
  }

  async #run(name: AssistantToolName, input: unknown, signal: AbortSignal): Promise<Outcome> {
    const { context, rulePack, matterId, snapshotDigest } = this.#context;
    const scope = { matterId, snapshotDigest };
    switch (name) {
      case 'read_sources': {
        const wanted = new Set((input as ToolInput<'read_sources'>).sourceIds);
        return ok({
          tool: 'read_sources',
          searchedScope: 'selected_excerpts',
          sources: context.sources
            .filter((entry) => wanted.has(entry.handle))
            .map((entry) => ({
              handle: entry.handle,
              documentVersionId: entry.reference.documentVersionId,
              page: entry.reference.page,
              text: entry.reference.quote,
              coverage: entry.coverage,
              warnings: entry.warnings,
            })),
        });
      }
      case 'get_rules': {
        const ids = (input as ToolInput<'get_rules'>).ruleIds;
        const all = ids.length === 1 && ids[0] === 'all';
        const picked = toolGetRules(
          rulePack,
          all ? rulePack.pack.rules.map((rule) => rule.ruleId) : ids,
        );
        if (!picked.ok) return failed(picked.code);
        return ok({
          tool: 'get_rules',
          packId: rulePack.pack.packId,
          packVersion: rulePack.pack.version,
          packDigest: rulePack.digest,
          reviewState: demoDraftReview(rulePack.digest).state,
          rules: picked.data.map((rule) => ({
            ruleId: rule.ruleId,
            title: rule.title,
            category: rule.category,
            evaluator: rule.evaluator,
            requiredInputs: rule.requiredInputs,
            evidenceRequirement: rule.evidenceRequirement,
            prompt: rule.prompt,
          })),
        });
      }
      case 'check_payments': {
        // Scope comes from the server-created context on both sides: an argument cannot widen it.
        const set: SourceSet = { matterId, sources: new Map(), selected: new Set() };
        const reconciled = toolReconcilePayments(
          set,
          scope,
          scope,
          context.facts,
          (input as ToolInput<'check_payments'>).groupId,
        );
        return reconciled.ok
          ? ok({ tool: 'check_payments', result: reconciled.data })
          : failed(reconciled.code);
      }
      case 'check_evidence': {
        const ids = new Set((input as ToolInput<'check_evidence'>).ruleIds);
        const documents = context.searchedScope.documentVersionIds;
        const checklist = buildChecklist(rulePack, context.evidence, documents.length > 0);
        return ok({
          tool: 'check_evidence',
          searchedScope: 'reviewer_links_for_selected_documents',
          searchedDocumentVersionIds: documents,
          assessed: documents.length > 0,
          items: checklist.items
            .filter((item) => ids.size === 0 || ids.has(item.ruleId))
            .map((item) => ({
              ruleId: item.ruleId,
              requirement: item.requirement,
              state: item.state,
              linkedArtifacts: item.artifactIds.length,
            })),
        });
      }
      case 'get_status': {
        const { status, clientObserved, provider } = this.#context;
        let chain: StatusReading['liveChain']['state'];
        try {
          chain = await status.liveChain(signal);
        } catch {
          chain = 'unknown';
        }
        return ok({
          tool: 'get_status',
          status: {
            scope: (input as ToolInput<'get_status'>).scope,
            assistant: {
              provenance: 'server',
              provider: provider.id,
              capability: provider.capability,
            },
            session: { provenance: 'server', signedIn: true },
            client: clientObserved,
            liveChain: { provenance: 'server', state: chain },
            // No indexer is connected yet; an indexed result would never be a live verification.
            indexedHistory: { state: 'not_connected' },
            // No public receipt reference accompanies a request, so none is read.
            receipt: { lifecycle: 'not_selected', provenance: 'none' },
          },
        });
      }
      case 'prepare_review': {
        const preview = requirementsPreview({
          rulePack,
          facts: context.facts,
          evidence: context.evidence,
          selectedDocuments: context.searchedScope.documentVersionIds.length,
        });
        return ok({
          tool: 'prepare_review',
          saved: false,
          frozen: false,
          requirements: preview.requirements,
        });
      }
    }
  }
}

/** What the model receives for a tool result: the handle, outcome and a minimal projection. */
export function modelText(result: ToolResult): string {
  const output = result.output;
  const projected =
    output?.tool === 'read_sources'
      ? {
          tool: output.tool,
          searchedScope: output.searchedScope,
          sources: output.sources.map(({ handle, page, text, coverage, warnings }) => ({
            handle,
            page,
            text,
            coverage,
            warnings,
          })),
        }
      : output?.tool === 'check_evidence'
        ? {
            tool: output.tool,
            searchedScope: output.searchedScope,
            assessed: output.assessed,
            items: output.items,
          }
        : output;
  return JSON.stringify({
    handle: result.handle,
    outcome: result.outcome,
    code: result.code,
    result: projected,
  });
}
