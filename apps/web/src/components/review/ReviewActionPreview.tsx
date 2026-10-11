'use client';

import { useId } from 'react';
import { useVault } from '@/components/vault/vault-context';
import type { ApprovalFailure } from '@/features/review/public';
import { useApproval } from './approval-context';
import { usePackage } from './package-context';

const btn =
  'min-h-11 rounded border border-lj-edge px-4 text-[0.875rem] aria-disabled:text-lj-muted';

const FAILURE_TEXT: Record<ApprovalFailure, string> = {
  NO_ACCOUNT: 'There is no account. Create or unlock one first.',
  SESSION_LOCKED: 'Signing is locked. Unlock your account, then preview again.',
  BACKEND_SIGNED_OUT: 'The service has not signed this account in.',
  NO_REGISTRY: 'No registry is configured, so nothing can be approved on this network.',
  CAPTURE_NOT_VERIFIED:
    'This package has not been read back and verified in this unlock. Reopen it first; nothing stored can claim that for you.',
  USE_SUPERSEDE: 'This package replaces an earlier one and must be approved as a replacement.',
  NOT_A_REPLACEMENT: 'This package does not name an earlier receipt to replace.',
  SCOPE_MISMATCH: 'The package belongs to a different account, network or registry.',
  DECISION_LOG_INVALID:
    'The package does not contain a complete record of your review decisions, so it cannot be approved.',
  CHAIN_UNKNOWN: 'The network state could not be read. That is not the same as “not published”.',
  STALE_OBSERVATION: 'The network reading is more than 15 seconds old. Preview again.',
  LIFECYCLE_REJECTED: 'The receipt is not in the state this action needs, so it was not offered.',
  CHANGED: 'The network state changed, so the preview was discarded. Nothing was signed.',
  ACTION_INVALID: 'The action could not be built from these values.',
  PREVIEW_REFUSED: 'The signing controller did not accept this preview.',
  NOT_TRUSTED: 'Approval needs a direct click or key press by you.',
  NO_PREVIEW: 'There is no current preview. Preview the approval again.',
  BUSY: 'Another step is still running.',
  PREVIEW_EXPIRED: 'The preview expired. Nothing was signed; preview again.',
  USER_CANCELLED: 'Cancelled. Nothing was signed.',
  SIGNING_FAILED: 'The signature could not be produced. Nothing was signed.',
  STALE: 'Something changed, so nothing was signed.',
};

/**
 * Stage one. It shows exactly what will be authorised, taken from the verified package and live
 * network reads, and offers one dedicated approval control. The sentence on the button says what
 * it does and does not approve; no other control, timer or result can trigger it.
 */
