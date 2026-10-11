'use client';

import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import { useAssistant } from '@/components/assistant/assistant-context';
import { useTransaction } from '@/components/chain/transaction-context';
import { useApproval } from '@/components/review/approval-context';
import {
  anythingToStop,
  stopAll,
  type StopPorts,
  type StopReport,
} from '@/features/workspace/stop';

interface StopContextValue {
  /** Voice and read-aloud controllers register their own ports here. */
  readonly register: (
    name: 'voice' | 'readAloud',
    port: StopPorts['voice'] | StopPorts['readAloud'] | null,
  ) => void;
  readonly stop: () => StopReport;
  readonly canStop: () => boolean;
}

const StopContext = createContext<StopContextValue | null>(null);

/** Builds the one Stop from the live controllers. It reads state at call time, never a stale copy. */
export function StopProvider({ children }: { children: ReactNode }) {
  const assistant = useAssistant();
  const approval = useApproval();
  const transaction = useTransaction();
  const extra = useRef<Pick<StopPorts, 'voice' | 'readAloud'>>({});
  const latest = useRef({ assistant, approval, transaction });
  latest.current = { assistant, approval, transaction };

  const ports = useCallback((): StopPorts => {
    const { assistant: a, approval: ap, transaction: t } = latest.current;
    return {
      assistant: {
        active: () => a.snapshot.phase === 'running' || a.snapshot.phase === 'preview',
        stop: () => void a.controller?.stop(),
      },
      approval: {
        stage: () => ap.snapshot.stage,
        cancelPreview: () => ap.controller?.cancelPreview(),
      },
      transaction: {
        state: () => ({ stage: t.state.stage, mayHaveBroadcast: t.state.mayHaveBroadcast }),
        cancel: () => t.controller?.cancel(),
      },
      ...extra.current,
    };
  }, []);

  const value = useMemo<StopContextValue>(
    () => ({
      register: (name, port) => {
        if (name === 'voice')
          extra.current = { ...extra.current, voice: port as StopPorts['voice'] };
        else extra.current = { ...extra.current, readAloud: port as StopPorts['readAloud'] };
      },
      stop: () => stopAll(ports()),
      canStop: () => anythingToStop(ports()),
    }),
    [ports],
  );
  return <StopContext.Provider value={value}>{children}</StopContext.Provider>;
}

export function useStop(): StopContextValue {
  const value = useContext(StopContext);
  if (value === null) throw new Error('useStop must be used inside StopProvider');
  return value;
}
