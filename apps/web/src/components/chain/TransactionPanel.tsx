'use client';

import { useEffect, useId, useState } from 'react';
import { useAccount } from '@/components/account/account-context';
import { useHistory } from '@/components/history/history-context';
import { IndexerStatusIndicator } from '@/components/history/IndexerStatusIndicator';
import { explorerTxUrl, monText, STAGE_LABEL } from './status';
import { useTransaction } from './transaction-context';
import { readConfirmedLifecycle, type ConfirmedLifecycle } from '@/features/transactions/public';
import { usePublicExplorer } from './explorer';

const btn =
  'min-h-11 rounded border border-lj-edge px-4 text-[0.875rem] aria-disabled:text-lj-muted';

const REASON_TEXT: Record<string, string> = {
  ALREADY_SENT: 'The transaction was already sent. Stop cannot cancel it; check its status.',
  LOCKED: 'The account locked before sending, so nothing was sent.',
  NETWORK: 'The server could not be reached. The request may or may not have arrived.',
  SUBMISSION_UNKNOWN: 'It is not known whether the network accepted the transaction.',
  SESSION_EXPIRED: 'Signing expired. Nothing was sent; unlock and preview again.',
  TICKET_INVALID: 'The quote expired or changed. Renew the quote and confirm again.',
  AUTHORIZATION_REQUIRED: 'The approval signature is missing, so no transaction was prepared.',
};

const LIFECYCLE_TEXT: Record<string, string> = {
  not_found: 'Not found in the registry',
  active: 'Active',
  revoked: 'Revoked',
  superseded: 'Superseded',
};

