import type { VaultSnapshot } from '@/features/vault/public';

export type VaultStatusLabel =
  | 'Vault unavailable'
  | 'Awaiting passkey'
  | 'Unlocking vault'
  | 'Saving encrypted files'
  | 'Checking saved package'
  | 'Recovery failed'
  | 'Conflict'
  | 'Unsaved changes'
  | 'Saved'
  | 'Unlocked'
  | 'Locked';

/** One honest label for the vault, derived only from real controller events. It never implies AI activity, approval or a receipt. */
export function vaultStatusLabel(snapshot: VaultSnapshot, available: boolean): VaultStatusLabel {
  if (!available || snapshot.state === 'unavailable') return 'Vault unavailable';
  if (snapshot.progress === 'awaiting_passkey') return 'Awaiting passkey';
  if (snapshot.progress === 'unlocking') return 'Unlocking vault';
  if (snapshot.progress === 'saving_files') return 'Saving encrypted files';
  if (snapshot.progress === 'checking_package') return 'Checking saved package';
  if (snapshot.progress === 'recovery_failed') return 'Recovery failed';
  if (snapshot.state === 'locked' || snapshot.state === 'error') return 'Locked';
  if (snapshot.save === 'conflict') return 'Conflict';
  if (snapshot.save === 'unsaved' || snapshot.save === 'unknown_outcome') return 'Unsaved changes';
  if (snapshot.save === 'saved') return 'Saved';
  return 'Unlocked';
}
