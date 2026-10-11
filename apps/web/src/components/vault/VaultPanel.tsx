'use client';

import { createContext, useContext, useId, useRef, useState } from 'react';
import { Icon } from '@/components/shell/icons';
import { useAccount } from '@/components/account/account-context';
import {
  describeVaultFailure,
  type MatterRecordV1,
  type VaultOutcome,
} from '@/features/vault/public';
import { useVault } from './vault-context';
import { vaultStatusLabel } from './status';

const button = 'min-h-11 rounded border border-lj-edge px-4 text-[0.875rem] disabled:text-lj-muted';
const field = 'min-h-11 rounded border border-lj-edge bg-lj-soft px-3 text-base text-lj-text';
const h2 = 'm-0 text-lg font-medium';
const muted = 'm-0 mt-1 text-[0.875rem] text-lj-secondary';

/** Reports the result of a user action that does not change the vault status (for example a file that was too large). */
type Reportable = VaultOutcome<unknown> | Promise<VaultOutcome<unknown>> | undefined;
export const NoticeContext = createContext<(outcome: Reportable) => void>(() => undefined);

const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

/** Hands the bytes to the browser once, then revokes the URL and clears them. */
export function download(fileName: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  bytes.fill(0);
}

export function EntryRow({
  matterId,
  entry,
  unresolved,
}: {
  matterId: string;
  entry: MatterRecordV1['context']['entries'][number];
  unresolved: boolean;
}) {
  const report = useContext(NoticeContext);
  const { commands } = useVault();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry.text);
  const labelId = useId();
  return (
    <li className="border-b border-lj-divider py-2">
      <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
        <span className="font-mono text-lj-muted">{entry.kind}</span>
        <span className={entry.status === 'confirmed' ? 'text-lj-cyan' : 'text-lj-amber'}>
          <Icon name={entry.status === 'confirmed' ? 'key' : 'alert'} className="mr-1 inline" />
          {entry.status === 'confirmed' ? 'Confirmed by you' : 'Unconfirmed'}
        </span>
        <span className="text-lj-muted">
          {entry.origin === 'user'
            ? 'Your entry'
            : entry.origin === 'imported'
              ? 'Imported'
              : 'Proposed by the assistant'}
        </span>
        {unresolved ? (
          <span className="text-lj-amber">Source version not found in this matter</span>
        ) : null}
      </div>
      {editing ? (
        <div className="mt-1 flex flex-wrap gap-2">
          <label htmlFor={labelId} className="sr-only">
            Corrected text
          </label>
          <input
            id={labelId}
            className={`${field} min-w-0 flex-1`}
            value={text}
            maxLength={4000}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            type="button"
            className={button}
            onClick={() => {
              report(commands?.correctEntry(matterId, entry.entryId, text));
              setEditing(false);
            }}
          >
            Save correction
          </button>
          <button type="button" className={button} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <p className="m-0 mt-1 whitespace-pre-wrap break-words text-[0.9375rem]">{entry.text}</p>
      )}
      <div className="mt-1 flex flex-wrap gap-2">
        <button type="button" className={button} onClick={() => setEditing(true)}>
          Correct
        </button>
        {entry.status === 'unconfirmed' ? (
          <button
            type="button"
            className={button}
            onClick={() => report(commands?.confirmEntry(matterId, entry.entryId))}
          >
            Confirm this is correct
          </button>
        ) : null}
        <button
          type="button"
          className={button}
          onClick={() => report(commands?.removeEntry(matterId, entry.entryId))}
        >
          Remove from working context
        </button>
      </div>
    </li>
  );
}

