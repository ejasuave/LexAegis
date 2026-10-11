import { describe, expect, it } from 'vitest';
import { anythingToStop, stopAll, type StopPorts } from './stop';

function ports(
  over: Partial<{
    assistant: boolean;
    voice: boolean;
    speech: boolean;
    stage: string;
    tx: string;
    sent: boolean;
  }> = {},
) {
  const calls: string[] = [];
  const p: StopPorts = {
    assistant: { active: () => over.assistant ?? false, stop: () => void calls.push('assistant') },
    voice: { active: () => over.voice ?? false, abort: () => void calls.push('voice') },
    readAloud: { active: () => over.speech ?? false, cancel: () => void calls.push('speech') },
    approval: {
      stage: () => (over.stage ?? 'idle') as 'idle',
      cancelPreview: () => void calls.push('approval'),
    },
    transaction: {
      state: () => ({ stage: over.tx ?? 'idle', mayHaveBroadcast: over.sent ?? false }),
      cancel: () => void calls.push('tx'),
    },
  };
  return { p, calls };
}

describe('coordinated Stop', () => {
  it('stops every active part and nothing else', () => {
    const { p, calls } = ports({
      assistant: true,
      voice: true,
      speech: true,
      stage: 'preview',
      tx: 'awaiting_confirmation',
    });
    const report = stopAll(p);
    expect(calls.sort()).toEqual(['approval', 'assistant', 'speech', 'tx', 'voice']);
    expect(report.assistant).toBe('stop_requested');
    expect(report.transaction).toBe('unsent_cancelled');
  });

  it('does nothing when nothing is active, and never sends anything itself', () => {
    const { p, calls } = ports();
    const report = stopAll(p);
    expect(calls).toEqual([]);
    expect(report).toMatchObject({
      assistant: 'idle',
      voice: 'idle',
      readAloud: 'idle',
      transaction: 'none',
    });
    expect(anythingToStop(p)).toBe(false);
  });

  it('does not claim to cancel a transaction that may already be sent', () => {
    const { p, calls } = ports({ tx: 'pending', sent: true });
    const report = stopAll(p);
    expect(calls).not.toContain('tx');
    expect(report.transaction).toBe('already_sent');
    expect(report.notes.join(' ')).toContain('cannot cancel or reverse');
    expect(anythingToStop(p)).toBe(false);
  });

  it('keeps a signed approval signature rather than pretending to retract it', () => {
    const { p, calls } = ports({ stage: 'signed' });
    expect(stopAll(p).approvalPreview).toBe('signed_signature_kept');
    expect(calls).not.toContain('approval');
  });

  it('says plainly that signing already under way cannot be stopped', () => {
    const { p } = ports({ stage: 'signing' });
    expect(stopAll(p).notes.join(' ')).toContain('cannot be stopped');
  });
});
