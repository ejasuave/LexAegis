'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useAccount } from '@/components/account/account-context';
import { useApproval } from '@/components/review/approval-context';
import {
  TransactionController,
  createChainApi,
  type TransactionState,
} from '@/features/transactions/public';

interface TransactionContextValue {
  readonly controller: TransactionController | null;
  readonly state: TransactionState;
}

const INITIAL: TransactionState = Object.freeze({
  stage: 'idle',
  operation: null,
  preview: null,
  reason: null,
  mayHaveBroadcast: false,
  quote: null,
});

const TransactionContext = createContext<TransactionContextValue>({
  controller: null,
  state: INITIAL,
});

const noSubscription = () => () => undefined;
const empty = () => INITIAL;

/**
 * Owns the tab's submission controller. It is the only recipient of the stage-one signature: when
 * an approval is signed, the approval controller hands the authorisation here once, and the
 * controller asks the server for an exact signed-calldata simulation and fee quote. Nothing is
 * sent until the separate Send transaction confirmation.
 */
export function TransactionProvider({ children }: { children: ReactNode }) {
  const { handle } = useAccount();
  const approval = useApproval();
  const [controller, setController] = useState<TransactionController | null>(null);

  useEffect(() => {
    if (handle === null) {
      setController(null);
      return;
    }
    const created = new TransactionController({
      api: createChainApi(),
      signing: handle.transactions,
      newIdempotencyKey: () => crypto.randomUUID(),
    });
    const off = handle.onLock(() => created.onAccountLost());
    setController(created);
    return () => {
      off();
      setController(null);
    };
  }, [handle]);

  useEffect(() => {
    // The one hand-off: a signed approval goes to the submission controller, once.
    if (controller === null || approval.controller === null || approval.snapshot.stage !== 'signed')
      return;
    const authorisation = approval.controller.takeAuthorisation();
    if (authorisation !== null) void controller.begin(authorisation.request, authorisation.signed);
  }, [controller, approval.controller, approval.snapshot.stage]);

  const state = useSyncExternalStore(
    controller?.subscribe ?? noSubscription,
    controller?.getSnapshot ?? empty,
    empty,
  );
  return (
    <TransactionContext.Provider value={{ controller, state }}>
      {children}
    </TransactionContext.Provider>
  );
}

export function useTransaction(): TransactionContextValue {
  return useContext(TransactionContext);
}
