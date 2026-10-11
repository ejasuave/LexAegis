'use client';

import { AssistantOrb, orbLabel } from '@/components/assistant/AssistantOrb';
import { Onboarding } from '@/components/account/Onboarding';
import { CommandActions } from '@/components/assistant/CommandActions';
import { deriveOrb } from '@/components/assistant/orb-state';
import { useAssistant } from '@/components/assistant/assistant-context';
import { ConversationPanel } from '@/components/assistant/ConversationPanel';
import { describeContextEntry } from '@/features/assistant/public';
import { ReadinessPanel } from '@/components/shell/ReadinessPanel';
import { useVault } from '@/components/vault/vault-context';
import { vaultStatusLabel } from '@/components/vault/status';
import {
  useWorkspace,
  type MobileTab,
  type PresentationMode,
} from '@/components/shell/workspace-context';
import { TransactionPanel } from '@/components/chain/TransactionPanel';
import { ReviewActionPreview } from './ReviewActionPreview';
import { DecisionsPanel } from './DecisionsPanel';
import { PackagePanel as ReviewPackageSection } from './PackagePanel';
import { ReviewDocuments, ReviewEvidence } from './DocumentWorkspace';

const MODES: { id: PresentationMode; label: string }[] = [
  { id: 'command', label: 'Command centre' },
  { id: 'review', label: 'Review' },
];

const TABS: { id: MobileTab; label: string }[] = [
  { id: 'document', label: 'Document' },
  { id: 'aegis', label: 'Aegis' },
  { id: 'findings', label: 'Findings' },
  { id: 'package', label: 'Review package' },
];

const panelTitle = 'm-0 text-lg font-medium';
const muted = 'm-0 mt-2 text-[0.875rem] text-lj-secondary';

