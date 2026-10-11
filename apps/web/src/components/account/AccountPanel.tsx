'use client';

import { useId } from 'react';
import { accountStatusLabel, type AccountErrorCode } from '@/features/account/public';
import { Icon } from '@/components/shell/icons';
import { useVault } from '@/components/vault/vault-context';
import { vaultStatusLabel } from '@/components/vault/status';
import { useAccount } from './account-context';

const SUPPORT_URL = 'https://mera.category.xyz/authenticator-support/';

const button = 'min-h-11 rounded border border-lj-edge px-4 text-[0.875rem] disabled:text-lj-muted';

/** What went wrong and what to do next. No message guesses a cause the browser did not report. */
const GUIDANCE: Partial<Record<AccountErrorCode, string>> = {
  NOT_COMPLETED:
    'The passkey prompt did not finish. It may have been dismissed, timed out or not allowed. Nothing was changed; try again when ready.',
  CANCELLED:
    'Cancelled. If the browser already saved a passkey, it is still there and can be used with Recover account.',
  PRF_UNAVAILABLE:
    'This passkey or device does not support the PRF feature LexAegis needs to derive your account. Try a different passkey provider.',
  UNSUPPORTED: 'This browser cannot run the passkey features LexAegis needs.',
  WRONG_CREDENTIAL:
    'A different passkey answered than the one this account uses. Try again and choose the original passkey.',
  ADDRESS_MISMATCH:
    'That passkey belongs to a different account than the one remembered here. Choose the original passkey, or forget the remembered account and recover again.',
  SESSION_EXPIRED: 'Signing locked itself after its time limit. Unlock signing to continue.',
  BACKEND_UNAVAILABLE:
    'Your account is unlocked on this device, but the LexAegis server could not be reached, so you are not signed in to it.',
  BACKEND_REJECTED: 'The server did not accept the sign-in. Unlock signing and try again.',
  SCOPE_REJECTED:
    'The server sent a sign-in request LexAegis does not recognise, so nothing was signed. You are not signed in.',
  BUSY: 'A passkey prompt is already open.',
  FAILED: 'The passkey operation failed for a reason the browser did not report.',
  CONFIG_INVALID: 'Accounts are not configured for this address.',
};

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const short = (address: string) => `${address.slice(0, 8)}…${address.slice(-6)}`;

/**
 * Account controls. Each reading is separate on purpose: an unlocked signer is not a backend
 * sign-in, neither opens the vault, and none of them says anything about a receipt on chain.
 */
