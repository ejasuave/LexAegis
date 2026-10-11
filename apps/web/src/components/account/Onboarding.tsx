'use client';

import { useAccount } from './account-context';

const button =
  'min-h-11 rounded border border-lj-edge px-4 text-[0.875rem] aria-disabled:text-lj-muted';

/** Shown only while there is no account. Two actions, no seed phrase, wallet extension, email or OTP. */
export function Onboarding() {
  const { availability, snapshot, commands } = useAccount();
  if (snapshot.account !== null) return null;
  const ready = availability === 'available' && commands !== null && snapshot.ceremony === 'idle';
  return (
    <section aria-label="Get started" className="lj-card p-4">
      <h2 className="m-0 text-lg font-medium">Get started</h2>
      <p className="m-0 mt-1 text-[0.875rem] text-lj-secondary">
        Your account is made from a passkey on this device. Saved work stays encrypted.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={`${button} lj-action`}
          aria-disabled={!ready}
          onClick={() => ready && void commands?.createAndSignIn()}
        >
          Create account
        </button>
        <button
          type="button"
          className={button}
          aria-disabled={!ready}
          onClick={() => ready && void commands?.recover()}
        >
          Use existing passkey
        </button>
      </div>
      {availability === 'unsupported' ? (
        <p className="m-0 mt-2 text-[0.875rem] text-lj-amber">
          This browser or device cannot create the passkey LexAegis needs. Text review of local
          checks still works.
        </p>
      ) : null}
    </section>
  );
}