/** Decrypted matters exist only while the vault is unlocked; locking removes them at once. */
function MatterRail() {
  const { snapshot, available, commands } = useVault();
  const onboarding = <Onboarding />;
  const unlocked = snapshot.state === 'unlocked' || snapshot.state === 'saving';
  const selected = snapshot.selectedMatter;
  return (
    <div>
      {onboarding}
      <h2 className={panelTitle}>Matters</h2>
      {!unlocked ? (
        <p className={muted}>
          {available
            ? 'The vault is locked. Unlock it on the Vault page to see your matters.'
            : 'The encrypted vault is not available in this browser.'}
        </p>
      ) : snapshot.matters.length === 0 ? (
        <p className={muted}>No matters yet. Create one on the Vault page.</p>
      ) : (
        <ul className="m-0 mt-2 list-none p-0">
          {snapshot.matters.map((matter) => (
            <li key={matter.matterId}>
              <button
                type="button"
                aria-pressed={snapshot.selectedMatterId === matter.matterId}
                className="min-h-11 w-full border-b border-lj-divider px-1 text-left text-[0.9375rem]"
                onClick={() => commands?.selectMatter(matter.matterId)}
              >
                {matter.title}
                {matter.unsaved ? ' (unsaved)' : ''}
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3 className="m-0 mt-5 text-base font-medium">Documents</h3>
      {unlocked && selected !== null && selected.sources.length > 0 ? (
        <ul className="m-0 mt-1 list-none p-0 text-[0.875rem]">
          {selected.sources.map((source) => (
            <li key={source.documentVersionId} className="break-words py-1">
              {source.label || 'Untitled'}
            </li>
          ))}
        </ul>
      ) : (
        <p className={muted}>None.</p>
      )}
      <h3 className="m-0 mt-5 text-base font-medium">Saved context</h3>
      {unlocked && selected !== null && selected.context.entries.length > 0 ? (
        <ul className="m-0 mt-1 list-none p-0 text-[0.875rem]">
          {selected.context.entries.map((entry) => (
            <li key={entry.entryId} className="break-words py-1">
              <span className="text-lj-muted">
                {entry.status === 'confirmed' ? 'Confirmed' : 'Unconfirmed'}:{' '}
              </span>
              {describeContextEntry(entry.text)}
            </li>
          ))}
        </ul>
      ) : (
        <p className={muted}>{unlocked ? 'None.' : 'Locked.'}</p>
      )}
    </div>
  );
}

/** The vault's real progress, in text. It never describes AI activity, an approval or a receipt. */
function VaultStatusLine() {
  const { snapshot, available } = useVault();
  return (
    <p className="m-0 mt-2 text-[0.8125rem] text-lj-secondary" role="status" aria-live="polite">
      Vault: {vaultStatusLabel(snapshot, available)}
    </p>
  );
}

/** What the orb means, in words. The graphic never carries meaning by itself. */
function orbCaption(
  orb: ReturnType<typeof useAssistant>['snapshot']['orb'],
  availability: ReturnType<typeof useAssistant>['snapshot']['availability'],
): string {
  if (orb !== 'unavailable') return orbLabel(orb);
  if (availability === null) return `${orbLabel('unavailable')}: local checks still work.`;
  return availability.state === 'not_configured'
    ? 'Analysis is not configured. Local checks still work.'
    : availability.state === 'configured_unverified'
      ? 'The assistant configuration has not been verified.'
      : orbLabel('unavailable');
}

function CommandCentre() {
  const { snapshot } = useAssistant();
  const orb = deriveOrb(snapshot);
  const vault = useVault();
  const active = snapshot.conversation.find(
    (item) => item.run?.id === snapshot.activeRunViewId,
  )?.run;
  return (
    <div className="flex flex-col items-center text-center">
      <AssistantOrb state={orb.state} size="expanded" completedLabel={orb.completedLabel} />
      <p role="status" aria-live="polite" className="m-0 mt-4 text-lg" data-testid="orb-caption">
        {vault.snapshot.selectedMatterId === null
          ? 'Open a matter to begin.'
          : orb.state === 'completed' || orb.state === 'tool_running' || orb.state === 'listening'
            ? orbLabel(orb.state, orb.completedLabel)
            : orbCaption(snapshot.orb, snapshot.availability)}
      </p>
      <CommandActions />
      <VaultStatusLine />
      <section aria-label="Task steps" className="mt-6 w-full max-w-xl text-left">
        <h2 className={panelTitle}>Task steps</h2>
        {active?.plan == null ? (
          <p className={muted}>No task is running.</p>
        ) : (
          <ol className="m-0 mt-2 list-none p-0 text-[0.875rem]">
            {active.plan.steps.map((step) => (
              <li key={step.stepId}>
                <span className="text-lj-muted">{step.status}: </span>
                {step.label}
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-label="Conversation" className="mt-6 w-full max-w-xl text-left">
        <h2 className={panelTitle}>Conversation</h2>
        <ConversationPanel />
      </section>
    </div>
  );
}

function ReviewView({ tab }: { tab: MobileTab }) {
  const { snapshot } = useAssistant();
  const orb = deriveOrb(snapshot);
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]">
      <section
        aria-label="Document"
        className={`min-w-0 ${tab === 'document' ? '' : 'hidden lg:block'}`}
      >
        <div className="flex items-center justify-between border-b border-lj-divider pb-2">
          <h2 className={panelTitle}>Document</h2>
          <AssistantOrb state={orb.state} size="compact" completedLabel={orb.completedLabel} />
        </div>
        <VaultStatusLine />
        <ReviewDocuments />
      </section>
      <section
        aria-label="Assistant"
        className={`min-w-0 ${tab === 'aegis' ? '' : 'hidden lg:block'} border-t border-lj-divider pt-4 xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0`}
      >
        <h2 className={panelTitle}>Assistant</h2>
        <ConversationPanel compact />
      </section>
    </div>
  );
}

function EvidencePanel() {
  return (
    <div>
      <h2 className={panelTitle}>Evidence</h2>
      <p className={muted}>Select a finding to see its source passage and calculation.</p>
      <ReviewEvidence />
    </div>
  );
}

function PackagePanel() {
  return (
    <div>
      <DecisionsPanel />
      <ReviewPackageSection />
      <ReviewActionPreview />
      <TransactionPanel />
      <ReadinessPanel />
    </div>
  );
}

/** Command-centre and Review modes share one selection and one draft (held in WorkspaceProvider). */
export function ReviewWorkspace() {
  const { mode, setMode, mobileTab, setMobileTab, selection } = useWorkspace();
  const show = (...tabs: MobileTab[]) => (tabs.includes(mobileTab) ? '' : 'hidden lg:block');

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
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

      <div
        role="tablist"
        aria-label="Workspace sections"
        className="mb-3 flex flex-wrap gap-1 lg:hidden"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={mobileTab === tab.id}
            onClick={() => setMobileTab(tab.id)}
            className={`min-h-11 min-w-[7rem] flex-1 rounded border px-3 text-[0.875rem] ${
              mobileTab === tab.id
                ? 'border-lj-cyan text-lj-text'
                : 'border-lj-edge text-lj-secondary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <p className="sr-only" aria-live="polite">
        {selection.matterId ? 'Matter selected.' : 'No matter selected.'}
      </p>

      <div className="grid gap-6 lg:grid-cols-[var(--lj-rail-width)_minmax(0,1fr)_minmax(22.5rem,26.25rem)]">
        <aside aria-label="Matter" className={show('document')}>
          <MatterRail />
        </aside>
        <section aria-label="Work" className="min-w-0">
          {mode === 'command' ? (
            <div className={show('aegis')}>
              <CommandCentre />
            </div>
          ) : (
            <ReviewView tab={mobileTab} />
          )}
        </section>
        <aside aria-label="Evidence and approval" className="min-w-0">
          <div className={show('findings')}>
            <EvidencePanel />
          </div>
          <div className={show('package')}>
            <PackagePanel />
          </div>
        </aside>
      </div>
    </div>
  );
}
