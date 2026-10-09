import { describe, expect, it } from 'vitest';
import { createUnavailableAccountProvider } from './port';

describe('unavailable account provider', () => {
  it('never fabricates an address, session or signature', async () => {
    const provider = createUnavailableAccountProvider();
    const results = [
      await provider.createAccount(),
      await provider.recoverAccount(),
      provider.getSession(),
      await provider.endSession(),
      await provider.requestSignature({ purpose: 'sign-in', payload: 'x' }),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('NOT_IMPLEMENTED');
    }
  });
});
