import type { AssistantSnapshot, RunView } from '@/features/assistant/public';
import type { OrbState } from './AssistantOrb';

/*
 * Adapts real controller state to the orb. It adds no protocol of its own: the run states are the
 * existing enum, "listening" reflects an actual device lifecycle event, and "tool running" means
 * a tool call was started in the active run and has no result yet. No percentages, no waveform.
 */

export type VoiceActivity = 'idle' | 'listening' | 'speaking';

const OPERATION: Record<string, string> = {
  summarise: 'summary',
  explain: 'explanation',
  check_payments: 'payment check',
  missing_evidence: 'missing-evidence check',
  brief_matter: 'matter briefing',
  prepare_review: 'review preparation',
  status: 'status check',
};

export function operationName(intent: RunView['intent']): string {
  return intent === null ? 'request' : (OPERATION[intent] ?? 'request');
}

function activeRun(snapshot: AssistantSnapshot): RunView | null {
  return (
    snapshot.conversation.find((item) => item.run?.id === snapshot.activeRunViewId)?.run ?? null
  );
}

function lastRun(snapshot: AssistantSnapshot): RunView | null {
  for (let i = snapshot.conversation.length - 1; i >= 0; i--) {
    const run = snapshot.conversation[i]?.run;
    if (run != null) return run;
  }
  return null;
}

export interface OrbReadingResult {
  readonly state: OrbState;
  /** Text for a completed state; absent otherwise. */
  readonly completedLabel?: string;
}

export function deriveOrb(
  snapshot: AssistantSnapshot,
  voice: VoiceActivity = 'idle',
): OrbReadingResult {
  if (snapshot.phase === 'stopping') return { state: 'stopping' };
  if (voice === 'listening') return { state: 'listening' };
  const run = activeRun(snapshot);
  if (snapshot.phase === 'running' && run !== null) {
    const pendingTool = run.toolsStarted.length > run.tools.length;
    return { state: pendingTool ? 'tool_running' : 'running' };
  }
  if (snapshot.phase === 'preview') return { state: 'awaiting_input' };
  if (snapshot.orb === 'completed') {
    const last = lastRun(snapshot);
    return {
      state: 'completed',
      completedLabel: `Finished: ${operationName(last?.intent ?? null)}. This approves nothing.`,
    };
  }
  return { state: snapshot.orb };
}
