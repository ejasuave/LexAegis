'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FACT_FIELDS, type FactField } from '@lexaegis/agent/contracts';
import { parseGbpAmount } from '@lexaegis/agent/review';
import { renderPage } from '@/features/documents/page-renderer';
import { useReview } from './review-context';
import { btn, field, h2, h3, muted, type Focus } from './styles';

const FIELD_LABEL: Record<FactField, string> = {
  employer: 'Employer',
  employee: 'Employee',
  adviser_name: 'Adviser name',
  adviser_organisation: 'Adviser organisation',
  agreement_date: 'Agreement date (YYYY-MM-DD)',
  termination_date: 'Termination date (YYYY-MM-DD)',
  payment_total: 'Payment total (pence)',
  payment_instalment: 'Payment instalment (pence)',
  payment_basis: 'Payment basis (gross or net)',
};

const FAILURE_TEXT: Record<string, string> = {
  CANDIDATE_INVALID:
    'That value does not fit the field. Dates must be real YYYY-MM-DD dates; amounts are whole pence.',
  REFERENCE_UNRESOLVED: 'The cited passage no longer matches the stored text.',
  REASON_REQUIRED: 'A reviewer statement needs a reason.',
  ACCOUNT_LOCKED: 'Unlock your passkey account to confirm a fact.',
  NO_SOURCES: 'Select a document with extracted text first.',
  TOO_MANY_FACTS: 'At most 200 facts per review.',
};

function PageCanvas({ documentVersionId, page }: { documentVersionId: string; page: number }) {
  const { controller } = useReview();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'idle' | 'rendering' | 'rendered' | 'too_large' | 'failed'>(
    'idle',
  );

  useEffect(() => {
    const element = canvas.current;
    if (element === null || controller === null) return;
    const abort = new AbortController();
    // Render only when the canvas scrolls into view.
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      const bytes = controller.originalBytes(documentVersionId);
      if (bytes === null) {
        setState('failed');
        return;
      }
      setState('rendering');
      void renderPage(bytes, page, element, abort.signal).then((outcome) => {
        if (outcome === 'cancelled') return;
        setState(outcome);
        bytes.fill(0);
      });
    });
    observer.observe(element);
    return () => {
      abort.abort();
      observer.disconnect();
    };
  }, [controller, documentVersionId, page]);

  return (
    <div>
      <canvas
        ref={canvas}
        className="max-w-full border border-lj-divider"
        aria-label={`Original page ${page}`}
      />
      <p className={muted} role="status">
        {state === 'rendering' ? 'Drawing the original page…' : null}
        {state === 'too_large' ? 'This page is too large to draw safely.' : null}
        {state === 'failed'
          ? 'The original page could not be drawn. The extracted text is still available.'
          : null}
        {state === 'rendered'
          ? 'Original page. No highlight is drawn on it: the exact passage is shown in the text view, so no precision is implied.'
          : null}
      </p>
    </div>
  );
}

