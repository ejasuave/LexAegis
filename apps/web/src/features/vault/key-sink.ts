import { VaultKeys } from '@lexaegis/vault';

/**
 * The one trusted consumer of vault PRF bytes. The account controller hands bytes here after an
 * explicit unlock gesture and zeroes them when this returns. The sink imports them as a
 * non-extractable HKDF key and keeps only that handle, which the vault controller takes once.
 */
export class KeySink {
  #pending: VaultKeys | null = null;

  /** Passed to the account controller as its vault consumer. Never exposes bytes or keys to callers. */
  readonly consume = async (prfOutput: Uint8Array): Promise<void> => {
    const imported = await VaultKeys.fromPrf(prfOutput);
    if (!imported.ok) throw new Error('vault key import failed');
    this.#pending?.dispose();
    this.#pending = imported.data;
  };

  /** Hands the key to the vault controller, exactly once. */
  take(): VaultKeys | null {
    const keys = this.#pending;
    this.#pending = null;
    return keys;
  }

  clear(): void {
    this.#pending?.dispose();
    this.#pending = null;
  }
}
