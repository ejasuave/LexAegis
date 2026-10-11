'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { PublicConfig } from '@/config/public';
import { VaultContext } from '@/components/vault/vault-context';
import {
  EMPTY_SNAPSHOT,
  type AccountAvailability,
  type AccountHandle,
  type AccountCommands,
  type AccountSnapshot,
} from '@/features/account/public';
import {
  EMPTY_VAULT_SNAPSHOT,
  createBrowserWorkspace,
  type Workspace,
} from '@/features/vault/public';

interface AccountContextValue {
  /** "loading" until the browser has built the controller. */
  readonly availability: AccountAvailability | 'loading';
  readonly snapshot: AccountSnapshot;
  readonly commands: AccountCommands | null;
  /** Public values only (chain and registry); never a key or a credential. */
  readonly publicConfig: PublicConfig;
  /** The restricted account handle: public status, commands and the two registry signing stages. */
  readonly handle: AccountHandle | null;
}

const AccountContext = createContext<AccountContextValue>({
  availability: 'loading',
  snapshot: EMPTY_SNAPSHOT,
  commands: null,
  publicConfig: {},
  handle: null,
});

const noSubscription = () => () => undefined;
const emptySnapshot = () => EMPTY_SNAPSHOT;
const emptyVaultSnapshot = () => EMPTY_VAULT_SNAPSHOT;

/**
 * Owns the tab's account and vault. Only public snapshots reach React state; the signer and the
 * vault key stay inside their controllers' private fields. Deliberate pointer and key input
 * refreshes the idle limits; nothing in the background does.
 */
export function AccountProvider({
  config,
  children,
}: {
  config: PublicConfig;
  children: ReactNode;
}) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  // The configuration is a small object of public strings; its content, not its identity, matters.
  const configKey = JSON.stringify(config);

  useEffect(() => {
    const created = createBrowserWorkspace(JSON.parse(configKey) as PublicConfig);
    setWorkspace(created);
    const interact = () => {
      created.account.commands.noteInteraction();
      created.vault.commands.noteInteraction();
    };
    document.addEventListener('pointerdown', interact);
    document.addEventListener('keydown', interact);
    return () => {
      document.removeEventListener('pointerdown', interact);
      document.removeEventListener('keydown', interact);
      created.vault.dispose();
      created.account.dispose();
      setWorkspace(null);
    };
  }, [configKey]);

  const account = workspace?.account ?? null;
  const vault = workspace?.vault ?? null;
  const snapshot = useSyncExternalStore(
    account?.subscribe ?? noSubscription,
    account?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  const vaultSnapshot = useSyncExternalStore(
    vault?.subscribe ?? noSubscription,
    vault?.getSnapshot ?? emptyVaultSnapshot,
    emptyVaultSnapshot,
  );
  return (
    <AccountContext.Provider
      value={{
        availability: account?.availability ?? 'loading',
        snapshot,
        commands: account?.commands ?? null,
        publicConfig: config,
        handle: account,
      }}
    >
      <VaultContext.Provider
        value={{
          available: vault?.available ?? false,
          snapshot: vaultSnapshot,
          commands: vault?.commands ?? null,
          handle: vault,
        }}
      >
        {children}
      </VaultContext.Provider>
    </AccountContext.Provider>
  );
}

export function useAccount(): AccountContextValue {
  return useContext(AccountContext);
}
