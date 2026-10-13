'use client';

import { formatGbp } from '@lexaegis/agent/review';
import { useDecisions } from '@/components/review/decision-context';
import { useReview } from '@/components/review/review-context';
import { useWorkspace } from '@/components/shell/workspace-context';
import { categoryLabel, paymentGap } from '@/features/hud/public';
import { useHud } from './hud-context';

const STATE_TEXT = {
  ok: 'Checked',
  attention: 'Needs attention',
  needs_input: 'Needs input',
  not_comparable: 'Not comparable',
  technical_failure: 'Technical failure',
} as const;

const DISPOSITION_TEXT: Record<string, string> = {
  acknowledged: 'You acknowledged it',
  accepted_unresolved: 'You accepted it as an unresolved concern',
  not_applicable: 'You marked it not applicable',
  requires_change: 'You marked it as requiring a change',
};

/**
 * The one finding the rail explains: what kind of check it is, what it means, the figure with
 * its label, the deterministic calculation, the source and what the reviewer has decided. Code
 * produced the finding; an assistant suggestion is never part of it. The figure is an arithmetic
 * gap between documents, not money owed, a breach or a prediction.
 */
export function SelectedFinding() {
  const { selectedFindingId } = useHud();
  const { snapshot, setFocus } = useReview();
  const decisions = useDecisions().snapshot;
  const { setMode } = useWorkspace();
  const finding = snapshot.checks.findings.find((f) => f.findingId === selectedFindingId);
  if (finding === undefined) {
    return (
      <section aria-label="Selected finding" className="mb-4">
        <h2 className="m-0 text-lg font-medium">Selected finding</h2>
        <p className="m-0 mt-2 text-[0.875rem] text-lj-secondary">
          No finding yet. Run the checks in the document view; the most pressing one is explained
          here.
        </p>
      </section>
    );
  }
  const disposition = decisions.findings.find(
    (d) => d.finding.findingId === finding.findingId,
  )?.disposition;
  const gap = finding.checkId === 'payment_reconciliation' ? paymentGap(finding.observed) : null;
  const payment = snapshot.checks.payments.find((p) => finding.findingId.includes(p.group));
  const reference = finding.references[0];

  return (
    <section aria-label="Selected finding" className="mb-4" data-testid="selected-finding">
      <h2 className="m-0 text-lg font-medium">Selected finding</h2>
      <p className="m-0 mt-1 text-[0.875rem] text-lj-muted">
        {categoryLabel(finding.checkId)} · {STATE_TEXT[finding.state]}
      </p>
      <p className="m-0 mt-2 text-[0.9375rem] leading-[1.5rem]">{finding.explanation}</p>

      {gap !== null ? (
        <div className="mt-3">
          <p className="m-0 text-[0.8125rem] text-lj-muted">
            {gap.kind === 'gap'
              ? 'Arithmetic gap between the stated total and the instalments'
              : gap.kind === 'none'
                ? 'No arithmetic gap between the stated total and the instalments'
                : 'Arithmetic gap could not be calculated from the confirmed inputs'}
          </p>
          <p className="lj-figure m-0" data-testid="finding-figure">
            {gap.kind === 'gap'
              ? `${formatGbp(gap.minor)} GBP`
              : gap.kind === 'none'
                ? '£0.00 GBP'
                : 'Unknown'}
          </p>
          <p className="m-0 mt-1 text-[0.8125rem] text-lj-secondary">
            This is arithmetic only. It is not an amount owed, a legal breach, tax or proof of
            payment.
          </p>
        </div>
      ) : null}

      {payment !== undefined ? (
        <details className="mt-3 text-[0.875rem]">
          <summary className="min-h-6 cursor-pointer">Deterministic calculation</summary>
          <p className="m-0 mt-1">
            Formula: {payment.formula}. Basis: {payment.basis ?? 'unknown'}.
          </p>
          <p className="m-0">
            Stated total{' '}
            {payment.statedTotalPence === null ? 'unknown' : formatGbp(payment.statedTotalPence)} ·
            instalments{' '}
            {payment.comparableSumPence === null
              ? 'unknown'
              : formatGbp(payment.comparableSumPence)}
          </p>
          <p className="m-0 text-lj-secondary">
            Computed by code in whole pence from the figures you confirmed.
          </p>
        </details>
      ) : null}

      {reference !== undefined ? (
        <button
          type="button"
          className="mt-3 min-h-11 rounded border border-lj-edge px-4 text-[0.875rem]"
          onClick={() => {
            setMode('review');
            setFocus({
              documentVersionId: reference.documentVersionId,
              page: reference.page,
              start: reference.start,
              end: reference.end,
            });
          }}
        >
          Open source (page {reference.page})
        </button>
      ) : finding.searchedDocumentVersionIds.length > 0 ? (
        <p className="m-0 mt-3 text-[0.875rem] text-lj-secondary">
          Searched {finding.searchedDocumentVersionIds.length} selected document(s). No quotation
          exists for an absence.
        </p>
      ) : null}

      <p className="m-0 mt-3 text-[0.875rem]" data-testid="finding-disposition">
        <span className="text-lj-muted">Your decision: </span>
        {disposition === null || disposition === undefined
          ? 'none recorded yet. Record it under Review decisions.'
          : (DISPOSITION_TEXT[disposition.kind] ?? disposition.kind.replaceAll('_', ' '))}
      </p>
      <p className="m-0 mt-1 text-[0.8125rem] text-lj-muted">
        Produced by a deterministic check. An assistant suggestion, an extracted fact, a fact you
        confirmed and your decision are kept separate.
      </p>
    </section>
  );
}
