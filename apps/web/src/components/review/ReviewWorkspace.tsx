'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AssistantOrb } from '@/components/assistant/AssistantOrb';
import { CommandActions } from '@/components/assistant/CommandActions';
import { orbForActivity } from '@/components/assistant/orb-state';
import { useAssistant } from '@/components/assistant/assistant-context';
import { ConversationPanel } from '@/components/assistant/ConversationPanel';
import { AttentionRail } from '@/components/hud/AttentionRail';
import { useHud } from '@/components/hud/hud-context';
import { useLayoutTier } from '@/components/hud/layout-tier';
import { MatterRail } from '@/components/hud/MatterRail';
import { StateNotices } from '@/components/hud/StateNotices';
import { useReview } from './review-context';
import { useVault } from '@/components/vault/vault-context';
import { vaultStatusLabel } from '@/components/vault/status';
import {
  useWorkspace,
  type MobileTab,
  type PresentationMode,
} from '@/components/shell/workspace-context';
import { ReviewDocuments } from './DocumentWorkspace';

const MODES: { id: PresentationMode; label: string }[] = [
  { id: 'command', label: 'Command centre' },
  { id: 'review', label: 'Review' },
];

const TABS: { id: MobileTab; label: string }[] = [
  { id: 'matter', label: 'Matter' },
  { id: 'document', label: 'Document' },
  { id: 'findings', label: 'Findings' },
  { id: 'activity', label: 'Activity' },
];

const sectionTitle = 'm-0 text-lg font-medium';
const muted = 'm-0 mt-2 text-[0.875rem] text-lj-secondary';

/** The vault's real progress, in text. It never describes AI activity, an approval or a receipt. */
function VaultStatusLine() {
  const { snapshot, available } = useVault();
  return (
    <p className="m-0 mt-2 text-[0.8125rem] text-lj-secondary" role="status" aria-live="polite">
      Vault: {vaultStatusLabel(snapshot, available)}
    </p>
  );
}

/** Command mode: the nucleus with one plain-language status sentence beneath it. */
function CommandHero() {
  const { view } = useHud();
  const vault = useVault();
  return (
    <div className="lj-hero">
      <div className="flex flex-col items-center">
        <AssistantOrb state={orbForActivity(view.activity)} size="expanded" />
        <div data-hud-quiet="" className="flex flex-col items-center">
          <p
            role="status"
            aria-live="polite"
            className="m-0 mt-4 text-lg"
            data-testid="orb-caption"
          >
            {vault.snapshot.selectedMatterId === null
              ? 'Open a matter to begin.'
              : view.activity.statusText}
          </p>
          <CommandActions />
          <VaultStatusLine />
        </div>
      </div>
    </div>
  );
}

