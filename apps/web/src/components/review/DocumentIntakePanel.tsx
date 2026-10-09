'use client';

import { useId, useRef, useState, type DragEvent } from 'react';
import { useVault } from '@/components/vault/vault-context';
import { useReview } from './review-context';
import { btn, h2, muted } from './styles';

const REASON_TEXT: Record<string, string> = {
  too_large: 'That file is over 10 MiB.',
  empty: 'That file is empty.',
  not_a_pdf: 'That does not look like a PDF.',
  busy: 'Another document is still being read.',
  timeout: 'Reading took longer than 30 seconds and was stopped.',
  password_required: 'Password-protected PDFs are not supported.',
  no_extractable_text:
    'No extractable text. Scanned or image-only PDFs are not supported (no OCR).',
  malformed: 'The file is damaged or not a valid PDF.',
  failed: 'The file could not be read.',
  cancelled: 'Stopped.',
  'limit_exceeded:pages': 'Over 80 pages. Nothing was truncated; the file was not imported.',
  'limit_exceeded:items': 'Too much text on one page to read safely.',
  'limit_exceeded:text': 'Too much text on one page to read safely.',
  'limit_exceeded:extraction_size': 'The extracted text is over 2 MiB.',
  'unsupported:xfa': 'XFA forms are not supported.',
  'unsupported:not_a_pdf': 'That does not look like a PDF.',
};

const reasonText = (reason: string) => REASON_TEXT[reason] ?? `Not imported (${reason}).`;

/** Explicit file picker or drop. Files are read in this browser and stored encrypted; nothing is uploaded in plain form. */
export function DocumentIntakePanel() {
  const { controller, snapshot } = useReview();
  const vault = useVault();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const id = useId();
  const unlocked = vault.snapshot.state === 'unlocked' || vault.snapshot.state === 'saving';
  const ready = controller !== null && unlocked && snapshot.matterId !== null;

  async function take(files: FileList | File[]) {
    if (controller === null) return;
    for (const file of Array.from(files).slice(0, 1)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await controller.importPdf({ bytes, label: file.name });
    }
  }
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    if (ready) void take(event.dataTransfer.files);
  };
  const intake = snapshot.intake;

  return (
    <section aria-labelledby={id} className="min-w-0">
      <h2 id={id} className={h2}>
        Documents
      </h2>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`mt-2 rounded border border-dashed p-3 ${over ? 'border-lj-cyan' : 'border-lj-edge'}`}
      >
        <p className="m-0 text-[0.875rem]">Drop a text-based PDF here, or choose one.</p>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          aria-label="Choose a PDF"
          data-testid="pdf-input"
          disabled={!ready || intake.state === 'running'}
          onChange={(event) => {
            if (event.target.files) void take(event.target.files);
            event.target.value = '';
          }}
        />
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            className={btn}
            disabled={!ready || intake.state === 'running'}
            onClick={() => input.current?.click()}
          >
            Choose PDF
          </button>
          <button
            type="button"
            className={btn}
            disabled={controller === null}
            onClick={() => controller?.stop()}
          >
            Stop
          </button>
        </div>
        {!ready ? (
          <p className={muted}>
            {unlocked
              ? 'Open a matter first.'
              : 'Unlock the vault and open a matter to add documents.'}
          </p>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className="m-0 mt-2 text-[0.875rem]">
        {intake.state === 'running' ? `Reading ${intake.label}…` : null}
        {intake.state === 'done'
          ? `${intake.label}: saved encrypted${intake.coverage === 'partial' ? ' with partial text coverage' : ''}.`
          : null}
        {intake.state === 'failed' ? `${intake.label}: ${reasonText(intake.reason)}` : null}
      </p>
      <ul className="m-0 mt-2 list-none p-0">
        {snapshot.documents.map((doc) => (
          <li
            key={doc.documentVersionId}
            className="border-b border-lj-divider py-2 text-[0.875rem]"
          >
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={doc.selected}
                disabled={doc.extraction !== 'ready'}
                onChange={(event) => {
                  const next = snapshot.documents
                    .filter((d) =>
                      d.documentVersionId === doc.documentVersionId
                        ? event.target.checked
                        : d.selected,
                    )
                    .map((d) => d.documentVersionId);
                  void controller?.setSelected(next);
                }}
              />
              <span className="break-words">{doc.label}</span>
            </label>
            <span className="text-lj-secondary">
              {doc.extraction === 'ready'
                ? `${doc.pageCount ?? '?'} pages · text coverage ${doc.coverage?.status ?? 'unknown'}${
                    doc.coverage && doc.coverage.warnings.length > 0
                      ? ` · ${doc.coverage.warnings.join(', ').replaceAll('_', ' ')}`
                      : ''
                  }`
                : doc.extraction === 'invalid'
                  ? 'Extraction failed verification'
                  : 'No extracted text: stored as an opaque file only'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