export function AccountPanel() {
  const { availability, snapshot, commands } = useAccount();
  const vault = useVault();
  const titleId = useId();
  const scopeId = useId();
  const ready = availability === 'available' && commands !== null;
  const waiting = snapshot.ceremony === 'awaiting_passkey';
  const unlocked = snapshot.signing.state === 'unlocked';
  const { account, backend, signing } = snapshot;
  const status =
    availability === 'loading'
      ? 'Checking this browser…'
      : accountStatusLabel(snapshot, availability);

  return (
    <section aria-labelledby={titleId} className="max-w-2xl">
      <h1 id={titleId} className="m-0 text-xl font-medium">
        Account
      </h1>
      <p role="status" aria-live="polite" className="mt-2 flex items-center gap-2 text-[0.9375rem]">
        <Icon name={waiting ? 'loading' : unlocked ? 'key' : 'lock'} className="text-lj-cyan" />
        <span data-testid="account-status">{status}</span>
      </p>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.875rem]">
        <dt className="text-lj-muted">Selected account</dt>
        <dd className="m-0 font-mono" data-testid="account-address" title={account?.address}>
          {account === null ? 'None' : short(account.address)}
          {account !== null && !account.verifiedThisSession
            ? ' (remembered, not yet verified)'
            : ''}
        </dd>
        <dt className="text-lj-muted">Signing session</dt>
        <dd className="m-0" data-testid="signing-state">
          {unlocked && signing.expiresAt !== null
            ? `Unlocked until ${time(signing.expiresAt)}, or after 5 idle minutes`
            : 'Locked'}
        </dd>
        <dt className="text-lj-muted">Server sign-in</dt>
        <dd className="m-0" data-testid="backend-state">
          {backend.state === 'signed_in'
            ? 'Signed in'
            : backend.state === 'signing_in'
              ? 'Signing in…'
              : backend.state === 'unavailable'
                ? 'Server unavailable'
                : backend.state === 'signed_out'
                  ? 'Signed out'
                  : 'Not checked'}
        </dd>
        <dt className="text-lj-muted">Vault</dt>
        <dd className="m-0" data-testid="vault-state">
          {vaultStatusLabel(vault.snapshot, vault.available)}
        </dd>
        <dt className="text-lj-muted">Chain connection</dt>
        <dd className="m-0">See Network and test funds below. It is read separately.</dd>
      </dl>

      <p id={scopeId} className="mt-4 text-[0.875rem] text-lj-secondary">
        Your passkey derives your LexAegis account on this device. The key stays in this tab&apos;s
        memory for at most 10 minutes and is never stored or sent. Unlocking or signing in does not
        approve a review: approval is always a separate, explicit step on an exact package. You can
        recover the same account after clearing this browser, as long as the same passkey is still
        available for this site. A new or different passkey is a different account.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {waiting ? (
          <button type="button" className={button} onClick={() => commands?.cancel()}>
            Cancel
          </button>
        ) : null}
        {!waiting && account === null ? (
          <>
            <button
              type="button"
              className={`${button} bg-lj-soft`}
              disabled={!ready}
              aria-describedby={scopeId}
              onClick={() => void commands?.createAndSignIn()}
            >
              Create account and sign in
            </button>
            <button
              type="button"
              className={button}
              disabled={!ready}
              aria-describedby={scopeId}
              onClick={() => void commands?.recover()}
            >
              Recover account
            </button>
          </>
        ) : null}
        {!waiting && account !== null && !unlocked ? (
          <>
            <button
              type="button"
              className={`${button} bg-lj-soft`}
              disabled={!ready}
              aria-describedby={scopeId}
              onClick={() => void (snapshot.hasHint ? commands?.unlock() : commands?.recover())}
            >
              Unlock signing
            </button>
            <button
              type="button"
              className={button}
              disabled={!ready}
              onClick={() => void commands?.recover()}
            >
              Recover a different account
            </button>
          </>
        ) : null}
        {!waiting && unlocked ? (
          <button type="button" className={button} onClick={() => commands?.lock()}>
            Lock
          </button>
        ) : null}
        {!waiting && (unlocked || backend.state === 'signed_in') ? (
          <button type="button" className={button} onClick={() => void commands?.signOut()}>
            Sign out
          </button>
        ) : null}
        {!waiting && snapshot.hasHint && !unlocked ? (
          <button type="button" className={button} onClick={() => commands?.forgetHint()}>
            Forget remembered account
          </button>
        ) : null}
      </div>

      {waiting ? (
        <p className="mt-2 text-[0.875rem] text-lj-secondary">
          Waiting for your passkey. Cancelling here stops LexAegis waiting; it cannot close the
          browser&apos;s own prompt or remove a passkey the browser has already saved.
        </p>
      ) : null}

      {snapshot.lastError !== null && !waiting ? (
        <p role="alert" className="mt-3 text-[0.875rem] text-lj-error" data-testid="account-error">
          <Icon name="alert" className="mr-2 inline" />
          {GUIDANCE[snapshot.lastError] ?? 'The account action could not be completed.'}
          {snapshot.passkeyMayExist
            ? ' A passkey may have been saved even though setup did not finish; use Recover account rather than creating another.'
            : ''}{' '}
          {snapshot.lastError === 'PRF_UNAVAILABLE' || snapshot.lastError === 'UNSUPPORTED' ? (
            <a className="underline" href={SUPPORT_URL} rel="noreferrer noopener" target="_blank">
              Which passkeys work
            </a>
          ) : null}
        </p>
      ) : null}

      {availability === 'unsupported' ? (
        <p role="alert" className="mt-3 text-[0.875rem] text-lj-error">
          This browser cannot run passkey accounts here.{' '}
          <a className="underline" href={SUPPORT_URL} rel="noreferrer noopener" target="_blank">
            Which passkeys work
          </a>
        </p>
      ) : null}
      {availability === 'misconfigured' ? (
        <p role="alert" className="mt-3 text-[0.875rem] text-lj-error">
          Accounts are not configured for this address, so no passkey prompt will be shown.
        </p>
      ) : null}
    </section>
  );
}