function useSecondsLeft(expiresAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  return expiresAt === null ? null : Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

/**
 * Stage two: the fee-paying transaction. Sender, network, registry, action, commitment and the
 * expected and maximum fee in MON come from the controller's exact quote. Send transaction is its
 * own confirmation; it never reuses the approval. The outcome, the receipt's live lifecycle and
 * indexer lag are three separate readings.
 */
export function TransactionPanel({ explorerBase }: { explorerBase?: string }) {
  const { controller, state } = useTransaction();
  const { snapshot } = useAccount();
  const history = useHistory();
  const titleId = useId();
  const secondsLeft = useSecondsLeft(state.quote?.expiresAt ?? null);
  const explorer = usePublicExplorer(explorerBase);
  const [lifecycle, setLifecycle] = useState<ConfirmedLifecycle | null>(null);
  const operation = state.operation;
  const preview = state.preview;
  const expired = state.stage === 'awaiting_confirmation' && secondsLeft === 0;

  const reviewer = snapshot.account?.address ?? null;
  const commitment = operation?.commitment ?? null;
  useEffect(() => {
    // Receipt lifecycle is its own live reading, taken only after a transaction is known.
    if (reviewer === null || commitment === null || state.stage === 'idle') return;
    let active = true;
    void readConfirmedLifecycle(reviewer, commitment).then((read) => {
      if (active) setLifecycle(read);
    });
    return () => {
      active = false;
    };
  }, [reviewer, commitment, state.stage]);

  if (state.stage === 'idle') return null;
  return (
    <section aria-labelledby={titleId} className="mt-6" data-testid="transaction-panel">
      <h2 id={titleId} className="m-0 text-lg font-medium">
        Transaction
      </h2>
      <p
        role="status"
        aria-live="polite"
        className="m-0 mt-1 text-[0.9375rem]"
        data-testid="tx-stage"
      >
        {STAGE_LABEL[state.stage]}
      </p>
      {state.reason !== null ? (
        <p className="m-0 mt-1 text-[0.875rem] text-lj-amber">
          {REASON_TEXT[state.reason] ?? `Reason: ${state.reason}`}
        </p>
      ) : null}

      {preview !== null && state.stage === 'awaiting_confirmation' ? (
        <div className="lj-card mt-2 p-3 text-[0.9375rem]">
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.875rem]">
            <dt className="text-lj-muted">Sender</dt>
            <dd className="m-0 break-all font-mono">{preview.account}</dd>
            <dt className="text-lj-muted">Network</dt>
            <dd className="m-0">Monad Testnet (chain {preview.chainId})</dd>
            <dt className="text-lj-muted">Destination registry</dt>
            <dd className="m-0 break-all font-mono">{preview.destination}</dd>
            <dt className="text-lj-muted">Action</dt>
            <dd className="m-0">
              {preview.kind === 'invalidate_nonce'
                ? 'Cancel outstanding authorisations'
                : 'Execute the signed review action'}
            </dd>
            {commitment !== null ? (
              <>
                <dt className="text-lj-muted">Reference</dt>
                <dd className="m-0 break-all font-mono">{commitment}</dd>
              </>
            ) : null}
            <dt className="text-lj-muted">Expected fee</dt>
            <dd className="m-0">{monText(state.quote?.expectedFeeWei ?? null)}</dd>
            <dt className="text-lj-muted">Maximum fee</dt>
            <dd className="m-0">{monText(state.quote?.maxFeeWei ?? preview.maxFeeWei)}</dd>
          </dl>
          <p className="m-0 mt-2 text-[0.8125rem] text-lj-secondary">
            The transaction transfers no MON, but its fee is paid in MON from your account. The
            expected fee is an estimate; the maximum is the most it can cost. This confirmation
            authorises your account to pay that fee and send the transaction. Your earlier signature
            already authorised the registry action; this does not repeat it.
          </p>
          <p className="m-0 mt-1 text-[0.8125rem]" role="timer" aria-live="off">
            {expired ? 'This quote expired.' : `Quote valid for ${secondsLeft ?? 0} s.`}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {expired ? (
              <button type="button" className={btn} onClick={() => void controller?.requote()}>
                Renew quote
              </button>
            ) : (
              <button
                type="button"
                className={`${btn} lj-action`}
                data-testid="send-transaction"
                onClick={() => void controller?.confirmSend()}
              >
                Send transaction
              </button>
            )}
            <button type="button" className={btn} onClick={() => controller?.cancel()}>
              Do not send
            </button>
          </div>
        </div>
      ) : null}

      {operation !== null && state.stage !== 'awaiting_confirmation' ? (
        <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.875rem]">
          <dt className="text-lj-muted">This transaction</dt>
          <dd className="m-0" data-testid="tx-outcome">
            {STAGE_LABEL[state.stage]}
            {state.stage === 'confirmed'
              ? '. Execution was confirmed at a canonical block.'
              : state.stage === 'unknown'
                ? '. The outcome is not known; refresh before doing anything else.'
                : ''}
          </dd>
          {operation.transactionHash !== null ? (
            <>
              <dt className="text-lj-muted">Hash</dt>
              <dd className="m-0 break-all font-mono">{operation.transactionHash}</dd>
            </>
          ) : null}
          {operation.chargedFeeWei !== null ? (
            <>
              <dt className="text-lj-muted">Fee charged</dt>
              <dd className="m-0">{monText(operation.chargedFeeWei)}</dd>
            </>
          ) : null}
          {operation.executedViaAnotherTransaction ? (
            <>
              <dt className="text-lj-muted">Action outcome</dt>
              <dd className="m-0" data-testid="external-execution">
                The disclosed authorisation was executed by another transaction. That is a separate
                fact from this account&apos;s own transaction above.
              </dd>
            </>
          ) : null}
          <dt className="text-lj-muted">Receipt lifecycle</dt>
          <dd className="m-0" data-testid="lifecycle">
            {lifecycle === null
              ? 'Not read yet'
              : lifecycle.status === 'ok'
                ? `${LIFECYCLE_TEXT[lifecycle.receiptLifecycle] ?? 'Unknown'}, as of block ${lifecycle.blockNumber}`
                : 'Unknown: the live read failed'}
            {state.stage === 'confirmed' &&
            lifecycle?.status === 'ok' &&
            lifecycle.receiptLifecycle !== 'active'
              ? '. A confirmed transaction can belong to a receipt that is no longer active.'
              : ''}
          </dd>
          <dt className="text-lj-muted">Indexer</dt>
          <dd className="m-0">
            <IndexerStatusIndicator health={history.health} /> (history only; it cannot confirm a
            transaction or override the live read)
          </dd>
        </dl>
      ) : null}

      {state.stage !== 'awaiting_confirmation' &&
      state.stage !== 'signing' &&
      operation !== null ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            className={btn}
            data-testid="refresh-status"
            onClick={() => void controller?.refresh()}
          >
            Refresh status
          </button>
          {operation.transactionHash !== null && explorer !== null ? (
            <a
              className={`${btn} inline-flex items-center`}
              href={explorerTxUrl(explorer, operation.transactionHash)}
              rel="noopener noreferrer"
              target="_blank"
            >
              Open in explorer
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
