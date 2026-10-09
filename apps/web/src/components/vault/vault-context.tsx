'use client';

import { createContext, useContext } from 'react';
import {
  EMPTY_VAULT_SNAPSHOT,
  type VaultCommands,
  type VaultHandle,
  type VaultSnapshot,
} from '@/features/vault/public';

interface VaultContextValue {
  readonly available: boolean;
  readonly snapshot: VaultSnapshot;
  readonly commands: VaultCommands | null;
  readonly handle: VaultHandle | null;
}

export const VaultContext = createContext<VaultContextValue>({
  available: false,
  snapshot: EMPTY_VAULT_SNAPSHOT,
  commands: null,
  handle: null,
});

export function useVault(): VaultContextValue {
  return useContext(VaultContext);
}
