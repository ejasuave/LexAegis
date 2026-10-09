'use client';

import { useState } from 'react';
import { useReview } from './review-context';
import { btn, field, h2, muted, type Focus } from './styles';

const INCOMPLETE: Record<string, string> = {
  too_large: 'The comparison was too large.',
  edit_distance: 'The versions differ by more than the edit limit (5,000).',
  timeout: 'The comparison took longer than 2 seconds.',
  cancelled: 'The comparison was stopped.',
};

/**
 * Two explicitly chosen versions, old to new. The result is a text difference only: no meaning,
 * legal impact or equivalence is inferred, and identical text does not prove identical PDFs.
 */
export function DocumentComparison({ onFocus }: { onFocus: (focus: Focus) => void }) {
  const { controller, snapshot } = useReview();
  const docs = snapshot.documents.filter((d) => d.extraction === 'ready' && d.selected);
  const [oldId, setOld] = useState('');
  const [newId, setNew] = useState('');
  const [oldRange, setOldRange] = useState('');
  const [newRange, setNewRange] = useState('');
  const { comparison } = snapshot;
  const range = (value: string): [number, number] | undefined => {
    const m = /^(\d+)-(\d+)$/.exec(value.trim());
    return m ? [Number(m[1]), Number(m[2])] : undefined;
  };

  return (
    <section aria-label="Document comparison" className="min-w-0">
      <h2 className={h2}>Compare versions</h2>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="text-[0.875rem]">
          Old version
          <select className={field} value={oldId} onChange={(e) => setOld(e.target.value)}>
            <option value="">Choose…</option>
            {docs.map((d) => (
              <option key={d.documentVersionId} value={d.documentVersionId}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[0.875rem]">
          New version
          <select className={field} value={newId} onChange={(e) => setNew(e.target.value)}>
            <option value="">Choose…</option>
            {docs.map((d) => (
              <option key={d.documentVersionId} value={d.documentVersionId}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[0.875rem]">
          Old pages (optional, for example 2-4)
          <input className={field} value={oldRange} onChange={(e) => setOldRange(e.target.value)} />
        </label>
        <label className="text-[0.875rem]">
          New pages (optional)
          <input className={field} value={newRange} onChange={(e) => setNewRange(e.target.value)} />
        </label>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className={btn}
          disabled={oldId === '' || newId === '' || comparison.status === 'running'}
          onClick={() =>
            void controller?.compare({
              oldVersionId: oldId,
              newVersionId: newId,
              ...(range(oldRange) && { oldPages: range(oldRange) }),
              ...(range(newRange) && { newPages: range(newRange) }),
            })
          }
        >
          Compare
        </button>
        <button
          type="button"
          className={btn}
          disabled={
            comparison.result === null || comparison.result.outcome === 'comparison_incomplete'
          }
          onClick={() => void controller?.saveComparison()}
        >
          Save comparison
        </button>
      </div>
      <p role="status" aria-live="polite" className={muted}>
        {comparison.status === 'running' ? 'Comparing…' : null}
        {comparison.status === 'failed'
          ? `Not compared (${(comparison.failure ?? '').toLowerCase().replaceAll('_', ' ')}). Choose a smaller page range if the text is too large.`
          : null}
        {comparison.result?.outcome === 'comparison_incomplete'
          ? `Comparison incomplete. ${INCOMPLETE[comparison.result.incompleteReason ?? ''] ?? ''} This is not "no changes".`
          : null}
        {comparison.result?.outcome === 'no_text_changes'
          ? 'No differences in the extracted text. This does not prove the PDFs are identical.'
          : null}
        {comparison.result?.outcome === 'changes'
          ? `${comparison.result.spans.length} change(s) in the extracted text.`
          : null}
      </p>
      {comparison.result ? (
        <p className={muted}>
          Original files{' '}
          {comparison.result.originalBytesIdentical ? 'are byte-identical' : 'differ'} · extraction{' '}
          {comparison.result.extractionDiffers ? 'differs' : 'is identical'}
          {comparison.result.warnings.length > 0
            ? ` · ${comparison.result.warnings.join(', ').replaceAll('_', ' ')}`
            : ''}
        </p>
      ) : null}
      <ul className="m-0 list-none p-0">
        {comparison.result?.spans.slice(0, 100).map((span, index) => {
          const ref = span.references[0];
          return (
            <li
              key={index}
              className="flex flex-wrap items-center gap-2 border-b border-lj-divider py-1 text-[0.875rem]"
            >
              <span className={span.kind === 'added' ? 'text-lj-positive' : 'text-lj-error'}>
                {span.kind === 'added' ? 'Added' : 'Removed'}
              </span>
              <span className="break-words">“{ref?.quote.slice(0, 100) ?? ''}”</span>
              {ref ? (
                <button
                  type="button"
                  className={btn}
                  onClick={() =>
                    onFocus({
                      documentVersionId: ref.documentVersionId,
                      page: ref.page,
                      start: ref.start,
                      end: ref.end,
                    })
                  }
                >
                  Open
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
