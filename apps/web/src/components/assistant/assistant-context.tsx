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
import { useReview } from '@/components/review/review-context';
import { useVault } from '@/components/vault/vault-context';
import {
  EMPTY_ASSISTANT_SNAPSHOT,
  createBrowserAssistant,
  type AssistantController,
  type AssistantSnapshot,
} from '@/features/assistant/public';

interface AssistantContextValue {
  readonly controller: AssistantController | null;
  readonly snapshot: AssistantSnapshot;
}

const AssistantContext = createContext<AssistantContextValue>({
  controller: null,
  snapshot: EMPTY_ASSISTANT_SNAPSHOT,
});

const noSubscription = () => () => undefined;
const empty = () => EMPTY_ASSISTANT_SNAPSHOT;

/**
 * Owns the tab's assistant controller. It is rebuilt when the review controller changes and
 * disposed on unmount, which abandons any run. Only a frozen snapshot reaches React state, and
 * the conversation lives in memory only.
 */
export function AssistantProvider({ children }: { children: ReactNode }) {
  const { controller: review } = useReview();
  const { handle } = useVault();
  const account = useAccount();
  const [controller, setController] = useState<AssistantController | null>(null);
  const accountRef = useRef({ present: false, unlocked: false });
  accountRef.current = {
    present: account.snapshot.account !== null,
    unlocked: account.snapshot.signing.state === 'unlocked',
  };
  const signedIn = account.snapshot.backend.state === 'signed_in';

  useEffect(() => {
    if (review === null || handle === null) {
      setController(null);
      return;
    }
    const created = createBrowserAssistant(review, handle, () => accountRef.current);
    setController(created);
    return () => {
      created.dispose();
      setController(null);
    };
  }, [review, handle]);

  useEffect(() => {
    // Which provider a request would reach is asked again whenever the server sign-in changes.
    void controller?.refreshAvailability();
  }, [controller, signedIn]);

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noSubscription,
    controller?.getSnapshot ?? empty,
    empty,
  );
  return (
    <AssistantContext.Provider value={{ controller, snapshot }}>
      {children}
    </AssistantContext.Provider>
  );
}

export function useAssistant(): AssistantContextValue {
  return useContext(AssistantContext);
}
