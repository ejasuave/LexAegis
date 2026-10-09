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
import type { Focus } from './styles';
import { useVault } from '@/components/vault/vault-context';
import {
  EMPTY_REVIEW_SNAPSHOT,
  createBrowserReview,
  type ReviewController,
  type ReviewSnapshot,
} from '@/features/review/public';

interface ReviewContextValue {
  readonly controller: ReviewController | null;
  readonly snapshot: ReviewSnapshot;
  /** The selected passage, shared by the source viewer, findings and comparison. Cleared with the matter. */
  readonly focus: Focus | null;
  readonly setFocus: (focus: Focus | null) => void;
}

const ReviewContext = createContext<ReviewContextValue>({
  controller: null,
  snapshot: EMPTY_REVIEW_SNAPSHOT,
  focus: null,
  setFocus: () => undefined,
});

const noSubscription = () => () => undefined;
const empty = () => EMPTY_REVIEW_SNAPSHOT;

/**
 * Owns the tab's review controller. It is rebuilt when the vault handle changes and disposed on
 * unmount, which stops its workers. Only a frozen snapshot reaches React state.
 */
export function ReviewProvider({ children }: { children: ReactNode }) {
  const { handle } = useVault();
  const account = useAccount();
  const [controller, setController] = useState<ReviewController | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const addressRef = useRef<string | null>(null);
  const snapshotAccount = account.snapshot.account;
  addressRef.current =
    snapshotAccount?.verifiedThisSession === true ? snapshotAccount.address : null;

  useEffect(() => {
    if (handle === null || !handle.available) {
      setController(null);
      return;
    }
    const created = createBrowserReview(handle, () => addressRef.current);
    setController(created);
    return () => {
      created.dispose();
      setController(null);
    };
  }, [handle]);

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noSubscription,
    controller?.getSnapshot ?? empty,
    empty,
  );
  const matterId = snapshot.matterId;
  useEffect(() => {
    // A different matter, a lock or an account change never keeps a passage selected.
    setFocus(null);
  }, [matterId]);
  return (
    <ReviewContext.Provider value={{ controller, snapshot, focus, setFocus }}>
      {children}
    </ReviewContext.Provider>
  );
}

export function useReview(): ReviewContextValue {
  return useContext(ReviewContext);
}
