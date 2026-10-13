'use client';

import type { CheckFindingV1 } from '@lexaegis/agent/contracts';
import { formatGbp } from '@lexaegis/agent/review';
import { useHud } from '@/components/hud/hud-context';
import { useWorkspace } from '@/components/shell/workspace-context';
import { useReview } from './review-context';
import { btn, h2, muted, type Focus } from './styles';

const STATE_LABEL: Record<CheckFindingV1['state'], string> = {
  ok: 'Checked',
  attention: 'Needs attention',
  needs_input: 'Needs input',
  not_comparable: 'Not comparable',
  technical_failure: 'Technical failure',
};
const STATE_MARK: Record<CheckFindingV1['state'], string> = {
  ok: '✓',
  attention: '!',
  needs_input: '?',
  not_comparable: '≠',
  technical_failure: '✕',
};
const STATE_COLOUR: Record<CheckFindingV1['state'], string> = {
  ok: 'text-lj-positive',
  attention: 'text-lj-amber',
  needs_input: 'text-lj-secondary',
  not_comparable: 'text-lj-secondary',
  technical_failure: 'text-lj-error',
};

/**
 * Plain findings from deterministic checks. There is no legal-validity verdict, risk score or
 * all-clear: each line says only what was checked, with its sources.
 */
export function FindingsPanel({ onFocus }: { onFocus: (focus: Focus) => void }) {
  const { controller, snapshot } = useReview();
  const { checks } = snapshot;
  const { selectedFindingId } = useHud();
  const { setSelectedFindingId } = useWorkspace();
  return (
    <section aria-label="Findings" className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className={h2}>Findings</h2>
        <button
          type="button"
          className={btn}
          disabled={controller === null || snapshot.documents.every((d) => !d.selected)}
          onClick={() => void controller?.runChecks()}
        >
          Run checks
        </button>
      </div>
      <p role="status" aria-live="polite" className={muted}>
        {checks.status === 'none' ? 'No checks have been run.' : null}
        {checks.status === 'running' ? 'Checking…' : null}
        {checks.status === 'stale'
          ? 'These results are out of date: an input changed. Run checks again.'
          : null}
        {checks.status === 'fresh' ? 'Checked the current inputs.' : null}
        {checks.reviewRecord
          ? ` Rule pack review state: ${checks.reviewRecord.state === 'demo_draft' ? 'demo draft, not reviewed by a qualified person' : checks.reviewRecord.state}.`
          : ''}
      </p>
      <ul className={`m-0 mt-2 list-none p-0 ${checks.status === 'stale' ? 'opacity-60' : ''}`}>
        {checks.findings.map((finding) => {
          const reference = finding.references[0];
          return (
            <li
              key={finding.findingId}
              data-hud-finding={finding.findingId}
              aria-current={selectedFindingId === finding.findingId ? 'true' : undefined}
              className="border-b border-lj-divider py-2 text-[0.875rem]"
            >
              <p className="m-0">
                <span className={STATE_COLOUR[finding.state]} aria-hidden="true">
                  {STATE_MARK[finding.state]}{' '}
                </span>
                <strong>{STATE_LABEL[finding.state]}.</strong> {finding.explanation}
              </p>
              <button
                type="button"
                className={`${btn} mt-1 mr-2`}
                aria-pressed={selectedFindingId === finding.findingId}
                onClick={() => setSelectedFindingId(finding.findingId)}
              >
                Explain in the side panel
              </button>
              {reference ? (
                <button
                  type="button"
                  className={`${btn} mt-1`}
                  onClick={() =>
                    onFocus({
                      documentVersionId: reference.documentVersionId,
                      page: reference.page,
                      start: reference.start,
                      end: reference.end,
                    })
                  }
                >
                  Open source (page {reference.page})
                </button>
              ) : finding.searchedDocumentVersionIds.length > 0 ? (
                <p className="m-0 mt-1 text-lj-secondary">
                  Searched {finding.searchedDocumentVersionIds.length} selected document(s). No
                  quotation exists for an absence.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {checks.payments.map((p) => (
        <div
          key={p.group}
          className="mt-3 rounded border border-lj-divider p-3 text-[0.875rem]"
          aria-label={`Payment calculation ${p.group}`}
        >
          <h3 className="m-0 text-base font-medium">Payment calculation ({p.group})</h3>
          <p className="m-0 mt-1">
            Formula: {p.formula}. Basis: {p.basis ?? 'unknown'}.
          </p>
          <p className="m-0">
            Stated total {p.statedTotalPence ? formatGbp(p.statedTotalPence) : 'unknown'} ·
            instalments {p.comparableSumPence ? formatGbp(p.comparableSumPence) : 'unknown'} ·
            difference {p.differencePence ? formatGbp(p.differencePence) : 'unknown'}
          </p>
          <p className="m-0 text-lj-secondary">
            Arithmetic consistency only. Not tax, entitlements or proof of payment. Result:{' '}
            {p.outcome.replaceAll('_', ' ')}.
          </p>
        </div>
      ))}
    </section>
  );
}
