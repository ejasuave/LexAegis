import type {
  AgentConfigV1,
  AnswerBlock,
  AssistantIntent,
  ModelExecution,
  ResponseSummary,
  RunOutcome,
  SourceCatalogEntry,
  ToolResult,
} from '../contracts';
import { REVIEW_ENGINE_VERSION, agentConfigSchema } from '../contracts';
import { canonicalBytes, sha256Bytes } from './hash';

/*
 * Provenance artifacts of an assistant run, assembled in the browser from validated data it
 * already holds. Bytes are RFC 8785 canonical JSON, hashed with SHA-256 as every other artifact;
 * a digest is always kept outside the content it describes. Timestamps and identifiers are the
 * ones recorded at execution: building an artifact twice from the same run gives the same bytes.
 *
 * An artifact holds the validated answer, the references it cites and the tool results it used.
 * It never holds hidden reasoning, a credential, an endpoint, a raw transcript or a provider
 * request or response. Unconfirmed fact proposals are left out: they are not review inputs.
 */

export const ANALYSIS_SCHEMA = 'lexaegis.assistant-analysis.v1';

export const ANALYSIS_LIMITATIONS: readonly string[] = [
  'Code checked that every reference resolves and that the output fits its schema. That does not show a statement follows from its citation, that a document was transcribed correctly, or that anything is legally correct.',
  'Model output is not reproducible even with fixed parameters. Only hashing, validation and code calculations are deterministic.',
  'This is an assistant observation. It is not a confirmed fact, a human decision or an approval.',
];

export interface AnalysisInput {
  readonly matterId: string;
  readonly documentVersionId: string | null;
  /** The input snapshot the run was bound to. */
  readonly snapshotDigest: string;
  readonly run: {
    readonly runId: string | null;
    readonly intent: AssistantIntent | null;
    readonly outcome: RunOutcome | null;
    readonly startedAt: string;
    readonly modelExecution: ModelExecution;
  };
  readonly blocks: readonly AnswerBlock[];
  readonly summary: ResponseSummary | null;
  readonly catalog: readonly SourceCatalogEntry[];
  readonly tools: readonly ToolResult[];
}

/** Handles a set of blocks actually cites. */
export function citedHandles(blocks: readonly AnswerBlock[]): {
  sources: string[];
  rules: string[];
  tools: string[];
} {
  const sources = new Set<string>();
  const rules = new Set<string>();
  const tools = new Set<string>();
  for (const block of blocks) {
    if (block.kind === 'quotation') sources.add(block.source);
    else if (block.kind === 'calculation' || block.kind === 'status') tools.add(block.tool);
    else {
      for (const handle of block.sources) sources.add(handle);
      for (const rule of block.rules) rules.add(rule);
      for (const handle of block.tools) tools.add(handle);
    }
  }
  return { sources: [...sources].sort(), rules: [...rules].sort(), tools: [...tools].sort() };
}

export function buildAnalysisArtifact(input: AnalysisInput) {
  const cited = citedHandles(input.blocks);
  return {
    schema: ANALYSIS_SCHEMA,
    engineVersion: REVIEW_ENGINE_VERSION,
    matterId: input.matterId,
    documentVersionId: input.documentVersionId,
    inputSnapshotDigest: input.snapshotDigest,
    run: input.run,
    provenance: {
      aiAnalysis: input.run.modelExecution !== 'none',
      modelExecution: input.run.modelExecution,
    },
    response: {
      blocks: input.blocks,
      unresolved: input.summary?.unresolved ?? [],
      questions: input.summary?.questions ?? [],
      scopeLimitations: input.summary?.scopeLimitations ?? [],
      /** Proposals are counted, not stored: an unconfirmed proposal is not a review input. */
      factProposalsNotIncluded: input.summary?.factProposals.length ?? 0,
    },
    /** Only what the answer cites, with the complete source reference for each handle. */
    sources: input.catalog
      .filter((entry) => cited.sources.includes(entry.handle))
      .map((entry) => ({ handle: entry.handle, reference: entry.reference })),
    rules: cited.rules,
    /** Factual tool-action records: what ran and what code returned. */
    toolResults: input.tools.filter((tool) => cited.tools.includes(tool.handle)),
    limitations: ANALYSIS_LIMITATIONS,
  };
}
export type AnalysisArtifact = ReturnType<typeof buildAnalysisArtifact>;

export interface ArtifactBytes {
  readonly bytes: Uint8Array;
  /** SHA-256 of the bytes, held beside them and never inside them. */
  readonly sha256: string;
}

export async function analysisArtifactBytes(input: AnalysisInput): Promise<ArtifactBytes> {
  const bytes = canonicalBytes(buildAnalysisArtifact(input));
  return { bytes, sha256: await sha256Bytes(bytes) };
}

/** The agent configuration exactly as the runtime recorded it. Nothing is filled in or regenerated. */
export async function agentConfigArtifactBytes(config: AgentConfigV1): Promise<ArtifactBytes> {
  const bytes = canonicalBytes(agentConfigSchema.parse(config));
  return { bytes, sha256: await sha256Bytes(bytes) };
}

/** Configuration of a check that ran on the device with no model: nothing is invented for it. */
export function localAgentConfig(input: {
  readonly viewId: string;
  readonly intent: AssistantIntent | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly toolExecutions: number;
}): AgentConfigV1 {
  return agentConfigSchema.parse({
    schema: 'lexaegis.agent-config.v1',
    profile: { id: 'lexaegis.employment-settlement.ew', version: '1' },
    runtimeVersion: 'lexaegis.agent-runtime.v1',
    modelExecution: 'none',
    provider: null,
    prompts: null,
    parameters: null,
    budget: null,
    usage: {
      provenance: 'none',
      providerAttempts: 0,
      toolExecutions: input.toolExecutions,
      reservedInputTokens: 0,
      reservedOutputTokens: 0,
      inputEstimate: 'none',
      reportedInputTokens: null,
      reportedOutputTokens: null,
    },
    run: {
      runId: input.viewId,
      intent: input.intent,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      outcome: 'completed',
    },
  });
}