export function ExportAndImport({ matterId }: { matterId: string }) {
  const report = useContext(NoticeContext);
  const { snapshot, commands } = useVault();
  const fileRef = useRef<HTMLInputElement>(null);
  const record = snapshot.selectedMatter;
  const preview = snapshot.exportPreview;
  const incoming = snapshot.importPreview;
  const [note, setNote] = useState('');

  return (
    <section aria-labelledby="export-title" className="mt-6">
      <h3 id="export-title" className="m-0 text-base font-medium">
        Export and import
      </h3>
      <p className={muted}>
        Files are made in this browser and never sent anywhere. Readable files expose private
        material to anyone who holds them.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          onClick={() => report(commands?.prepareExport('context', matterId))}
        >
          Export saved context…
        </button>
        {record?.frozenReviews.map((frozen) => (
          <span key={frozen.commitment} className="flex flex-wrap gap-2">
            <button
              type="button"
              className={button}
              onClick={() =>
                report(commands?.prepareExport('encrypted-review', matterId, frozen.commitment))
              }
            >
              Export encrypted review {frozen.packageId.slice(0, 8)}…
            </button>
            <button
              type="button"
              className={button}
              onClick={() =>
                report(commands?.prepareExport('readable-review', matterId, frozen.commitment))
              }
            >
              Export readable review {frozen.packageId.slice(0, 8)}…
            </button>
          </span>
        ))}
      </div>

      {preview !== null ? (
        <div role="group" aria-label="Export preview" className="mt-3 border border-lj-edge p-3">
          <h4 className="m-0 text-base font-medium">
            {preview.discloses ? 'This file discloses private material' : 'Encrypted file'}
          </h4>
          <p className="mt-1 text-[0.875rem]">{preview.disclosure}</p>
          <ul className="mt-2 list-none p-0 text-[0.875rem]">
            {preview.items.map((item, index) => (
              <li
                key={index}
                className="flex justify-between gap-3 border-b border-lj-divider py-1"
              >
                <span className="break-words">{item.label}</span>
                <span className="text-lj-muted">{item.bytes.toLocaleString()} bytes</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={`${button} bg-lj-soft`}
              onClick={() => {
                const result = commands?.confirmExport(preview.exportId);
                if (result?.ok === true) {
                  download(result.data.fileName, result.data.bytes);
                  setNote(
                    `Downloaded ${result.data.fileName}. Cancelling later cannot recall a file already saved.`,
                  );
                }
              }}
            >
              {preview.discloses ? 'Download readable file' : 'Download encrypted file'}
            </button>
            <button type="button" className={button} onClick={() => commands?.cancelExport()}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {note !== '' ? (
        <p role="status" className={muted}>
          {note}
        </p>
      ) : null}

      <div className="mt-3">
        <label htmlFor="import-file" className="text-[0.875rem]">
          Import a review or context file
        </label>
        <input
          id="import-file"
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className={`${field} mt-1 block w-full`}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file === undefined) return;
            if (file.size > MAX_IMPORT_BYTES) {
              setNote('That file is larger than the 64 MiB import limit, so it was not read.');
              return;
            }
            report(
              file.arrayBuffer().then(
                (buffer) =>
                  commands?.previewImport(new Uint8Array(buffer)) ?? {
                    ok: false as const,
                    failure: 'LOCKED' as const,
                  },
              ),
            );
            if (fileRef.current !== null) fileRef.current.value = '';
          }}
        />
      </div>

      {incoming !== null ? (
        <div role="group" aria-label="Import preview" className="mt-3 border border-lj-edge p-3">
          {incoming.review !== null ? (
            <>
              <h4 className="m-0 text-base font-medium">
                {incoming.review.foreignReviewer
                  ? 'A review by another reviewer'
                  : 'A review by this account'}
              </h4>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.875rem]">
                <dt className="text-lj-muted">Reviewer</dt>
                <dd className="m-0 break-all font-mono">{incoming.review.reviewerAddress}</dd>
                <dt className="text-lj-muted">Files</dt>
                <dd className="m-0">
                  {incoming.review.artifactCount} (
                  {incoming.review.totalArtifactBytes.toLocaleString()} bytes)
                </dd>
                <dt className="text-lj-muted">Files agree with the claimed reference</dt>
                <dd className="m-0">
                  {incoming.review.consistentWithClaimedReference ? 'Yes' : 'No: do not import'}
                </dd>
                <dt className="text-lj-muted">Agrees with your expected reference</dt>
                <dd className="m-0">
                  {incoming.review.matchesExpectedReference === null
                    ? 'No reference supplied'
                    : incoming.review.matchesExpectedReference
                      ? 'Yes'
                      : 'No'}
                </dd>
                <dt className="text-lj-muted">Registry status</dt>
                <dd className="m-0">Unknown: a file cannot show current on-chain status</dd>
              </dl>
              <p className={muted}>
                Importing archives this review. It does not make you its reviewer or let you approve
                anything under their address.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className={`${button} bg-lj-soft`}
                  disabled={!incoming.review.consistentWithClaimedReference}
                  onClick={() => report(commands?.confirmReviewImport(incoming.importId, matterId))}
                >
                  Import into this matter
                </button>
                <button type="button" className={button} onClick={() => commands?.cancelImport()}>
                  Cancel
                </button>
              </div>
            </>
          ) : incoming.context !== null ? (
            <>
              <h4 className="m-0 text-base font-medium">Context entries</h4>
              <p className={muted}>Imported entries arrive unconfirmed. Choose which to add.</p>
              <ContextImport
                matterId={matterId}
                importId={incoming.importId}
                entries={incoming.context.entries}
              />
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ContextImport({
  matterId,
  importId,
  entries,
}: {
  matterId: string;
  importId: string;
  entries: readonly { entryId: string; kind: string; text: string; unresolvedReferences: number }[];
}) {
  const report = useContext(NoticeContext);
  const { commands } = useVault();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  return (
    <>
      <ul className="m-0 list-none p-0">
        {entries.map((entry) => (
          <li
            key={entry.entryId}
            className="flex items-start gap-2 border-b border-lj-divider py-1 text-[0.875rem]"
          >
            <input
              id={`pick-${entry.entryId}`}
              type="checkbox"
              checked={picked.has(entry.entryId)}
              onChange={(event) => {
                const next = new Set(picked);
                if (event.target.checked) next.add(entry.entryId);
                else next.delete(entry.entryId);
                setPicked(next);
              }}
            />
            <label htmlFor={`pick-${entry.entryId}`} className="min-w-0 break-words">
              [{entry.kind}] {entry.text}
              {entry.unresolvedReferences > 0 ? ' (source version not found in this matter)' : ''}
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className={`${button} bg-lj-soft`}
          disabled={picked.size === 0}
          onClick={() => report(commands?.confirmContextImport(importId, matterId, [...picked]))}
        >
          Add selected as unconfirmed
        </button>
        <button type="button" className={button} onClick={() => commands?.cancelImport()}>
          Cancel
        </button>
      </div>
    </>
  );
}

function MatterEditor({ record }: { record: MatterRecordV1 }) {
  const report = useContext(NoticeContext);
  const { snapshot, commands } = useVault();
  const [kind, setKind] = useState<'fact' | 'note'>('fact');
  const [text, setText] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const known = new Set(record.sources.map((source) => source.documentVersionId));
  const dirty = snapshot.matters.find((m) => m.matterId === record.matterId)?.unsaved === true;

  return (
    <section aria-labelledby="matter-title" className="mt-6">
      <h3 id="matter-title" className="m-0 text-base font-medium">
        {record.title}
      </h3>
      <h4 className="m-0 mt-3 text-[0.9375rem] font-medium">Source files</h4>
      {record.sources.length === 0 ? <p className={muted}>None.</p> : null}
      <ul className="list-none p-0 text-[0.875rem]">
        {record.sources.map((source) => (
          <li key={source.documentVersionId} className="border-b border-lj-divider py-1">
            {source.label || 'Untitled'}{' '}
            <span className="text-lj-muted">
              ({source.mediaType}, {Number(source.byteLength).toLocaleString()} bytes, stored
              encrypted)
            </span>
          </li>
        ))}
      </ul>
      <label htmlFor="source-file" className="mt-2 block text-[0.875rem]">
        Add an original file (up to 10 MiB)
      </label>
      <input
        id="source-file"
        type="file"
        className={`${field} mt-1 block w-full`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file === undefined) return;
          report(
            file.arrayBuffer().then(
              (buffer) =>
                commands?.addSourceFile(record.matterId, {
                  bytes: new Uint8Array(buffer),
                  mediaType: file.type || 'application/octet-stream',
                  label: file.name,
                }) ?? { ok: false as const, failure: 'LOCKED' as const },
            ),
          );
        }}
      />

      <h4 className="m-0 mt-4 text-[0.9375rem] font-medium">Saved context</h4>
      <p className={muted}>
        Only entries you confirm can be selected for the assistant. Proposals and imports stay
        unconfirmed until you accept them.
      </p>
      {record.context.entries.length === 0 ? <p className={muted}>None.</p> : null}
      <ul className="m-0 list-none p-0">
        {record.context.entries.map((entry) => (
          <EntryRow
            key={`${entry.entryId}-${entry.revision}`}
            matterId={record.matterId}
            entry={entry}
            unresolved={entry.sourceRefs.some((ref) => !known.has(ref.documentVersionId))}
          />
        ))}
      </ul>
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim() === '') return;
          const result = commands?.addEntry(record.matterId, { kind, text, confirmed });
          report(result);
          if (result?.ok === true) {
            setText('');
            setConfirmed(false);
          }
        }}
      >
        <label htmlFor="entry-kind" className="sr-only">
          Entry type
        </label>
        <select
          id="entry-kind"
          className={field}
          value={kind}
          onChange={(e) => setKind(e.target.value === 'note' ? 'note' : 'fact')}
        >
          <option value="fact">Fact</option>
          <option value="note">Note</option>
        </select>
        <label htmlFor="entry-text" className="sr-only">
          Entry text (up to 4 KiB)
        </label>
        <input
          id="entry-text"
          className={`${field} min-w-0 flex-1 basis-64`}
          value={text}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a fact or note"
        />
        <label className="flex items-center gap-2 text-[0.875rem]">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          I confirm this is correct
        </label>
        <button type="submit" className={button}>
          Add to working context
        </button>
      </form>
      <p className={muted}>
        Chat and unsaved assistant output are not stored. Removing context here does not change
        earlier frozen reviews, exports or retained storage copies.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={`${button} bg-lj-soft`}
          disabled={!dirty}
          onClick={() => report(commands?.saveMatter(record.matterId))}
        >
          Save context
        </button>
        {dirty ? (
          <button
            type="button"
            className={button}
            onClick={() => commands?.discardDraft(record.matterId)}
          >
            Discard unsaved changes
          </button>
        ) : null}
      </div>

      <h4 className="m-0 mt-5 text-[0.9375rem] font-medium">Saved review packages</h4>
      {record.frozenReviews.length === 0 ? <p className={muted}>None.</p> : null}
      <ul className="list-none p-0 text-[0.875rem]">
        {record.frozenReviews.map((frozen) => {
          const checked = snapshot.checkedCaptures.some((c) => c.commitment === frozen.commitment);
          return (
            <li
              key={frozen.commitment}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-lj-divider py-1"
            >
              <span className="break-all font-mono">{frozen.packageId}</span>
              {/* "Saved and checked" is the only claim. Never approved, signed or confirmed. */}
              <span>{checked ? 'Saved and checked' : 'Saved; not yet checked in this unlock'}</span>
              {!checked ? (
                <button
                  type="button"
                  className={button}
                  onClick={() =>
                    report(commands?.verifyStoredCapture(record.matterId, frozen.commitment))
                  }
                >
                  Check saved package
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <ExportAndImport matterId={record.matterId} />
    </section>
  );
}

/** Vault, recovery and matter controls. An unlocked vault is not a receipt, an approval or a signing session. */
export function VaultPanel() {
  const { available, snapshot, commands } = useVault();
  const { snapshot: account } = useAccount();
  const [title, setTitle] = useState('');
  const titleId = useId();
  const [notice, setNotice] = useState<string | null>(null);
  const report = (outcome: Reportable) => {
    void Promise.resolve(outcome).then((result) => {
      if (result === undefined || result.ok) setNotice(null);
      else {
        const guidance = describeVaultFailure(result.failure);
        setNotice(`${guidance.title}. ${guidance.next}`);
      }
    });
  };
  const unlocked = snapshot.state === 'unlocked' || snapshot.state === 'saving';
  const busy =
    snapshot.state === 'unlocking' ||
    snapshot.state === 'recovering' ||
    snapshot.state === 'saving';
  const ready =
    available &&
    commands !== null &&
    account.account?.verifiedThisSession === true &&
    account.backend.state === 'signed_in';
  const label = vaultStatusLabel(snapshot, available);
  const guidance = snapshot.failure === null ? null : describeVaultFailure(snapshot.failure);

  return (
    <NoticeContext.Provider value={report}>
      <section aria-labelledby={titleId} className="mt-8 max-w-3xl">
        <h2 id={titleId} className={h2}>
          Encrypted vault
        </h2>
        <p
          role="status"
          aria-live="polite"
          className="m-0 mt-2 flex items-center gap-2 text-[0.9375rem]"
        >
          <Icon name={busy ? 'loading' : unlocked ? 'key' : 'lock'} className="text-lj-cyan" />
          <span data-testid="vault-status">{label}</span>
        </p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.875rem]">
          <dt className="text-lj-muted">Vault</dt>
          <dd className="m-0" data-testid="vault-discovery">
            {snapshot.discovery === 'present'
              ? 'Found for this account'
              : snapshot.discovery === 'absent'
                ? 'None yet'
                : snapshot.discovery === 'unavailable'
                  ? 'Storage unavailable (not the same as empty)'
                  : 'Not checked'}
          </dd>
          <dt className="text-lj-muted">Vault session</dt>
          <dd className="m-0">
            {unlocked ? 'Unlocked, for at most 10 minutes or 5 idle minutes' : 'Locked'}
          </dd>
        </dl>
        <p className={muted}>
          Files are encrypted in this browser before they are stored. The service can still see that
          you have a vault, and the sizes and times of what you store. Unlocking the vault does not
          sign anything and does not approve a review. If browser storage is cleared, the same
          passkey on this site restores access; a different or new passkey does not.
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {!unlocked && snapshot.discovery === 'absent' ? (
            <button
              type="button"
              className={`${button} bg-lj-soft`}
              disabled={!ready || busy}
              onClick={() => void commands?.createVault()}
            >
              Create vault
            </button>
          ) : null}
          {!unlocked && snapshot.discovery !== 'absent' ? (
            <button
              type="button"
              className={`${button} bg-lj-soft`}
              disabled={!ready || busy}
              onClick={() => void commands?.unlock()}
            >
              Unlock vault
            </button>
          ) : null}
          {!unlocked ? (
            <button
              type="button"
              className={button}
              disabled={!available || commands === null || busy}
              onClick={() => void commands?.recover()}
            >
              Recover vault
            </button>
          ) : null}
          {unlocked ? (
            <button type="button" className={button} onClick={() => commands?.lock()}>
              Lock vault
            </button>
          ) : null}
          {!ready && available ? (
            <span className="self-center text-[0.8125rem] text-lj-secondary">
              Sign in to your account to use the vault.
            </span>
          ) : null}
        </div>

        {guidance !== null && snapshot.failure !== null ? (
          <div
            role="alert"
            className="mt-3 text-[0.875rem] text-lj-error"
            data-testid="vault-error"
          >
            <Icon name="alert" className="mr-2 inline" />
            <strong>{guidance.title}.</strong> {guidance.next}
            {snapshot.save === 'unknown_outcome' ? (
              <button
                type="button"
                className={`${button} ml-2`}
                onClick={() => void commands?.reconcile()}
              >
                Check again
              </button>
            ) : null}
            {snapshot.save === 'conflict' ? (
              <span className="ml-2 inline-flex gap-2">
                <button type="button" className={button} onClick={() => void commands?.reload()}>
                  Reload latest
                </button>
                <button
                  type="button"
                  className={button}
                  onClick={() => void commands?.reapplyConflictDraft()}
                >
                  Reapply my changes
                </button>
              </span>
            ) : null}
          </div>
        ) : null}

        {notice !== null ? (
          <p role="alert" className="mt-3 text-[0.875rem] text-lj-error" data-testid="vault-notice">
            <Icon name="alert" className="mr-2 inline" />
            {notice}
          </p>
        ) : null}

        {unlocked ? (
          <div className="mt-5">
            <h3 className="m-0 text-base font-medium">Matters</h3>
            {snapshot.matters.length === 0 ? <p className={muted}>None yet.</p> : null}
            <ul className="m-0 list-none p-0">
              {snapshot.matters.map((matter) => (
                <li key={matter.matterId}>
                  <button
                    type="button"
                    aria-pressed={snapshot.selectedMatterId === matter.matterId}
                    className="min-h-11 w-full border-b border-lj-divider px-1 text-left text-[0.9375rem]"
                    onClick={() => commands?.selectMatter(matter.matterId)}
                  >
                    {matter.title}
                    <span className="ml-2 text-[0.8125rem] text-lj-muted">
                      {matter.sourceCount} files · {matter.frozenCount} packages
                      {matter.unsaved ? ' · unsaved changes' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <form
              className="mt-3 flex flex-wrap gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (title.trim() === '') return;
                const created = commands?.createMatter(title);
                report(created);
                void created?.then((result) => {
                  if (result.ok) setTitle('');
                });
              }}
            >
              <label htmlFor="matter-title-input" className="sr-only">
                New matter title
              </label>
              <input
                id="matter-title-input"
                className={`${field} min-w-0 flex-1 basis-56`}
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="New matter title"
              />
              <button type="submit" className={button} disabled={snapshot.matters.length >= 16}>
                Create matter
              </button>
            </form>
            {snapshot.selectedMatter !== null ? (
              <MatterEditor record={snapshot.selectedMatter} />
            ) : null}
          </div>
        ) : null}
      </section>
    </NoticeContext.Provider>
  );
}
