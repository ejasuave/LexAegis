'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useAccount } from '@/components/account/account-context';
import { useVault } from '@/components/vault/vault-context';
import {
  EMPTY_PACKAGE_SNAPSHOT,
  PackageController,
  type PackageSnapshot,
} from '@/features/review/public';
import { useDecisions } from './decision-context';
import { useReview } from './review-context';

interface PackageContextValue {
  readonly controller: PackageController | null;
  readonly snapshot: PackageSnapshot;
}

const PackageContext = createContext<PackageContextValue>({
  controller: null,
  snapshot: EMPTY_PACKAGE_SNAPSHOT,
});

const noSubscription = () => () => undefined;
const empty = () => EMPTY_PACKAGE_SNAPSHOT;

/** Owns the tab's package controller. It drops every private capture on lock or matter change. */
export function PackageProvider({ children }: { children: ReactNode }) {
  const { controller: review } = useReview();
  const { controller: decisions } = useDecisions();
  const { handle } = useVault();
  const account = useAccount();
  const [controller, setController] = useState<PackageController | null>(null);
  const addressRef = useRef<string | null>(null);
  const current = account.snapshot.account;
  addressRef.current =
    current?.verifiedThisSession === true && account.snapshot.signing.state === 'unlocked'
      ? current.address
      : null;
  const configRef = useRef(account.publicConfig);
  configRef.current = account.publicConfig;

  useEffect(() => {
    if (review === null || decisions === null || handle === null || !handle.available) {
      setController(null);
      return;
    }
    const created = new PackageController({
      review,
      decisions,
      vault: {
        getSnapshot: () => {
          const snapshot = handle.getSnapshot();
          return { generation: snapshot.generation, selectedMatterId: snapshot.selectedMatterId };
        },
        subscribe: handle.subscribe,
        commands: handle.commands,
        recoverableSubject: (commitment) => handle.recoverableSubject(commitment),
      },
      account: () => addressRef.current,
      config: () => ({
        chainId: configRef.current.chainId ?? '',
        registryAddress: configRef.current.registryAddress?.toLowerCase() ?? null,
      }),
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
    });
    setController(created);
    return () => {
      created.dispose();
      setController(null);
    };
  }, [review, decisions, handle]);

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noSubscription,
    controller?.getSnapshot ?? empty,
    empty,
  );
  return (
    <PackageContext.Provider value={{ controller, snapshot }}>{children}</PackageContext.Provider>
  );
}

export function usePackage(): PackageContextValue {
  return useContext(PackageContext);
}
