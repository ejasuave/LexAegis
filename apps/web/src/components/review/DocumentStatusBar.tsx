'use client';

import { useReview } from './review-context';

/**
 * States, in words, exactly which document version is open, how much of it was extracted, whether
 * the working copy is saved and whether its original bytes are available for citation. It reads
 * the review snapshot only; it grants nothing and checks nothing itself.
 */
export function DocumentStatusBar() {
  const { snapshot } = useReview();
  const selected = snapshot.documents.filter((doc) => doc.selected);
  if (snapshot.matterId === null) return null;
  return (
    <section
      aria-label="Document status"
      className="lj-card mt-2 p-3 text-[0.875rem]"
      data-testid="document-status"
    >
      {selected.length === 0 ? (
        <p className="m-0 text-lj-secondary">No document version is selected.</p>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {selected.map((doc) => (
            <li key={doc.documentVersionId} className="break-words">
              <span className="font-medium">{doc.label || 'Untitled'}</span>
              <span className="text-lj-muted"> · version </span>
              <span className="font-mono">{doc.documentVersionId.slice(0, 8)}</span>
              <span className="text-lj-muted"> · </span>
              {doc.extraction === 'ready'
                ? `${doc.pageCount ?? '?'} pages, text coverage ${doc.coverage?.status ?? 'unknown'}`
                : doc.extraction === 'missing'
                  ? 'extraction missing: citations cannot open'
                  : 'extraction invalid: citations cannot open'}
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 mt-1 text-lj-secondary" role="status">
        Working copy:{' '}
        {snapshot.save === 'saved'
          ? 'saved and read back'
          : snapshot.save === 'saving'
            ? 'saving'
            : snapshot.save === 'unsaved'
              ? 'unsaved changes'
              : 'save failed'}
        . Sources open only against the verified original bytes.
      </p>
    </section>
  );
}
