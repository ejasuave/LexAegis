'use client';

import { useState } from 'react';
import { describeVaultFailure, type VaultOutcome } from '@/features/vault/public';
import { useVault } from '@/components/vault/vault-context';
import { EntryRow, NoticeContext, download } from '@/components/vault/VaultPanel';
import { describeContextEntry } from '@/features/assistant/public';

type Group = 'facts' | 'notes' | 'observations';

const GROUPS: { id: Group; title: string; empty: string }[] = [
  { id: 'facts', title: 'Confirmed facts', empty: 'No confirmed facts are saved.' },
  { id: 'notes', title: 'Your notes', empty: 'No notes are saved.' },
  {
    id: 'observations',
    title: 'Saved assistant observations',
    empty: 'No assistant observations are saved. An observation is never a confirmed fact.',
  },
];

const button = 'min-h-11 rounded border border-lj-edge px-4 text-[0.875rem]';

/**
 * Inspect, correct, remove and export what is saved for the selected matter, through the same
 * encrypted vault operations as the Vault page. Observations stay apart from confirmed facts, and
 * raw chat is never listed because it is never saved. Removing working context changes nothing
 * in a frozen review or in a file already exported.
 */
export function ContextDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { snapshot, commands } = useVault();
  const [notice, setNotice] = useState('');
  const matter = snapshot.selectedMatter;
  const unlocked = snapshot.state === 'unlocked' || snapshot.state === 'saving';
  const preview = snapshot.exportPreview;

  const report = (outcome: VaultOutcome<unknown> | Promise<VaultOutcome<unknown>> | undefined) => {
    void Promise.resolve(outcome).then((result) => {
      if (result === undefined || result.ok) setNotice('');
      else {
        const guidance = describeVaultFailure(result.failure);
        setNotice(`${guidance.title}. ${guidance.next}`);
      }
    });
  };

  const entries = matter?.context.entries ?? [];
  const groupOf = (entry: (typeof entries)[number]): Group =>
    entry.origin === 'model_proposed' || entry.kind === 'outcome'
      ? 'observations'
      : entry.status === 'confirmed'
        ? 'facts'
        : 'notes';

  return (
    <aside
      id="context-drawer"
      aria-label="Saved context"
      hidden={!open}
      className="lj-card fixed inset-x-0 bottom-24 z-10 max-h-[60dvh] overflow-y-auto p-4 lg:left-auto lg:w-[28rem]"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-lg font-medium">Saved context</h2>
        <button type="button" className={button} onClick={onClose}>
          Close
        </button>
      </div>
      {!unlocked || matter === null ? (
        <p className="m-0 mt-2 text-[0.875rem] text-lj-secondary">
          {unlocked ? 'Select a matter to see its saved context.' : 'The vault is locked.'}
        </p>
      ) : (
        <NoticeContext.Provider value={report}>
          {GROUPS.map((group) => {
            const items = entries.filter((entry) => groupOf(entry) === group.id);
            return (
              <section key={group.id} className="mt-4" aria-label={group.title}>
                <h3 className="m-0 text-base font-medium">{group.title}</h3>
                {items.length === 0 ? (
                  <p className="m-0 mt-1 text-[0.875rem] text-lj-secondary">{group.empty}</p>
                ) : (
                  <ul className="m-0 mt-1 list-none p-0">
                    {items.map((entry) => (
                      <EntryRow
                        key={entry.entryId}
                        matterId={matter.matterId}
                        entry={{ ...entry, text: entry.text }}
                        unresolved={false}
                      />
                    ))}
                  </ul>
                )}
                {group.id === 'observations' && items.length > 0 ? (
                  <p className="m-0 mt-1 text-[0.8125rem] text-lj-muted">
                    {items.map((entry) => describeContextEntry(entry.text)).length} saved
                    observation(s). Confirming one makes it your own statement; it is never
                    automatic.
                  </p>
                ) : null}
              </section>
            );
          })}
          <div className="mt-4">
            <button
              type="button"
              className={button}
              onClick={() => report(commands?.prepareExport('context', matter.matterId))}
            >
              Export saved context…
            </button>
          </div>
          {preview !== null && preview.kind === 'context' ? (
            <div
              role="group"
              aria-label="Export preview"
              className="mt-3 rounded border border-lj-edge p-3"
            >
              <p className="m-0 text-[0.875rem]">{preview.disclosure}</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className={button}
                  onClick={() => {
                    const result = commands?.confirmExport(preview.exportId);
                    if (result?.ok === true) {
                      download(result.data.fileName, result.data.bytes);
                      setNotice(`Downloaded ${result.data.fileName}.`);
                    }
                  }}
                >
                  Download readable file
                </button>
                <button type="button" className={button} onClick={() => commands?.cancelExport()}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </NoticeContext.Provider>
      )}
      <p role="status" aria-live="polite" className="m-0 mt-2 text-[0.875rem] text-lj-secondary">
        {notice}
      </p>
    </aside>
  );
}
