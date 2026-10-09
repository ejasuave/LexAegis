'use client';

import { AssistantOrb, orbLabel } from '@/components/assistant/AssistantOrb';
import { ReadinessPanel } from '@/components/shell/ReadinessPanel';
import { useVault } from '@/components/vault/vault-context';
import { vaultStatusLabel } from '@/components/vault/status';
import {
  useWorkspace,
  type MobileTab,
  type PresentationMode,
} from '@/components/shell/workspace-context';
import { ActionPreview } from './ActionPreview';
import { ReviewDocuments, ReviewEvidence } from './DocumentWorkspace';

const MODES: { id: PresentationMode; label: string }[] = [
  { id: 'command', label: 'Command centre' },
  { id: 'review', label: 'Review' },
];

const TABS: { id: MobileTab; label: string }[] = [
  { id: 'matter', label: 'Matter' },
  { id: 'work', label: 'Work' },
  { id: 'evidence', label: 'Evidence' },
];

const panelTitle = 'm-0 text-lg font-medium';
const muted = 'm-0 mt-2 text-[0.875rem] text-lj-secondary';

/** Decrypted matters exist only while the vault is unlocked; locking removes them at once. */
function MatterRail() {
  const { snapshot, available, commands } = useVault();
  const unlocked = snapshot.state === 'unlocked' || snapshot.state === 'saving';
  const selected = snapshot.selectedMatter;
  return (
    <div>
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
              {entry.text}
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

function CommandCentre() {
  return (
    <div className="flex flex-col items-center text-center">
      <AssistantOrb state="unavailable" size="expanded" />
      <p role="status" className="m-0 mt-4 text-lg">
        Open a matter to begin.
      </p>
      <p className="m-0 mt-1 text-[0.875rem] text-lj-secondary">
        {orbLabel('unavailable')}: no assistant is connected yet.
      </p>
      <VaultStatusLine />
      <section aria-label="Task steps" className="mt-6 w-full max-w-xl text-left">
        <h2 className={panelTitle}>Task steps</h2>
        <p className={muted}>No task is running.</p>
      </section>
      <section aria-label="Conversation" className="mt-6 w-full max-w-xl text-left">
        <h2 className={panelTitle}>Conversation</h2>
        <p className={muted}>
          No conversation. Messages cannot be sent until the assistant is available.
        </p>
      </section>
    </div>
  );
}

function ReviewView() {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]">
      <section aria-label="Document" className="min-w-0">
        <div className="flex items-center justify-between border-b border-lj-divider pb-2">
          <h2 className={panelTitle}>Document</h2>
          <AssistantOrb state="unavailable" size="compact" />
        </div>
        <VaultStatusLine />
        <ReviewDocuments />
      </section>
      <section
        aria-label="Assistant"
        className="min-w-0 border-t border-lj-divider pt-4 xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0"
      >
        <h2 className={panelTitle}>Assistant</h2>
        <p className={muted}>Unavailable. Use the command dock once the assistant is connected.</p>
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
      <ActionPreview />
      <ReadinessPanel />
    </div>
  );
}

/** Command-centre and Review modes share one selection and one draft (held in WorkspaceProvider). */
export function ReviewWorkspace() {
  const { mode, setMode, mobileTab, setMobileTab, selection } = useWorkspace();
  const show = (tab: MobileTab) => (mobileTab === tab ? '' : 'hidden lg:block');

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

      <div role="tablist" aria-label="Workspace sections" className="mb-3 flex gap-1 lg:hidden">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={mobileTab === tab.id}
            onClick={() => setMobileTab(tab.id)}
            className={`min-h-11 flex-1 rounded border px-3 text-[0.875rem] ${
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

      <div className="grid gap-6 lg:grid-cols-[minmax(13rem,15rem)_minmax(0,1fr)_minmax(19rem,21rem)]">
        <aside aria-label="Matter" className={show('matter')}>
          <MatterRail />
        </aside>
        <section aria-label="Work" className={`min-w-0 ${show('work')}`}>
          {mode === 'command' ? <CommandCentre /> : <ReviewView />}
        </section>
        <aside aria-label="Evidence and approval" className={show('evidence')}>
          <EvidencePanel />
        </aside>
      </div>
    </div>
  );
}