export function ReviewActionPreview() {
  const { controller, snapshot } = useApproval();
  const pkg = usePackage();
  const vault = useVault();
  const titleId = useId();
  const frozen = pkg.snapshot.frozen;
  const verified = frozen !== null && frozen.state === 'recoverable' ? frozen.commitment : null;
  const saved = vault.snapshot.selectedMatter?.frozenReviews ?? [];
  const { stage, display, failure, notice } = snapshot;

  const subject = verified === null ? null : vault.handle?.recoverableSubject(verified);
  const kind = subject?.supersedes != null ? 'supersede' : 'issue';

  return (
    <section aria-labelledby={titleId} className="mt-6" data-testid="action-preview">
      <h2 id={titleId} className="m-0 text-lg font-medium">
        Approval
      </h2>
      {verified === null ? (
        <>
          <p className="m-0 mt-2 text-[0.875rem] text-lj-secondary">
            Nothing can be approved yet. Freeze and save a review package, or reopen a saved one so
            it is read back and verified in this unlock.
          </p>
          {saved.length > 0 ? (
            <ul className="m-0 mt-2 list-none p-0">
              {saved.map((item) => (
                <li key={item.commitment} className="flex flex-wrap items-center gap-2 py-1">
                  <span className="font-mono text-[0.8125rem] break-all">
                    {item.commitment.slice(0, 18)}…
                  </span>
                  <button
                    type="button"
                    className={btn}
                    onClick={() => void pkg.controller?.reconnect(item.commitment)}
                  >
                    Verify saved package
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <button type="button" aria-disabled="true" className={`${btn} mt-2 text-lj-muted`}>
            Approve this package
          </button>
          <p className="m-0 mt-1 text-[0.8125rem] text-lj-secondary">
            Unavailable: there is no verified frozen package.
          </p>
        </>
      ) : null}

      {verified !== null && (stage === 'idle' || stage === 'failed') ? (
        <div className="mt-2">
          <p className="m-0 text-[0.875rem] text-lj-secondary">
            The package is saved and verified. Preview the approval to see exactly what you would be
            authorising.
          </p>
          <button
            type="button"
            className={`${btn} mt-2`}
            data-testid="preview-approval"
            onClick={() => void controller?.prepare({ kind, commitment: verified })}
          >
            Check network and preview approval
          </button>
        </div>
      ) : null}
      {stage === 'checking' ? (
        <p role="status" className="m-0 mt-2 text-[0.9375rem]">
          {notice || 'Checking the network…'}
        </p>
      ) : null}

      {display !== null && (stage === 'preview' || stage === 'signing') ? (
        <div className="lj-card mt-3 p-3 text-[0.9375rem]" data-testid="approval-details">
          <h3 className="m-0 text-base font-medium">
            {display.kind === 'supersede'
              ? 'Replace an earlier receipt with this package'
              : display.kind === 'revoke'
                ? 'Revoke this receipt'
                : 'Approve this review package'}
          </h3>
          <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.875rem]">
            <dt className="text-lj-muted">Signing account</dt>
            <dd className="m-0 break-all font-mono">{display.reviewer}</dd>
            <dt className="text-lj-muted">Network</dt>
            <dd className="m-0">Monad Testnet (chain {display.chainId})</dd>
            <dt className="text-lj-muted">Registry</dt>
            <dd className="m-0 break-all font-mono">{display.registryAddress}</dd>
            <dt className="text-lj-muted">Package commitment</dt>
            <dd className="m-0 break-all font-mono">{display.commitment}</dd>
            {display.predecessor !== null ? (
              <>
                <dt className="text-lj-muted">Replaces</dt>
                <dd className="m-0 break-all font-mono">{display.predecessor}</dd>
              </>
            ) : null}
            {display.scope !== null ? (
              <>
                <dt className="text-lj-muted">Scope</dt>
                <dd className="m-0">
                  {display.scope.artifactCount} artifacts:{' '}
                  {display.scope.roles.map((r) => `${r.role} × ${r.count}`).join(', ')}
                </dd>
                <dt className="text-lj-muted">Your decisions</dt>
                <dd className="m-0">
                  {display.decisionCount}. Rule pack:{' '}
                  {display.rulePackReviewState === 'reviewed'
                    ? 'reviewed'
                    : 'demonstration draft, not reviewed by a qualified person'}
                </dd>
              </>
            ) : null}
          </dl>
          {display.concerns.length > 0 ? (
            <>
              <h4 className="m-0 mt-3 text-[0.9375rem] font-medium">
                Unresolved concerns you accepted, in your words
              </h4>
              <ul className="m-0 mt-1 list-disc pl-5 text-[0.875rem]">
                {display.concerns.map((c) => (
                  <li key={c.findingId} className="break-words">
                    {c.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <details className="mt-3 text-[0.8125rem]">
            <summary className="min-h-6 cursor-pointer">Cryptographic details</summary>
            <p className="m-0 mt-1">
              Registry nonce: <span className="font-mono">{display.nonce}</span>
            </p>
            <p className="m-0">
              Action valid until (Unix seconds):{' '}
              <span className="font-mono">{display.deadline}</span>
            </p>
            <p className="m-0">
              Read at block {display.observedBlock}, {display.observedAt}
            </p>
          </details>
          <p className="m-0 mt-3 text-[0.875rem]" data-testid="approval-statement">
            This approves the specified review package only. It does not approve the settlement
            agreement, say it is legally correct or confirm any professional qualification. The
            approval signature authorises execution: once it is disclosed it may be submitted by
            anyone, once, even if you close this screen before sending your own transaction.
          </p>
          <button
            type="button"
            className={`${btn} lj-action mt-3`}
            data-testid="approve-package"
            aria-disabled={stage === 'signing'}
            onClick={(event) => {
              if (stage === 'signing') return;
              void controller?.approve({ trusted: event.nativeEvent.isTrusted });
            }}
          >
            {display.kind === 'revoke' ? 'Revoke this receipt' : 'Approve this package'}
          </button>
          <button
            type="button"
            className={`${btn} ml-2`}
            onClick={() => controller?.cancelPreview()}
          >
            Cancel preview
          </button>
          {stage === 'signing' ? (
            <p role="status" className="m-0 mt-2">
              {notice}
            </p>
          ) : null}
        </div>
      ) : null}

      {stage === 'signed' ? (
        <p role="status" className="m-0 mt-3 text-[0.9375rem]" data-testid="approval-signed">
          Approval signed; publication not confirmed. Nothing is published until you separately send
          the transaction and the network confirms it.
        </p>
      ) : null}
      <p role="status" aria-live="polite" className="m-0 mt-2 text-[0.875rem] text-lj-secondary">
        {failure !== null ? FAILURE_TEXT[failure] : stage === 'preview' ? '' : notice}
      </p>
    </section>
  );
}
