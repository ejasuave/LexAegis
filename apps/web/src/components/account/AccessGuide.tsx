'use client';

import { useEffect, useState } from 'react';
import { describeVaultFailure } from '@/features/vault/public';
import { useVault } from '@/components/vault/vault-context';
import { useAccount } from './account-context';

/**
 * Account access and vault unlocking are two different things, and this card keeps them apart. It
 * names the current transition from real controller observations only: it never infers a cause
 * the browser did not report and never shows a recovered state from a matching address alone.
 * After a recovery it resumes read-only reconciliation of known public operations.
 */
export function AccessGuide() {
  const { availability, snapshot } = useAccount();
  const { snapshot: vault } = useVault();
  const [unresolved, setUnresolved] = useState<number | null>(null);
  const recovered = snapshot.lastEvent === 'account_recovered';
  const signedIn = snapshot.backend.state === 'signed_in';

  useEffect(() => {
    // Read-only: lists this account's public operations that still need a status check. It
    // never funds, sends, replaces, re-signs or regenerates anything.
    if (!recovered || !signedIn) return;
    let active = true;
    fetch('/api/chain/operations', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((json: { operations?: unknown[] } | null) => {
        if (active) setUnresolved(Array.isArray(json?.operations) ? json.operations.length : null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [recovered, signedIn]);

  const lines: string[] = [];
  if (availability === 'unsupported')
    lines.push(
      'This browser cannot run the passkey features LexAegis needs. Text review still works without an account.',
    );
  if (availability === 'misconfigured')
    lines.push('The account service is not configured correctly, so accounts are unavailable.');
  if (snapshot.lastError === 'CANCELLED' || snapshot.lastError === 'NOT_COMPLETED')
    lines.push('The passkey prompt was cancelled or did not finish. Nothing changed.');
  if (snapshot.lastEvent === 'signing_expired' || snapshot.lastError === 'SESSION_EXPIRED')
    lines.push(
      'Signing locked itself after its time limit. Unlock to continue; nothing was signed.',
    );
  if (snapshot.account !== null && snapshot.backend.state === 'signed_out')
    lines.push(
      'The server sign-in ended. Unlock signing to sign in again; your vault stays as it was.',
    );
  if (vault.discovery === 'absent' && snapshot.account !== null)
    lines.push('This account has no vault yet. Creating one is a separate step on this page.');
  if (
    vault.failure === 'MISSING_OBJECTS' ||
    vault.failure === 'INTEGRITY_FAILED' ||
    vault.failure === 'ROLLBACK_DETECTED'
  ) {
    const guidance = describeVaultFailure(vault.failure);
    lines.push(`${guidance.title}. ${guidance.next}`);
  }

  return (
    <section aria-label="Access" className="lj-card mt-4 max-w-2xl p-4 text-[0.9375rem]">
      <h2 className="m-0 text-lg font-medium">Account and vault are separate</h2>
      <ul className="m-0 mt-2 list-disc pl-5 text-[0.875rem] text-lj-secondary">
        <li>
          Account access: your passkey unlocks a signing session in this tab. It does not open the
          vault.
        </li>
        <li>Vault: unlocking decrypts your saved matters. It does not approve or sign anything.</li>
        <li>
          Approval: only the Approve this package button, on an exact frozen package, can start a
          signature.
        </li>
        <li>
          Recovery needs the original passkey for this site and the surviving ciphertext. A new
          passkey is a different account, not a recovery.
        </li>
      </ul>
      {lines.length > 0 ? (
        <ul className="m-0 mt-3 list-none p-0" role="status" aria-live="polite">
          {lines.map((line) => (
            <li key={line} className="py-1 text-lj-amber">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      {recovered ? (
        <p className="m-0 mt-2 text-[0.875rem]" role="status">
          Recovered account verified by the passkey.{' '}
          {unresolved === null
            ? 'Public operation status has not been read yet.'
            : unresolved === 0
              ? 'No public operations need reconciliation.'
              : `${unresolved} public operation(s) need a status refresh; refresh is read-only and sends nothing.`}{' '}
          Unused approval tickets are not restored, and nothing is re-signed or resent.
        </p>
      ) : null}
    </section>
  );
}
