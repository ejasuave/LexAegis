'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useAccount } from '@/components/account/account-context';
import { useAssistant } from '@/components/assistant/assistant-context';
import { operationName } from '@/components/assistant/orb-state';
import { useTransaction } from '@/components/chain/transaction-context';
import { useHistory } from '@/components/history/history-context';
import { useDecisions } from '@/components/review/decision-context';
import { useReview } from '@/components/review/review-context';
import { useVault } from '@/components/vault/vault-context';
import { vaultStatusLabel } from '@/components/vault/status';
import type { RunView } from '@/features/assistant/public';
import {
  selectHud,
  type ActiveRunInput,
  type HudInput,
  type HudView,
  type IndexerInput,
} from '@/features/hud/public';

/** Ages and expiries tick on a local clock; no block number or lock flag does. */
const CLOCK_TICK_MS = 10_000;

interface HudContextValue {
  /** The one accepted view model. The DOM and the canvas both read it. */
  readonly view: HudView;
  readonly nowMs: number;
  /** Finding rows currently rendered in the viewport; the canvas may end branches at them. */
  readonly setVisibleFindingIds: (ids: readonly string[]) => void;
}

const HudContext = createContext<HudContextValue | null>(null);

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, CLOCK_TICK_MS);
    // A hidden tab pauses its timers; refresh the moment it is visible again.
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return now;
}

function toActiveRun(run: RunView | null, lastEventAtMs: number | null): ActiveRunInput | null {
  if (run === null) return null;
  const steps = run.plan?.steps ?? null;
  return {
    state: run.state,
    toolsStarted: run.toolsStarted.length,
    toolsFinished: run.tools.length,
    stepsCompleted: steps === null ? 0 : steps.filter((s) => s.status === 'completed').length,
    stepsTotal: steps === null ? null : steps.length,
    operation: operationName(run.intent),
    outOfDate: run.stale,
    failureMessage: run.failure?.message ?? null,
    lastEventAtMs,
  };
}

/**
 * Collects each controller's own snapshot into the pure selector input. It adds nothing: it
 * reads, never writes, and holds only presentation facts such as which finding rows are on screen.
 */
export function HudProvider({
  networkLabel,
  chainId,
  children,
}: {
  networkLabel: string;
  chainId: string | null;
  children: ReactNode;
}) {
  const { availability, snapshot: account } = useAccount();
  const vault = useVault();
  const history = useHistory();
  const review = useReview().snapshot;
  const transaction = useTransaction().state;
  const assistant = useAssistant().snapshot;
  const decisions = useDecisions().snapshot;
  const nowMs = useNow();
  const [visible, setVisible] = useState<readonly string[]>([]);
  const setVisibleFindingIds = useCallback((ids: readonly string[]) => {
    setVisible((previous) =>
      previous.length === ids.length && previous.every((id, i) => id === ids[i]) ? previous : ids,
    );
  }, []);

  const activeRun =
    assistant.conversation.find((item) => item.run?.id === assistant.activeRunViewId)?.run ?? null;
  // Arrival time of the last change to the active run. The run's start is the floor.
  const [arrival, setArrival] = useState<{ run: RunView | null; at: number } | null>(null);
  useEffect(() => {
    setArrival(activeRun === null ? null : { run: activeRun, at: Date.now() });
  }, [activeRun]);
  const lastEventAtMs =
    activeRun === null
      ? null
      : arrival?.run === activeRun
        ? arrival.at
        : Date.parse(activeRun.startedAt) || null;

  const unlocked = vault.snapshot.state === 'unlocked' || vault.snapshot.state === 'saving';
  const health = history.health;
  const indexer: IndexerInput | null =
    health === null
      ? null
      : {
          availability: health.availability,
          freshness: health.freshness,
          indexConsistency: health.indexConsistency,
          observedAtMs: Date.parse(health.observedAt) || null,
          indexedBlock: health.index?.progressBlock ?? null,
          sourceLag: health.lag.sourceLag,
          confirmedLag: health.lag.confirmedLag,
        };

  const input: HudInput = {
    ceiling: {
      nowMs,
      matterTitle: vault.snapshot.selectedMatter?.title ?? null,
      selectedVersionIds: review.documents
        .filter((doc) => doc.selected)
        .map((doc) => doc.documentVersionId),
      networkLabel,
      chainId,
      account: {
        availability,
        ceremony: account.ceremony,
        address: account.account?.address ?? null,
        signing: account.signing.state,
        signingExpiresAtMs: account.signing.expiresAt,
        lastEvent: account.lastEvent,
        backend: account.backend.state,
      },
      vaultLabel: vaultStatusLabel(vault.snapshot, vault.available),
      transaction: { stage: transaction.stage, mayHaveBroadcast: transaction.mayHaveBroadcast },
      indexer,
    },
    assistant: {
      phase: assistant.phase,
      orb: assistant.orb,
      availability: assistant.availabilityStatus,
      activeRun: toActiveRun(activeRun, lastEventAtMs),
    },
    findings: decisions.findings.map((item) => ({
      id: item.finding.findingId,
      state: item.finding.state,
      resolved: item.disposition !== null,
      visible: visible.includes(item.finding.findingId),
      selected: false,
    })),
    vaultUnlocked: unlocked,
    matterSelected: vault.snapshot.selectedMatterId !== null,
  };

  // Keep the previous view while nothing visible changed, so the canvas is not woken by renders.
  const computed = selectHud(input);
  const [view, setView] = useState(computed);
  const same = JSON.stringify(view) === JSON.stringify(computed);
  useEffect(() => {
    if (!same) setView(computed);
  }, [same, computed]);
  const value = useMemo<HudContextValue>(
    () => ({ view, nowMs, setVisibleFindingIds }),
    [view, nowMs, setVisibleFindingIds],
  );
  return <HudContext.Provider value={value}>{children}</HudContext.Provider>;
}

export function useHud(): HudContextValue {
  const value = useContext(HudContext);
  if (value === null) throw new Error('useHud must be used inside HudProvider');
  return value;
}