export function SourceViewer({
  focus,
  onFocus,
}: {
  focus: Focus | null;
  onFocus: (focus: Focus) => void;
}) {
  const { controller, snapshot } = useReview();
  const usable = snapshot.documents.filter((d) => d.extraction === 'ready' && d.selected);
  const current = focus?.documentVersionId ?? usable[0]?.documentVersionId ?? null;
  const extraction = current === null ? null : (controller?.extraction(current) ?? null);
  const page = Math.min(Math.max(focus?.page ?? 1, 1), extraction?.pageCount ?? 1);
  const pageData = extraction?.pages[page - 1];
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [form, setForm] = useState({
    field: 'payment_total' as FactField,
    group: 'settlement',
    slot: 'total',
    value: '',
    basis: 'source' as 'source' | 'reviewer_statement',
    reason: '',
  });
  const [message, setMessage] = useState('');
  const text = pageData?.text ?? '';
  const highlight =
    focus !== null &&
    focus.documentVersionId === current &&
    focus.page === page &&
    focus.start !== null &&
    focus.end !== null
      ? { start: focus.start, end: focus.end }
      : null;

  const chunks = useMemo(() => {
    if (highlight === null) return [{ start: 0, text, mark: false }];
    return [
      { start: 0, text: text.slice(0, highlight.start), mark: false },
      { start: highlight.start, text: text.slice(highlight.start, highlight.end), mark: true },
      { start: highlight.end, text: text.slice(highlight.end), mark: false },
    ];
  }, [text, highlight]);

  function readSelection() {
    const sel = window.getSelection();
    if (sel === null || sel.isCollapsed) {
      setSelection(null);
      return;
    }
    const locate = (node: Node | null, offset: number) => {
      const el = node?.parentElement?.closest('[data-start]');
      return el instanceof HTMLElement ? Number(el.dataset.start) + offset : null;
    };
    const a = locate(sel.anchorNode, sel.anchorOffset);
    const b = locate(sel.focusNode, sel.focusOffset);
    if (a === null || b === null || a === b) {
      setSelection(null);
      return;
    }
    const range = { start: Math.min(a, b), end: Math.max(a, b) };
    setSelection(range);
    // Suggest a value from the selection; it is only a suggestion, never applied silently.
    const raw = text.slice(range.start, range.end);
    const parsed = parseGbpAmount(raw.replace(/^[A-Za-z ]+/, ''));
    if (form.field === 'payment_basis') {
      if (/^(gross|net)$/i.test(raw.trim()))
        setForm((f) => ({ ...f, value: raw.trim().toLowerCase() }));
    } else if (form.field.startsWith('payment_')) {
      if (parsed.ok) setForm((f) => ({ ...f, value: parsed.pence.toString() }));
    } else {
      setForm((f) => ({ ...f, value: raw.trim().slice(0, 256) }));
    }
  }

  async function confirm() {
    if (controller === null || current === null) return;
    let references: unknown[] = [];
    if (form.basis === 'source') {
      if (selection === null) {
        setMessage('Select the passage in the text first.');
        return;
      }
      const made = controller.createReference({ documentVersionId: current, page, ...selection });
      if (!made.ok) {
        setMessage(
          `That passage cannot be cited (${made.code.toLowerCase().replaceAll('_', ' ')}).`,
        );
        return;
      }
      references = [made.data];
    }
    const result = await controller.confirmFact({
      candidate: {
        schema: 'lexaegis.fact-candidate.v1',
        factId: crypto.randomUUID(),
        matterId: snapshot.matterId,
        field: form.field,
        group: form.group,
        slot: form.slot,
        value: form.value,
        provenance: 'reviewer_selection',
        references,
      },
      basis: form.basis,
      statementReason: form.basis === 'reviewer_statement' ? form.reason : null,
    });
    setMessage(
      result.ok
        ? 'Fact confirmed. Save to keep it.'
        : (FAILURE_TEXT[result.code] ?? `Not confirmed (${result.code}).`),
    );
  }

  if (current === null || extraction === null) {
    return (
      <section aria-label="Source viewer">
        <h2 className={h2}>Source</h2>
        <p className={muted}>No document with extracted text is selected.</p>
      </section>
    );
  }

  return (
    <section aria-label="Source viewer" className="min-w-0">
      <h2 className={h2}>Source</h2>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="text-[0.875rem]">
          Document{' '}
          <select
            className={field}
            value={current}
            onChange={(event) =>
              onFocus({ documentVersionId: event.target.value, page: 1, start: null, end: null })
            }
          >
            {usable.map((d) => (
              <option key={d.documentVersionId} value={d.documentVersionId}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={btn}
          disabled={page <= 1}
          onClick={() =>
            onFocus({ documentVersionId: current, page: page - 1, start: null, end: null })
          }
        >
          Previous page
        </button>
        <span className="text-[0.875rem]" aria-live="polite">
          Physical page {page} of {extraction.pageCount}
          {pageData?.label ? ` (printed label “${pageData.label}”)` : ''}
        </span>
        <button
          type="button"
          className={btn}
          disabled={page >= extraction.pageCount}
          onClick={() =>
            onFocus({ documentVersionId: current, page: page + 1, start: null, end: null })
          }
        >
          Next page
        </button>
      </div>
      {extraction.coverage.status !== 'complete' ? (
        <p className="m-0 mt-2 text-[0.875rem] text-lj-amber" role="note">
          Text coverage is {extraction.coverage.status}:{' '}
          {extraction.coverage.warnings.join(', ').replaceAll('_', ' ')}.
        </p>
      ) : null}
      <div
        tabIndex={0}
        role="region"
        aria-label={`Extracted text of page ${page}`}
        onMouseUp={readSelection}
        onKeyUp={readSelection}
        className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-lj-divider p-3 text-[0.9375rem]"
      >
        {text === '' ? (
          <span className="text-lj-secondary">No extractable text on this page.</span>
        ) : null}
        {chunks.map((chunk) =>
          chunk.text === '' ? null : chunk.mark ? (
            <mark
              className="bg-lj-amber text-black"
              key={chunk.start}
              data-start={chunk.start}
              data-testid="source-highlight"
            >
              {chunk.text}
            </mark>
          ) : (
            <span key={chunk.start} data-start={chunk.start}>
              {chunk.text}
            </span>
          ),
        )}
      </div>
      <details className="mt-3">
        <summary className="min-h-11 cursor-pointer text-[0.875rem]">Original page</summary>
        <PageCanvas documentVersionId={current} page={page} />
      </details>

      <h3 className={h3}>Confirm a fact from this passage</h3>
      <p className={muted}>
        Selected:{' '}
        {selection === null
          ? 'nothing'
          : `“${text.slice(selection.start, selection.end).slice(0, 120)}”`}
        . A cited fact is stored with its page and offsets. Nothing is confirmed until you press
        Confirm.
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="text-[0.875rem]">
          Field
          <select
            className={field}
            value={form.field}
            onChange={(e) => setForm({ ...form, field: e.target.value as FactField })}
          >
            {FACT_FIELDS.map((f) => (
              <option key={f} value={f}>
                {FIELD_LABEL[f]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[0.875rem]">
          Value
          <input
            className={field}
            value={form.value}
            onChange={(e) => setForm({ ...form, value: e.target.value })}
          />
        </label>
        <label className="text-[0.875rem]">
          Group
          <input
            className={field}
            value={form.group}
            onChange={(e) => setForm({ ...form, group: e.target.value })}
          />
        </label>
        <label className="text-[0.875rem]">
          Slot (for example total, i1, i2)
          <input
            className={field}
            value={form.slot}
            onChange={(e) => setForm({ ...form, slot: e.target.value })}
          />
        </label>
        <label className="text-[0.875rem]">
          Basis
          <select
            className={field}
            value={form.basis}
            onChange={(e) =>
              setForm({ ...form, basis: e.target.value as 'source' | 'reviewer_statement' })
            }
          >
            <option value="source">From the selected passage</option>
            <option value="reviewer_statement">Reviewer statement (not a quotation)</option>
          </select>
        </label>
        {form.basis === 'reviewer_statement' ? (
          <label className="text-[0.875rem]">
            Reason
            <input
              className={field}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </label>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={btn} onClick={() => void confirm()}>
          Confirm fact
        </button>
        <button type="button" className={btn} disabled aria-describedby="explain-reason">
          Explain selection
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => void controller?.save()}
          disabled={snapshot.save === 'saved' || snapshot.save === 'saving'}
        >
          Save facts
        </button>
      </div>
      <p id="explain-reason" className={muted}>
        Explain selection is unavailable until the assistant runtime exists.
      </p>
      <p role="status" aria-live="polite" className="m-0 mt-1 text-[0.875rem]">
        {message} {snapshot.save === 'unsaved' ? 'Unsaved changes.' : null}
      </p>

      <h3 className={h3}>Confirmed facts</h3>
      {snapshot.facts.length === 0 ? <p className={muted}>None yet. Unknown is not zero.</p> : null}
      {snapshot.unresolvedFacts > 0 ? (
        <p className={muted}>
          {snapshot.unresolvedFacts} saved fact(s) no longer match their source and are not used.
        </p>
      ) : null}
      <ul className="m-0 list-none p-0">
        {snapshot.facts.map((fact) => (
          <li
            key={fact.factId}
            className="flex flex-wrap items-center gap-2 border-b border-lj-divider py-1 text-[0.875rem]"
          >
            <span className="break-words">
              {fact.field} / {fact.group}.{fact.slot} = {fact.value} ·{' '}
              {fact.basis === 'source'
                ? `page ${fact.references[0]?.page ?? '?'}`
                : `reviewer statement: ${fact.statementReason ?? ''}`}
            </span>
            {fact.references[0] ? (
              <button
                type="button"
                className={btn}
                onClick={() => {
                  const ref = fact.references[0];
                  if (ref)
                    onFocus({
                      documentVersionId: ref.documentVersionId,
                      page: ref.page,
                      start: ref.start,
                      end: ref.end,
                    });
                }}
              >
                Show source
              </button>
            ) : null}
            <button
              type="button"
              className={btn}
              onClick={() => controller?.removeFact(fact.factId)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
