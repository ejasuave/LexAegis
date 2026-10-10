import { formatGbp } from '@lexaegis/agent/review';
import type { RunView } from './controller';
import { OUTCOME_PREFIX } from './selected-context';

/*
 * How a saved assistant outcome rides on the encrypted matter record: the full analysis is an
 * immutable encrypted artifact, and a context entry of kind "outcome" points to it with a
 * concise summary. The entry is marked model_proposed and starts unconfirmed: a saved
 * observation is an observation, kept apart from confirmed facts.
 */

export const ANALYSIS_LABEL = 'lexaegis:assistant-analysis:v1:';
export const AGENT_CONFIG_LABEL = 'lexaegis:agent-config:v1:';

export interface StoredOutcome {
  readonly v: 1;
  readonly runId: string;
  readonly intent: string | null;
  readonly outcome: string | null;
  readonly modelExecution: string;
  /** Vault version of the analysis artifact, and of the agent configuration that produced it. */
  readonly analysisVersionId: string;
  readonly agentConfigVersionId: string | null;
  readonly inputSnapshotDigest: string;
  readonly summary: string;
  readonly savedAt: string;
}

/** A concise plain-text summary of a run, taken from validated blocks and code results. */
export function summariseRun(run: RunView): string {
  const parts: string[] = [];
  for (const block of run.blocks) {
    if (block.kind === 'explanation' || block.kind === 'finding') parts.push(block.text);
    else if (block.kind === 'calculation') {
      const tool = run.tools.find((entry) => entry.handle === block.tool);
      if (tool?.output?.tool === 'check_payments') {
        const r = tool.output.result;
        parts.push(
          r.differencePence === null
            ? `Payment check: ${r.outcome.replaceAll('_', ' ')}.`
            : `Payment check: ${r.outcome}, stated total ${formatGbp(r.statedTotalPence ?? '0')}, instalments ${formatGbp(r.comparableSumPence ?? '0')}, difference ${formatGbp(r.differencePence.replace('-', ''))}.`,
        );
      }
      if (block.comment !== '') parts.push(block.comment);
    } else if (block.comment !== '') parts.push(block.comment);
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return (text === '' ? 'Saved assistant outcome.' : text).slice(0, 600);
}

export function encodeOutcome(stored: StoredOutcome): string {
  return `${OUTCOME_PREFIX}${JSON.stringify(stored)}`;
}

export function decodeOutcome(text: string): StoredOutcome | null {
  if (!text.startsWith(OUTCOME_PREFIX)) return null;
  try {
    const parsed = JSON.parse(text.slice(OUTCOME_PREFIX.length)) as Partial<StoredOutcome>;
    return parsed.v === 1 &&
      typeof parsed.runId === 'string' &&
      typeof parsed.analysisVersionId === 'string' &&
      typeof parsed.summary === 'string'
      ? (parsed as StoredOutcome)
      : null;
  } catch {
    return null;
  }
}

/** How a context entry reads in a list. A saved outcome is shown as an observation, never raw JSON. */
export function describeContextEntry(text: string): string {
  const outcome = decodeOutcome(text);
  return outcome === null ? text : `Assistant observation: ${outcome.summary}`;
}
