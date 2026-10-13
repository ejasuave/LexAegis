'use client';

import { useApproval } from '@/components/review/approval-context';
import { isCeremonyStage } from './ceremony';
import { useHud } from './hud-context';
import { SelectedFinding } from './SelectedFinding';
import { TransactionPanel } from '@/components/chain/TransactionPanel';
import { ReadinessPanel } from '@/components/shell/ReadinessPanel';
import { DecisionsPanel } from '@/components/review/DecisionsPanel';
import { ReviewEvidence } from '@/components/review/DocumentWorkspace';
import { PackagePanel } from '@/components/review/PackagePanel';
import { ReceiptActions } from '@/components/review/ReceiptActions';
import { ReviewActionPreview } from '@/components/review/ReviewActionPreview';
import { SavedReviews } from '@/components/review/SavedReviews';

/**
 * Right rail: evidence and explanation first. The package and action preview follow only as the
 * reviewer's own controls; nothing here approves, signs or confirms by being shown.
 */
export function AttentionRail() {
  const { view, receipt } = useHud();
  const ceremony = isCeremonyStage(useApproval().snapshot.stage);
  const unresolved = view.attention.unresolvedCount;
  return (
    <div className="lj-rail-inner lj-marks" data-hud-quiet="">
      {receipt.label === null ? null : (
        <p
          data-testid="receipt-label"
          data-kind={receipt.label.kind}
          className={`m-0 mb-3 text-[0.9375rem] ${receipt.label.kind === 'correction' ? 'text-lj-amber' : 'text-lj-cyan'}`}
        >
          {receipt.label.text}
        </p>
      )}
      <SelectedFinding />
      <section aria-label="Findings and evidence" className="lj-rule pt-3">
        <h2 className="m-0 text-lg font-medium" data-hud-findings-control="">
          Evidence
        </h2>
        {unresolved > 0 ? (
          <p className="m-0 mt-1 text-[0.875rem] text-lj-amber" role="status">
            {String(unresolved)} finding{unresolved === 1 ? '' : 's'} still need
            {unresolved === 1 ? 's' : ''} your decision.
          </p>
        ) : null}
        <p className="m-0 mt-2 text-[0.875rem] text-lj-secondary">
          Select a finding to see its source passage and calculation.
        </p>
        <div className="mt-3">
          <ReviewEvidence />
        </div>
      </section>
      <section aria-label="Review package and approval" className="lj-rule mt-4 pt-3">
        <DecisionsPanel />
        <PackagePanel />
        {ceremony ? <ReviewActionPlaceholder /> : <ReviewActionPreview />}
        <TransactionPanel />
        <ReceiptActions />
        <SavedReviews />
        <ReadinessPanel />
      </section>
    </div>
  );
}

/** While the approval dialog is open the preview lives there; the rail says so. */
function ReviewActionPlaceholder() {
  return (
    <section aria-label="Approval" className="mt-6">
      <h2 className="m-0 text-lg font-medium">Approval</h2>
      <p className="m-0 mt-2 text-[0.875rem] text-lj-secondary" role="status">
        The approval is open in its own window.
      </p>
    </section>
  );
}
