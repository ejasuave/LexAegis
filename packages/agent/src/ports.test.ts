import { describe, expect, it } from 'vitest';
import { createUnavailableReviewAgent } from './ports';
import { syntheticMatter, syntheticRequest } from './testing/fixtures';

describe('unavailable review agent', () => {
  const agent = createUnavailableReviewAgent();
  const signal = new AbortController().signal;

  it('returns NOT_CONFIGURED for start, status and cancel instead of pretending to work', async () => {
    const request = await syntheticRequest(await syntheticMatter());
    const started = await agent.start(request, {
      ownerId: 'acct_1',
      signal,
      sessionValid: () => Promise.resolve(true),
    });
    expect(started.ok).toBe(false);
    expect(!started.ok && started.error.code).toBe('NOT_CONFIGURED');

    const cancelled = await agent.cancel({ runId: 'run_1', ownerId: 'acct_1' }, signal);
    expect(!cancelled.ok && cancelled.error.code).toBe('NOT_CONFIGURED');
    const status = await agent.status('run_1', 'acct_1');
    expect(!status.ok && status.error.code).toBe('NOT_CONFIGURED');
  });

  it('reports no provider, so nothing can be disclosed to it', async () => {
    expect(await agent.availability()).toMatchObject({
      state: 'not_configured',
      providerScope: null,
    });
  });
});
