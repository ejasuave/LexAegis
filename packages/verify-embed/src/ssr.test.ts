import { describe, expect, it, vi } from 'vitest';

describe('server-side import', () => {
  it('imports and registers nothing, and touches no browser global or network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const module = await import('./index');
    expect(typeof module.registerProofOfReviewStatus).toBe('function');
    expect(typeof customElements).toBe('undefined');
    expect(module.registerProofOfReviewStatus({})).toEqual({ ok: false, reason: 'NOT_A_BROWSER' });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
