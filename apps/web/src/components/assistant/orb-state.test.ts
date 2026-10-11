import { describe, expect, it } from 'vitest';
import {
  EMPTY_ASSISTANT_SNAPSHOT,
  type AssistantSnapshot,
  type RunView,
} from '@/features/assistant/public';
import { deriveOrb } from './orb-state';

const run = (patch: Partial<RunView>): RunView =>
  ({ id: 'r1', intent: 'check_payments', toolsStarted: [], tools: [], ...patch }) as RunView;
const snap = (patch: Partial<AssistantSnapshot>): AssistantSnapshot => ({
  ...EMPTY_ASSISTANT_SNAPSHOT,
  ...patch,
});

describe('orb state mapping', () => {
  it('is unavailable until the assistant reports a usable state', () => {
    expect(deriveOrb(snap({})).state).toBe('unavailable');
  });
  it('shows listening only from a real microphone state', () => {
    expect(deriveOrb(snap({ orb: 'ready' }), 'listening').state).toBe('listening');
    expect(deriveOrb(snap({ orb: 'ready' }), 'speaking').state).toBe('ready');
  });
  it('shows a tool as running only while a started tool has no result', () => {
    const base = { phase: 'running' as const, activeRunViewId: 'r1', orb: 'running' as const };
    const started = snap({
      ...base,
      conversation: [
        { id: 'c', role: 'assistant', text: '', run: run({ toolsStarted: ['t1'], tools: [] }) },
      ],
    });
    expect(deriveOrb(started).state).toBe('tool_running');
    const done = snap({
      ...base,
      conversation: [
        {
          id: 'c',
          role: 'assistant',
          text: '',
          run: run({ toolsStarted: ['t1'], tools: [{} as never] }),
        },
      ],
    });
    expect(deriveOrb(done).state).toBe('running');
  });
  it('names exactly which operation finished and that it approves nothing', () => {
    const result = deriveOrb(
      snap({
        orb: 'completed',
        conversation: [{ id: 'c', role: 'assistant', text: '', run: run({}) }],
      }),
    );
    expect(result.completedLabel).toContain('payment check');
    expect(result.completedLabel).toContain('approves nothing');
  });
  it('stopping wins over everything else', () => {
    expect(deriveOrb(snap({ phase: 'stopping', orb: 'stopping' }), 'listening').state).toBe(
      'stopping',
    );
  });
});
