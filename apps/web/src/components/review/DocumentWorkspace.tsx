'use client';

import { DocumentComparison } from './DocumentComparison';
import { DocumentIntakePanel } from './DocumentIntakePanel';
import { DocumentStatusBar } from './DocumentStatusBar';
import { EvidenceChecklist } from './EvidenceChecklist';
import { FindingsPanel } from './FindingsPanel';
import { PaymentWhatIfPanel } from './PaymentWhatIfPanel';
import { useFeatureFlag } from '@/components/shell/feature-flags-context';
import { useReview } from './review-context';
import { SourceViewer } from './SourceViewer';

/** Review mode: the document is dominant; the selected passage is shared by every panel. */
export function ReviewDocuments() {
  const { focus, setFocus } = useReview();
  return (
    <div className="grid gap-6">
      <DocumentIntakePanel />
      <DocumentStatusBar />
      <SourceViewer focus={focus} onFocus={setFocus} />
      <FindingsPanel onFocus={setFocus} />
    </div>
  );
}

/** Evidence column: checklist, comparison and the simulation, clearly separated. */
export function ReviewEvidence() {
  const { setFocus } = useReview();
  // Off by default: when disabled there is no heading, control or empty panel at all.
  const comparison = useFeatureFlag('documentComparison');
  return (
    <div className="grid gap-6">
      <EvidenceChecklist />
      {comparison ? <DocumentComparison onFocus={setFocus} /> : null}
      <PaymentWhatIfPanel />
    </div>
  );
}
