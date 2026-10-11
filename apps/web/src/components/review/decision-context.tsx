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
  DecisionController,
  EMPTY_DECISION_SNAPSHOT,
  type DecisionSnapshot,
} from '@/features/review/public';
import { useReview } from './review-context';

interface DecisionContextValue {
  readonly controller: DecisionController | null;
  readonly snapshot: DecisionSnapshot;
}

const DecisionContext = createContext<DecisionContextValue>({
  controller: null,
  snapshot: EMPTY_DECISION_SNAPSHOT,
});

const noSubscription = () => () => undefined;
const empty = () => EMPTY_DECISION_SNAPSHOT;

/** Owns the tab's decision controller. Rebuilt with the review controller; disposed on unmount. */
export function DecisionProvider({ children }: { children: ReactNode }) {
  const { controller: review } = useReview();
  const { handle } = useVault();
  const account = useAccount();
  const [controller, setController] = useState<DecisionController | null>(null);
  const addressRef = useRef<string | null>(null);
  const current = account.snapshot.account;
  addressRef.current =
    current?.verifiedThisSession === true && account.snapshot.signing.state === 'unlocked'
      ? current.address
      : null;

  useEffect(() => {
    if (review === null || handle === null || !handle.available) {
      setController(null);
      return;
    }
    const created = new DecisionController({
      review,
      vault: handle,
      account: () => addressRef.current,
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
    });
    setController(created);
    return () => {
      created.dispose();
      setController(null);
    };
  }, [review, handle]);

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noSubscription,
    controller?.getSnapshot ?? empty,
    empty,
  );
  return (
    <DecisionContext.Provider value={{ controller, snapshot }}>{children}</DecisionContext.Provider>
  );
}

export function useDecisions(): DecisionContextValue {
  return useContext(DecisionContext);
}
