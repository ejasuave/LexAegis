'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useAccount } from '@/components/account/account-context';
import { useVault } from '@/components/vault/vault-context';
import type { HistoryHealth } from '@/domain/history/response';
import {
  HistoryController,
  createHistoryApi,
  type HistoryApi,
  type HistoryViewState,
} from '@/features/history/public';

interface HistoryContextValue {
  readonly state: HistoryViewState;
  readonly controller: HistoryController | null;
  /** Index health independent of any reviewer, for the system strip. */
  readonly health: HistoryHealth | null;
  /**
   * Private label for a public commitment, from the unlocked vault only, in memory only.
   * Null when the vault is locked or no frozen review of the selected matter matches.
   */
  readonly labelFor: (commitment: string, reviewer: string) => string | null;
}

const EMPTY: HistoryViewState = {
  reviewer: null,
  list: 'idle',
  health: null,
  items: [],
  nextCursor: null,
  anchorNonce: null,
  empty: false,
  selected: null,
  detail: null,
  detailState: 'idle',
  watching: false,
  announcement: '',
};

const HistoryContext = createContext<HistoryContextValue>({
  state: EMPTY,
  controller: null,
  health: null,
  labelFor: () => null,
});

const emptySnapshot = () => EMPTY;

export function HistoryProvider({
  children,
  api,
}: {
  children: ReactNode;
  /** Test seam; production uses the browser client. */
  api?: HistoryApi;
}) {
  const { snapshot } = useAccount();
  const vault = useVault();
  const [controller] = useState(() => new HistoryController(api ?? createHistoryApi()));
  const [health, setHealth] = useState<HistoryHealth | null>(null);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, emptySnapshot);

  const reviewer = snapshot.account?.address.toLowerCase() ?? null;
  const [accountReviewer, setAccountReviewer] = useState<string | null>(null);
  useEffect(() => {
    // Account switch or sign-out: everything shown for the previous account is discarded. A
    // reviewer address typed into the lookup box is public and is left alone until then.
    if (reviewer === accountReviewer) return;
    setAccountReviewer(reviewer);
    controller.setReviewer(reviewer);
  }, [controller, reviewer, accountReviewer]);

  const unlocked = vault.snapshot.state === 'unlocked';
  useEffect(() => {
    // Lock drops the selection; private labels are never stored, only derived while unlocked.
    if (!unlocked) void controller.select(null);
  }, [controller, unlocked]);

  const generation = state.health?.index?.generation ?? null;
  const [seenGeneration, setSeenGeneration] = useState<string | null>(null);
  useEffect(() => {
    if (generation === null || generation === seenGeneration) return;
    setSeenGeneration(generation);
    // A rebuilt index invalidates every cursor, selection and shown row.
    if (seenGeneration !== null) {
      controller.clear();
      void controller.refresh();
    }
  }, [controller, generation, seenGeneration]);

  useEffect(() => {
    const onVisibility = () => controller.setPaused(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    const abort = new AbortController();
    const client = api ?? createHistoryApi();
    void client.status(abort.signal).then((result) => {
      if (abort.signal.aborted) return;
      setHealth(
        result.kind === 'ok' ? result.value : result.kind === 'unavailable' ? result.health : null,
      );
    });
    return () => abort.abort();
  }, [api]);

  const matter = unlocked ? vault.snapshot.selectedMatter : null;
  const labelFor = useMemo(
    () => (commitment: string, rowReviewer: string) => {
      if (matter === null || rowReviewer !== reviewer) return null;
      return matter.frozenReviews.some((item) => item.commitment === commitment)
        ? matter.title
        : null;
    },
    [matter, reviewer],
  );

  const value = useMemo(
    () => ({ state, controller, health: state.health ?? health, labelFor }),
    [state, controller, health, labelFor],
  );
  return <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>;
}

export function useHistory(): HistoryContextValue {
  return useContext(HistoryContext);
}
