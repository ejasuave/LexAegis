'use client';

import { useId, useState } from 'react';
import {
  MAX_REASON_BYTES,
  REASON_REQUIRED,
  type DecisionFailure,
  type DispositionKind,
  type FindingView,
} from '@/features/review/public';
import { useDecisions } from './decision-context';

const KIND_LABEL: Record<DispositionKind, string> = {
  acknowledged: 'Acknowledge',
  accepted_unresolved: 'Accept unresolved concern',
  not_applicable: 'Not applicable',
  requires_change: 'Requires change',
};

const FAILURE_TEXT: Partial<Record<DecisionFailure, string>> = {
  REASON_REQUIRED: 'A reason is required for this choice.',
  REASON_TOO_LONG: 'The reason is longer than 2 KiB.',
  NOT_WAIVABLE: 'A technical failure cannot be waived. Fix the cause and run the checks again.',
  KIND_NOT_ALLOWED: 'That choice is not available for this result.',
  ACCOUNT_LOCKED: 'Unlock your account to record a decision.',
  NOT_READY: 'Run the checks first; decisions apply to current results only.',
  STALE: 'The results changed. Review them again.',
  ENTRY_TOO_LARGE: 'That reason is too large to save once encoded.',
  OUTSTANDING: 'Some findings still need your decision.',
  TECHNICAL_FAILURE: 'A technical failure blocks the review. It cannot be waived.',
  REQUIRES_CHANGE: 'A finding is marked as requiring change. Resolve it first.',
  VAULT: 'The decision could not be saved to your working copy.',
};

function Row({ view }: { view: FindingView }) {
  const { controller } = useDecisions();
  const reasonId = useId();
  const [kind, setKind] = useState<DispositionKind | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const { finding, disposition } = view;
  const clean = finding.state === 'ok';
  const needsReason = kind !== null && REASON_REQUIRED.has(kind);

  return (
    <li
      className="border-b border-lj-divider py-3 text-[0.9375rem]"
      data-finding={finding.findingId}
    >
      <p className="m-0 break-words">
        <strong>{finding.state.replaceAll('_', ' ')}.</strong> {finding.explanation}
      </p>
      {disposition !== null ? (
        <p className="m-0 mt-1 text-[0.875rem] text-lj-positive" data-testid="disposition-recorded">
          Your decision: {KIND_LABEL[disposition.kind]}
          {disposition.reason !== '' ? ` — ${disposition.reason}` : ''}. The check result itself is
          unchanged.
          <button
            type="button"
            className="ml-2 min-h-11 rounded border border-lj-edge px-3 text-[0.8125rem]"
            onClick={() => controller?.withdraw(finding.findingId)}
          >
            Withdraw
          </button>
        </p>
      ) : finding.state === 'technical_failure' ? (
        <p className="m-0 mt-1 text-[0.875rem] text-lj-error">
          Technical failure: this cannot be acknowledged or waived.
        </p>
      ) : clean ? (
        <p className="m-0 mt-1 text-[0.875rem] text-lj-secondary">
          Checked. No decision is needed.
        </p>
      ) : (
        <fieldset className="m-0 mt-2 border-0 p-0">
          <legend className="text-[0.875rem] text-lj-secondary">Your decision</legend>
          <div className="flex flex-wrap gap-2">
            {view.allowed.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={kind === option}
                className={`min-h-11 rounded border px-3 text-[0.875rem] ${
                  kind === option ? 'border-lj-cyan' : 'border-lj-edge'
                }`}
                onClick={() => setKind(option)}
              >
                {KIND_LABEL[option]}
              </button>
            ))}
          </div>
          {kind !== null ? (
            <div className="mt-2">
              <label htmlFor={reasonId} className="block text-[0.875rem]">
                Reason{needsReason ? ' (required)' : ' (optional)'}
              </label>
              <textarea
                id={reasonId}
                value={reason}
                rows={2}
                onChange={(event) => setReason(event.target.value)}
                aria-describedby={`${reasonId}-help`}
                className="mt-1 w-full rounded border border-lj-edge bg-lj-soft px-3 py-2 text-base text-lj-text"
              />
              <p id={`${reasonId}-help`} className="m-0 text-[0.8125rem] text-lj-muted">
                Up to {MAX_REASON_BYTES.toLocaleString()} bytes. Your own words; nothing is
                pre-filled.
              </p>
              <button
                type="button"
                className="mt-2 min-h-11 rounded border border-lj-edge px-4 text-[0.875rem]"
                onClick={() => {
                  const result = controller?.decide({ findingId: finding.findingId, kind, reason });
                  if (result === undefined) return;
                  if (result.ok) {
                    setMessage('');
                    setKind(null);
                    setReason('');
                  } else {
                    setMessage(FAILURE_TEXT[result.code] ?? 'The decision was not recorded.');
                  }
                }}
              >
                Save my decision
              </button>
            </div>
          ) : null}
        </fieldset>
      )}
      {message !== '' ? (
        <p role="alert" className="m-0 mt-1 text-[0.875rem] text-lj-error">
          {message}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The human-review gate: every finding that needs a decision gets one from the reviewer, in
 * their own words. Recording decisions builds the decision log; it is not approval and signs
 * nothing.
 */
export function DecisionsPanel() {
  const { controller, snapshot } = useDecisions();
  const [message, setMessage] = useState('');
  const outstanding = snapshot.findings.filter(
    (v) =>
      v.finding.state !== 'ok' && v.finding.state !== 'technical_failure' && v.disposition === null,
  );
  return (
    <section aria-label="Review decisions" className="mt-4" data-testid="decisions-panel">
      <h2 className="m-0 text-lg font-medium">Review decisions</h2>
      {snapshot.findings.length === 0 ? (
        <p className="m-0 mt-2 text-[0.875rem] text-lj-secondary">
          No current results. Run the checks to see findings that need a decision.
        </p>
      ) : (
        <>
          <p
            className="m-0 mt-2 text-[0.875rem] text-lj-secondary"
            role="status"
            aria-live="polite"
          >
            {outstanding.length === 0
              ? 'Every finding has a decision or needs none.'
              : `${outstanding.length} finding(s) need your decision.`}
            {snapshot.stale
              ? ' Inputs changed after decisions were recorded; record them again.'
              : ''}
          </p>
          <ul className="m-0 mt-1 list-none p-0">
            {snapshot.findings.map((view) => (
              <Row key={`${view.finding.findingId}:${view.findingDigest}`} view={view} />
            ))}
          </ul>
          <button
            type="button"
            className="mt-3 min-h-11 rounded border border-lj-edge px-4 text-[0.875rem]"
            data-testid="record-decisions"
            onClick={() => {
              void controller?.record().then((result) => {
                setMessage(
                  result.ok
                    ? 'Decisions recorded for these exact results. This is not approval.'
                    : (FAILURE_TEXT[result.code] ?? 'Decisions could not be recorded.'),
                );
              });
            }}
          >
            Record review decisions
          </button>
          <p role="status" aria-live="polite" className="m-0 mt-1 text-[0.875rem]">
            {snapshot.recorded ? 'Decisions recorded. Recording is not approval.' : message}
          </p>
        </>
      )}
    </section>
  );
}
