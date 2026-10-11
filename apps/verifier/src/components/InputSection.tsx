import { useId, useRef, useState, type DragEvent } from 'react';
import { PORTABLE_LIMITS } from '@lexaegis/protocol/portable';
import type { VerifierController, VerifierSnapshot } from '../controller';
import { FAILURE_TEXT } from '../labels';
import { formatBytes } from './format';

interface Props {
  readonly controller: VerifierController;
  readonly snapshot: VerifierSnapshot;
}

/** Step 1 and 2: choose the input and, separately, the reference you expect. */
export function InputSection({ controller, snapshot }: Props) {
  const fileId = useId();
  const refId = useId();
  const refHelp = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<'file' | 'opening'>('file');
  const [dragging, setDragging] = useState(false);
  const busy = snapshot.phase === 'reading' || snapshot.phase === 'checking';

  const take = (files: FileList | null) => {
    const [file] = files ?? [];
    if (file !== undefined) void controller.chooseFile(file, kind);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (!busy) take(event.dataTransfer.files);
  };

  return (
    <section aria-labelledby="input-title" className="mt-8">
      <h2 id="input-title" className="m-0 text-lg font-medium">
        1. Choose what to check
      </h2>

      <fieldset className="mt-3 border-0 p-0">
        <legend className="text-[0.875rem] text-lj-secondary">Kind of input</legend>
        <label className="mr-6 inline-flex min-h-11 items-center gap-2 text-[0.875rem]">
          <input
            type="radio"
            name="kind"
            checked={kind === 'file'}
            onChange={() => setKind('file')}
          />
          Readable review export
        </label>
        <label className="inline-flex min-h-11 items-center gap-2 text-[0.875rem]">
          <input
            type="radio"
            name="kind"
            checked={kind === 'opening'}
            onChange={() => setKind('opening')}
          />
          Opening file plus a reference
        </label>
      </fieldset>

      <div
        className={`card mt-2 ${dragging ? 'border-lj-cyan' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <label htmlFor={fileId} className="block text-[0.875rem] text-lj-secondary">
          Choose a file, or drop one here. It stays on this device. Up to{' '}
          {formatBytes(
            kind === 'file' ? PORTABLE_LIMITS.maxEncodedBytes : PORTABLE_LIMITS.maxStructuredBytes,
          )}
          . Encrypted backups cannot be checked here.
        </label>
        <input
          ref={inputRef}
          id={fileId}
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={(event) => {
            take(event.target.files);
            event.target.value = '';
          }}
          className="mt-2 block min-h-11 w-full text-[0.875rem]"
          data-testid="file-input"
        />
        {snapshot.fileName !== null ? (
          <p className="m-0 mt-2 text-[0.875rem] text-lj-secondary" data-testid="file-summary">
            Selected {snapshot.fileSize === null ? '' : `(${formatBytes(snapshot.fileSize)})`}. Read
            only on this device.
          </p>
        ) : null}
      </div>

      <h3 className="mb-0 mt-6 text-base font-medium">2. The reference you expect</h3>
      <p id={refHelp} className="m-0 mt-1 text-[0.875rem] text-lj-secondary">
        Paste the public receipt reference you were given separately, for example from the reviewer
        or from the registry. If you leave this empty, the file can only be checked against the
        reference it declares itself, which is not an independent check.
      </p>
      <label htmlFor={refId} className="mt-2 block text-[0.875rem]">
        Expected receipt reference (JSON)
      </label>
      <textarea
        id={refId}
        aria-describedby={refHelp}
        className="field mono mt-1"
        rows={5}
        spellCheck={false}
        autoComplete="off"
        value={snapshot.referenceText}
        onChange={(event) => controller.setReferenceText(event.target.value)}
        data-testid="reference-input"
        aria-invalid={snapshot.referenceInvalid}
      />
      {snapshot.referenceInvalid ? (
        <p role="alert" className="m-0 mt-1 text-[0.875rem] text-lj-bad">
          This is not a valid receipt reference.
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          className="btn btn-primary"
          aria-disabled={busy || snapshot.fileName === null || snapshot.referenceInvalid}
          onClick={() => {
            if (!busy && snapshot.fileName !== null && !snapshot.referenceInvalid)
              void controller.checkFiles();
          }}
          data-testid="check-files"
        >
          Check files again
        </button>
        <button
          type="button"
          className="btn"
          aria-disabled={busy || snapshot.referenceText.trim() === '' || snapshot.referenceInvalid}
          onClick={() => {
            if (!busy && snapshot.referenceText.trim() !== '' && !snapshot.referenceInvalid)
              void controller.inspectReference(snapshot.referenceText);
          }}
          data-testid="inspect-reference"
        >
          Inspect reference only
        </button>
        <button
          type="button"
          className="btn"
          aria-disabled={!busy}
          onClick={() => {
            if (busy) controller.cancel();
          }}
          data-testid="cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => controller.clear()}
          data-testid="clear"
        >
          Clear
        </button>
      </div>

      <div role="status" aria-live="polite" className="mt-3 text-[0.875rem]" data-testid="progress">
        {snapshot.phase === 'reading' ? 'Reading the file on this device…' : null}
        {snapshot.phase === 'checking' ? progressText(snapshot) : null}
        {snapshot.phase === 'failed' && snapshot.failure !== null ? (
          <span className="text-lj-bad" data-testid="failure">
            {FAILURE_TEXT[snapshot.failure] ?? 'The check could not be completed.'}
          </span>
        ) : null}
      </div>
    </section>
  );
}

function progressText(snapshot: VerifierSnapshot): string {
  const progress = snapshot.progress;
  if (progress === null) return 'Starting the local check…';
  if (progress.stage === 'parsing') return `Parsing ${formatBytes(progress.bytes)}…`;
  if (progress.stage === 'decoded')
    return `Decoded ${String(progress.artifacts)} artifacts (${formatBytes(progress.bytes)}). Validating…`;
  return `Hashing ${String(progress.artifacts)} artifacts…`;
}
