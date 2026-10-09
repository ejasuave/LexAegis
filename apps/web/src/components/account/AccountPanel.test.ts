import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_SNAPSHOT,
  accountStatusLabel,
  type AccountSnapshot,
} from '@/features/account/public';
import { AccountPanel } from './AccountPanel';

const snap = (patch: Partial<AccountSnapshot>): AccountSnapshot => ({
  ...EMPTY_SNAPSHOT,
  ...patch,
});
const ADDRESS = `0x${'ab'.repeat(20)}`;

describe('account status label', () => {
  it('comes only from real controller state', () => {
    expect(accountStatusLabel(EMPTY_SNAPSHOT, 'unsupported')).toBe('Account unavailable');
    expect(accountStatusLabel(EMPTY_SNAPSHOT, 'misconfigured')).toBe('Account unavailable');
    expect(accountStatusLabel(EMPTY_SNAPSHOT, 'available')).toBe('No account');
    expect(accountStatusLabel(snap({ ceremony: 'awaiting_passkey' }), 'available')).toBe(
      'Awaiting passkey',
    );
    const account = { address: ADDRESS, verifiedThisSession: true };
    expect(accountStatusLabel(snap({ account }), 'available')).toBe('Locked');
    expect(
      accountStatusLabel(
        snap({ account, signing: { state: 'unlocked', expiresAt: 1, idleExpiresAt: 1 } }),
        'available',
      ),
    ).toBe('Account ready');
  });

  it('is never ready merely because the server session exists', () => {
    const signedIn = snap({
      account: { address: ADDRESS, verifiedThisSession: false },
      backend: { state: 'signed_in', address: ADDRESS, expiresAt: 'x' },
    });
    expect(accountStatusLabel(signedIn, 'available')).toBe('Locked');
  });
});

describe('account panel before the browser controller exists', () => {
  const html = renderToStaticMarkup(createElement(AccountPanel));

  it('shows separate readings and claims nothing about the vault, the chain or a receipt', () => {
    for (const label of [
      'Selected account',
      'Signing session',
      'Server sign-in',
      'Vault',
      'Chain connection',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Locked');
    expect(html).toContain('Unavailable (not built yet)');
    expect(html).not.toMatch(/confirmed|receipt|decrypted|approved/i);
  });

  it('explains the scope before any ceremony and keeps the controls disabled until ready', () => {
    expect(html).toContain('does not approve a review');
    expect(html).toContain('A new or different passkey is a different account');
    expect(html).toContain('Create account and sign in');
    expect(html).toContain('Recover account');
    expect(html.match(/disabled=""/g)?.length).toBe(2);
    expect(html).not.toContain('Cancel');
  });
});
