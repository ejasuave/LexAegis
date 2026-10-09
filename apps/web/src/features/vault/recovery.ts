import type { AccountCommands, AccountSnapshot } from '@/features/account/public';
import type { VaultController, VaultFailure, VaultOutcome } from './vault-controller';

/*
 * Empty-browser-storage recovery:
 *   1. Chapter 4 recovers the same existing passkey/account and signs in to the backend.
 *   2. The descriptor and head are discovered from authenticated storage. No cached vault ID or
 *      salt is used.
 *   3. The user explicitly unlocks the vault through the pinned credential and the fixed vault
 *      PRF namespace.
 *   4. The catalog and matter records are authenticated and decrypted; any frozen package is
 *      verified only when requested.
 *
 * Account recovery and vault unlock are separate ceremonies and may each show a prompt: there is
 * no one-prompt guarantee, and a failed step is never retried automatically.
 */

export type RecoveryStep = 'account' | 'discovery' | 'vault';

export type RecoveryResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly step: RecoveryStep;
      readonly failure: VaultFailure | 'ACCOUNT_FAILED';
    };

export async function recoverVaultFromEmptyStorage(
  account: Pick<AccountCommands, 'recover'> & { snapshot(): AccountSnapshot },
  vault: Pick<VaultController, 'refreshDiscovery' | 'recover'>,
): Promise<RecoveryResult> {
  const before = account.snapshot();
  if (
    before.account === null ||
    !before.account.verifiedThisSession ||
    before.backend.state !== 'signed_in'
  ) {
    const recovered = await account.recover();
    if (!recovered.ok) return { ok: false, step: 'account', failure: 'ACCOUNT_FAILED' };
  }
  const found: VaultOutcome<unknown> = await vault.refreshDiscovery();
  if (!found.ok) return { ok: false, step: 'discovery', failure: found.failure };
  const opened = await vault.recover();
  return opened.ok ? { ok: true } : { ok: false, step: 'vault', failure: opened.failure };
}

export interface FailureGuidance {
  readonly title: string;
  readonly next: string;
  readonly retry: boolean;
}

/** Separate, specific outcomes. None of them creates a replacement vault or overwrites ciphertext. */
export function describeVaultFailure(failure: VaultFailure): FailureGuidance {
  const guidance: Record<VaultFailure, FailureGuidance> = {
    STORAGE_UNAVAILABLE: {
      title: 'Storage is unavailable',
      next: 'Your vault was not read, so this does not mean it is empty. Try again later.',
      retry: true,
    },
    NOT_SIGNED_IN: {
      title: 'Not signed in',
      next: 'Sign in to your account first. The vault cannot be read without it.',
      retry: false,
    },
    NO_VAULT: {
      title: 'No vault found for this account',
      next: 'This account has no vault yet. You can create one. If you expected one, check that you used the original passkey.',
      retry: false,
    },
    VAULT_EXISTS: {
      title: 'A vault already exists',
      next: 'Unlock the existing vault. A new one is never created over it.',
      retry: false,
    },
    PRF_UNSUPPORTED: {
      title: 'This passkey cannot unlock the vault',
      next: 'The passkey or device does not provide the PRF feature the vault needs. Try the original passkey on a supported device.',
      retry: false,
    },
    CANCELLED: {
      title: 'The passkey prompt did not finish',
      next: 'Nothing changed. Try again when ready.',
      retry: true,
    },
    WRONG_CREDENTIAL: {
      title: 'A different passkey answered',
      next: 'Choose the passkey this account was created with.',
      retry: true,
    },
    ACCOUNT_MISMATCH: {
      title: 'The vault belongs to a different account',
      next: 'Switch to the account that owns it. Nothing was opened.',
      retry: false,
    },
    UNSUPPORTED_FORMAT: {
      title: 'This data uses a format this version cannot read',
      next: 'Nothing was changed. Use a version of LexAegis that supports it.',
      retry: false,
    },
    MISSING_OBJECTS: {
      title: 'Some stored files are missing',
      next: 'The vault index points at files that storage no longer returns. Nothing was replaced. Contact whoever operates storage.',
      retry: false,
    },
    INTEGRITY_FAILED: {
      title: 'Stored data failed its integrity check',
      next: 'It was not shown and not overwritten. The wrong key, a damaged file or a changed file all look the same here.',
      retry: false,
    },
    ROLLBACK_DETECTED: {
      title: 'Storage returned an older version than you saw before',
      next: 'Nothing was shown as current. Reload; if it persists, storage may have replayed old data.',
      retry: true,
    },
    CONFLICT: {
      title: 'Another device saved first',
      next: 'Your changes are kept here. Reload to see theirs, then reapply yours.',
      retry: false,
    },
    QUOTA: {
      title: 'The vault is full',
      next: 'Storage limits were reached (16 matters, 2,048 objects or 256 MiB, counting unreferenced files). Nothing was removed.',
      retry: false,
    },
    TOO_LARGE: {
      title: 'That is too large',
      next: 'Files are limited to 10 MiB each and notes to 4 KiB. Nothing was truncated.',
      retry: false,
    },
    UNKNOWN_OUTCOME: {
      title: 'It is not certain whether the save finished',
      next: 'Check again: LexAegis will ask storage what it holds before sending anything twice.',
      retry: true,
    },
    LOCKED: { title: 'The vault is locked', next: 'Unlock it with your passkey.', retry: false },
    EXPIRED: {
      title: 'The vault locked itself',
      next: 'It reached its time limit. Unlock it again.',
      retry: false,
    },
    NOT_FOUND: {
      title: 'Not found',
      next: 'That item does not exist in this vault.',
      retry: false,
    },
    INVALID: {
      title: 'That was not accepted',
      next: 'Check the input and try again.',
      retry: false,
    },
    BUSY: {
      title: 'Another vault operation is running',
      next: 'Wait for it to finish.',
      retry: false,
    },
    STALE: {
      title: 'That operation was cancelled',
      next: 'The vault was locked or changed while it ran, so its result was discarded.',
      retry: false,
    },
  };
  return guidance[failure];
}
