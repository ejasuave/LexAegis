import { describe, expect, it } from 'vitest';
import type { AssistantRequest } from './contracts';
import { createUnavailableReviewAgent } from './ports';

describe('unavailable review agent', () => {
  const agent = createUnavailableReviewAgent();
  const signal = new AbortController().signal;

  it('returns NOT_IMPLEMENTED for start and cancel instead of pretending to work', async () => {
    const request: AssistantRequest = {
      schema: 'lexaegis.assistant-request.v1',
      clientRequestId: 'req_1',
      intent: 'summarise',
      utterance: '',
      context: { matterId: 'matter_1', documentVersionId: null, sourceReferences: [] },
    };
    const started = await agent.start(request, { ownerId: 'acct_1', signal });
    expect(started.ok).toBe(false);
    expect(!started.ok && started.error.code).toBe('NOT_IMPLEMENTED');

    const cancelled = await agent.cancel({ runId: 'run_1', ownerId: 'acct_1' }, signal);
    expect(cancelled.ok).toBe(false);
    expect(!cancelled.ok && cancelled.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('emits no events, so no tool progress or findings can be fabricated', async () => {
    const seen: unknown[] = [];
    for await (const item of agent.events('run_1', 'acct_1', signal)) seen.push(item);
    expect(seen).toEqual([]);
  });
});
