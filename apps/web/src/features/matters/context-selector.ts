import { selectContext, type SelectedContext, type VaultResult } from '@lexaegis/vault';
import type { VaultController } from '@/features/vault/vault-controller';

/**
 * The deliberate, matter-scoped selection of confirmed entries a later chapter (the Aegis
 * runtime) may send as context. It reads the decrypted working copy only while the vault is
 * unlocked and returns only the requested confirmed entries and the versions they cite. A
 * selection over 32 KiB fails; it is never truncated and the whole vault is never sent.
 *
 * Choosing to send the result to a provider is a separate disclosure step owned by Chapters 9
 * and 10; this function transmits nothing.
 */
export function selectMatterContext(
  vault: Pick<VaultController, 'workingMatter'>,
  matterId: string,
  entryIds: readonly string[],
): VaultResult<SelectedContext> {
  const record = vault.workingMatter(matterId);
  if (record === null) return { ok: false, code: 'KEY_UNAVAILABLE' };
  return selectContext(record, entryIds);
}
