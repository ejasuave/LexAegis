'use client';

import { Onboarding } from '@/components/account/Onboarding';
import { ReviewChecklist } from '@/components/review/DocumentWorkspace';
import { useVault } from '@/components/vault/vault-context';
import { describeContextEntry } from '@/features/assistant/public';

const heading = 'm-0 text-base font-medium';
const note = 'm-0 mt-2 text-[0.875rem] text-lj-secondary';
const section = 'lj-rule mt-4 pt-3';

/**
 * Left rail, in this order: matters, documents and versions, the evidence checklist, then saved
 * context. Decrypted matters exist only while the vault is unlocked; locking removes them at once.
 * Missing evidence is an unresolved requirement, never proof that an event did not happen.
 */
export function MatterRail() {
  const { snapshot, available, commands } = useVault();
  const unlocked = snapshot.state === 'unlocked' || snapshot.state === 'saving';
  const selected = snapshot.selectedMatter;
  return (
    <div className="lj-rail-inner lj-marks">
      <Onboarding />
      <h2 className="m-0 text-lg font-medium">Matters</h2>
      {!unlocked ? (
        <p className={note}>
          {available
            ? 'The vault is locked. Unlock it on the Vault page to see your matters.'
            : 'The encrypted vault is not available in this browser.'}
        </p>
      ) : snapshot.matters.length === 0 ? (
        <p className={note}>No matters yet. Create one on the Vault page.</p>
      ) : (
        <ul className="m-0 mt-2 list-none p-0">
          {snapshot.matters.map((matter) => (
            <li key={matter.matterId}>
              <button
                type="button"
                aria-pressed={snapshot.selectedMatterId === matter.matterId}
                className={`min-h-11 w-full border-b border-lj-divider px-1 text-left text-[0.875rem] leading-[1.375rem] ${
                  snapshot.selectedMatterId === matter.matterId
                    ? 'border-l-2 border-l-lj-cyan pl-2 text-lj-text'
                    : 'text-lj-secondary hover:text-lj-text'
                }`}
                onClick={() => commands?.selectMatter(matter.matterId)}
              >
                {matter.title}
                {matter.unsaved ? ' (unsaved)' : ''}
              </button>
            </li>
          ))}
        </ul>
      )}
      <section className={section} aria-label="Documents and versions">
        <h3 className={heading}>Documents</h3>
        {unlocked && selected !== null && selected.sources.length > 0 ? (
          <ul className="m-0 mt-1 list-none p-0 text-[0.875rem] leading-[1.375rem]">
            {selected.sources.map((source) => (
              <li key={source.documentVersionId} className="break-words py-1">
                {source.label || 'Untitled'}
              </li>
            ))}
          </ul>
        ) : (
          <p className={note}>None.</p>
        )}
      </section>
      <div className={section}>
        <ReviewChecklist />
      </div>
      <section className={section} aria-label="Saved context">
        <h3 className={heading}>Saved context</h3>
        {unlocked && selected !== null && selected.context.entries.length > 0 ? (
          <ul className="m-0 mt-1 list-none p-0 text-[0.875rem] leading-[1.375rem]">
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
          <p className={note}>{unlocked ? 'None.' : 'Locked.'}</p>
        )}
      </section>
    </div>
  );
}