/** Actual task steps and the transcript: typographic sections with hairlines, never tiles. */
function ActivitySurface() {
  const { snapshot } = useAssistant();
  const active = snapshot.conversation.find(
    (item) => item.run?.id === snapshot.activeRunViewId,
  )?.run;
  return (
    <div className="mx-auto w-full max-w-xl text-left" data-hud-quiet="">
      <section aria-label="Task steps" className="lj-rule pt-3">
        <h2 className={sectionTitle}>Task steps</h2>
        {active?.plan == null ? (
          <p className={muted}>No task is running.</p>
        ) : (
          <ol className="m-0 mt-2 list-none p-0 text-[0.875rem] leading-[1.375rem]">
            {active.plan.steps.map((step) => (
              <li key={step.stepId}>
                <span className="text-lj-muted">{step.status}: </span>
                {step.label}
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-label="Conversation" className="lj-rule mt-5 pt-3">
        <h2 className={sectionTitle}>Conversation</h2>
        <ConversationPanel />
      </section>
    </div>
  );
}

/**
 * Review mode keeps the transcript one disclosure away. It opens by itself whenever the
 * assistant needs the reviewer (a disclosure to approve sending, a running task) or a message
 * arrives, so a consent step can never sit hidden behind a closed section.
 */
function ReviewTranscript({ forceOpen }: { forceOpen: boolean }) {
  const { snapshot } = useAssistant();
  const [userOpen, setUserOpen] = useState(false);
  const count = snapshot.conversation.length;
  useEffect(() => {
    if (count > 0) setUserOpen(true);
  }, [count]);
  const needsYou = snapshot.pending !== null || snapshot.phase !== 'idle';
  return (
    <details
      className="lj-rule mt-4 pt-2"
      open={forceOpen || needsYou || userOpen}
      onToggle={(event) => setUserOpen(event.currentTarget.open)}
    >
      <summary className="inline-flex min-h-11 cursor-pointer items-center text-[0.875rem]">
        Assistant transcript
      </summary>
      <ActivitySurface />
    </details>
  );
}

/** Review mode: the document is dominant and the nucleus shrinks to a status marker. */
function ReviewSurface() {
  const { view } = useHud();
  return (
    <section aria-label="Document" className="min-w-0" data-hud-quiet="">
      <div className="flex items-center justify-between border-b border-lj-divider pb-2">
        <h2 className={sectionTitle}>Document</h2>
        <AssistantOrb
          state={orbForActivity(view.activity)}
          size="compact"
          label={view.activity.statusText}
        />
      </div>
      <VaultStatusLine />
      <ReviewDocuments />
    </section>
  );
}

/** Moves between tabs with the arrow keys, as the tabs pattern requires. */
function onTabKey(
  event: KeyboardEvent<HTMLButtonElement>,
  current: MobileTab,
  set: (t: MobileTab) => void,
) {
  const index = TABS.findIndex((tab) => tab.id === current);
  const next =
    event.key === 'ArrowRight'
      ? TABS[(index + 1) % TABS.length]
      : event.key === 'ArrowLeft'
        ? TABS[(index + TABS.length - 1) % TABS.length]
        : event.key === 'Home'
          ? TABS[0]
          : event.key === 'End'
            ? TABS[TABS.length - 1]
            : undefined;
  if (next === undefined) return;
  event.preventDefault();
  set(next.id);
  document.getElementById(`lj-tab-${next.id}`)?.focus();
}

/**
 * Command-centre and Review modes share one selection and one draft (held in WorkspaceProvider).
 * Three zones on wide screens; below 800 px one labelled surface at a time.
 */
export function ReviewWorkspace() {
  const { mode, setMode, adoptDefaultMode, mobileTab, setMobileTab, selection } = useWorkspace();
  const hasActiveDocument = useReview().snapshot.documents.some((doc) => doc.selected);
  // A workspace with an active document opens in Review; an empty one stays in Command mode.
  // An explicit choice by the reviewer is never overridden.
  useEffect(() => {
    if (hasActiveDocument) adoptDefaultMode('review');
  }, [hasActiveDocument, adoptDefaultMode]);
  // Each mode remembers where the stage was scrolled, so switching back finds the same place.
  const stage = useRef<HTMLElement | null>(null);
  const scrolled = useRef<Record<PresentationMode, number>>({ command: 0, review: 0 });
  const shown = useRef(mode);
  useLayoutEffect(() => {
    if (shown.current === mode) return;
    shown.current = mode;
    if (stage.current !== null) stage.current.scrollTop = scrolled.current[mode];
  }, [mode]);
  const tier = useLayoutTier();
  const ids = useId();
  const active = (tab: MobileTab) => mobileTab === tab;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="m-0 text-xl font-medium">Review</h1>
        <div role="group" aria-label="Presentation mode" className="flex gap-1">
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={mode === item.id}
              onClick={() => setMode(item.id)}
              className={`min-h-11 rounded border px-4 text-[0.875rem] ${
                mode === item.id
                  ? 'border-lj-cyan text-lj-text'
                  : 'border-lj-edge text-lj-secondary'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div role="tablist" aria-label="Workspace sections" className="lj-tabs flex flex-wrap gap-1">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            id={`lj-tab-${tab.id}`}
            data-hud-findings-control={tab.id === 'findings' ? '' : undefined}
            type="button"
            role="tab"
            aria-selected={mobileTab === tab.id}
            aria-controls={`${ids}-${tab.id}`}
            tabIndex={mobileTab === tab.id ? 0 : -1}
            onClick={() => setMobileTab(tab.id)}
            onKeyDown={(event) => onTabKey(event, mobileTab, setMobileTab)}
            className={`min-h-11 min-w-[5.5rem] flex-1 rounded border px-3 text-[0.875rem] ${
              mobileTab === tab.id
                ? 'border-lj-cyan text-lj-text'
                : 'border-lj-edge text-lj-secondary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <StateNotices />

      <p className="sr-only" aria-live="polite">
        {selection.matterId ? 'Matter selected.' : 'No matter selected.'}
      </p>

      <div className="lj-workbench min-h-0 flex-1">
        <aside
          id={`${ids}-matter`}
          aria-label="Matter"
          className="lj-rail-left lj-surface"
          data-active={active('matter')}
        >
          {tier === 'medium' ? (
            <details>
              <summary className="inline-flex min-h-11 cursor-pointer items-center text-[0.875rem]">
                Matter, documents and evidence
              </summary>
              <MatterRail />
            </details>
          ) : (
            <MatterRail />
          )}
        </aside>
        <section
          aria-label="Work"
          className="min-w-0"
          ref={stage}
          onScroll={(event) => {
            scrolled.current[shown.current] = event.currentTarget.scrollTop;
          }}
        >
          <div id={`${ids}-document`} className="lj-surface" data-active={active('document')}>
            {mode === 'command' ? <CommandHero /> : <ReviewSurface />}
          </div>
          <div id={`${ids}-activity`} className="lj-surface" data-active={active('activity')}>
            {mode === 'command' ? (
              <ActivitySurface />
            ) : (
              <ReviewTranscript forceOpen={mobileTab === 'activity'} />
            )}
          </div>
        </section>
        <aside
          id={`${ids}-findings`}
          aria-label="Evidence and approval"
          className="min-w-0 lj-surface"
          data-hud-rail="attention"
          data-active={active('findings')}
        >
          <AttentionRail />
        </aside>
      </div>
    </div>
  );
}
