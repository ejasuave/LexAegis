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
  ApprovalController,
  EMPTY_APPROVAL_SNAPSHOT,
  type ApprovalSnapshot,
} from '@/features/review/public';
import { createLiveStateReader } from '@/features/transactions/public';

interface ApprovalContextValue {
  readonly controller: ApprovalController | null;
  readonly snapshot: ApprovalSnapshot;
}

const ApprovalContext = createContext<ApprovalContextValue>({
  controller: null,
  snapshot: EMPTY_APPROVAL_SNAPSHOT,
});

const noSubscription = () => () => undefined;
const empty = () => EMPTY_APPROVAL_SNAPSHOT;

/** Owns the tab's approval controller, the only code that binds the review gate. */
export function ApprovalProvider({ children }: { children: ReactNode }) {
  const account = useAccount();
  const { handle: vault } = useVault();
  const [controller, setController] = useState<ApprovalController | null>(null);
  const configRef = useRef(account.publicConfig);
  configRef.current = account.publicConfig;
  const accountHandle = account.handle;

  useEffect(() => {
    if (accountHandle === null || vault === null || !vault.available) {
      setController(null);
      return;
    }
    const created = new ApprovalController({
      review: {
        preview: (request) => accountHandle.review.preview(request),
        confirm: (ticket, request) => accountHandle.review.confirm(ticket, request),
        owns: (signed) => accountHandle.review.owns(signed),
        invalidateAll: () => accountHandle.review.invalidateAll(),
      },
      bindGate: (check) => accountHandle.bindReviewGate(check),
      account: () => {
        const s = accountHandle.getSnapshot();
        return {
          address: s.account?.verifiedThisSession === true ? s.account.address : null,
          generation: s.generation,
          signing: s.signing.state,
          backend: s.backend.state,
        };
      },
      onAccountChange: (listener) => accountHandle.subscribe(listener),
      vault: {
        getSnapshot: () => ({ generation: vault.getSnapshot().generation }),
        subscribe: (listener) => vault.subscribe(listener),
        recoverableSubject: (commitment) => vault.recoverableSubject(commitment),
      },
      config: () => ({
        chainId: configRef.current.chainId ?? '',
        registryAddress: configRef.current.registryAddress?.toLowerCase() ?? null,
      }),
      live: createLiveStateReader(),
      now: () => Date.now(),
    });
    setController(created);
    return () => {
      created.dispose();
      setController(null);
    };
  }, [accountHandle, vault]);

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noSubscription,
    controller?.getSnapshot ?? empty,
    empty,
  );
  return (
    <ApprovalContext.Provider value={{ controller, snapshot }}>{children}</ApprovalContext.Provider>
  );
}

export function useApproval(): ApprovalContextValue {
  return useContext(ApprovalContext);
}
