'use client';

import { useId, useState } from 'react';
import type { HistoryAction } from '@/domain/history/response';
import { describeAction, explorerTxUrl } from '@/features/history/public';
import { useHistory } from './history-context';
import { IndexerStatusIndicator } from './IndexerStatusIndicator';
import { ReceiptHistoryDetail } from './ReceiptHistoryDetail';

const button = 'min-h-11 rounded border border-lj-edge px-4 text-[0.875rem] disabled:text-lj-muted';
const short = (value: string): string => `${value.slice(0, 8)}…${value.slice(-4)}`;
const when = (timestamp: string): string => {
  const date = new Date(Number(timestamp) * 1000);
  return Number.isNaN(date.getTime()) ? `timestamp ${timestamp}` : date.toISOString();
};

function Row({ action }: { action: HistoryAction }) {
  const { state, controller, labelFor } = useHistory();
  const commitment = action.kind === 'SUPERSEDE' ? action.relatedCommitment : action.commitment;
  const label = commitment === null ? null : labelFor(commitment, action.reviewer);
  const detailId = useId();
  return (
    <li className="border-b border-lj-divider py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="m-0 text-[0.9375rem]">
          {describeAction(action)}
          {action.provisional ? ' (provisional: newer than the confirmed checkpoint)' : ''}
        </p>
        <span className="text-[0.8125rem] text-lj-secondary">Block {action.blockNumber}</span>
      </div>
      {action.kind === 'SUPERSEDE' &&
      action.commitment !== null &&
      action.relatedCommitment !== null ? (
        <p className="m-0 text-[0.8125rem] text-lj-secondary">
          {short(action.commitment)} replaced by {short(action.relatedCommitment)}
        </p>
      ) : commitment !== null ? (
        <p className="m-0 text-[0.8125rem] text-lj-secondary">
          {label ?? `Receipt ${short(commitment)}`}
        </p>
      ) : (
        <p className="m-0 text-[0.8125rem] text-lj-secondary">Nonce {action.consumedNonce}</p>
      )}
      <div className="mt-1 flex flex-wrap gap-2">
        {commitment !== null ? (
          <button
            type="button"
            className={button}
            aria-pressed={state.selected === commitment}
            onClick={() => void controller?.select(commitment)}
          >
            View receipt
          </button>
        ) : null}
        <details id={detailId}>
          <summary className="min-h-11 cursor-pointer py-2 text-[0.875rem]">Event details</summary>
          <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-3 text-[0.8125rem]">
            <dt>Reviewer</dt>
            <dd className="m-0 break-all">{action.reviewer}</dd>
            {action.executor !== action.reviewer ? (
              <>
                <dt>Submitted by</dt>
                <dd className="m-0 break-all">{action.executor}</dd>
              </>
            ) : null}
            <dt>Observed</dt>
            <dd className="m-0">{when(action.timestamp)}</dd>
            <dt>Raw events</dt>
            <dd className="m-0">
              {action.eventCount} (log {action.firstLogIndex}
              {action.eventCount > 1 ? ` and ${action.lastLogIndex}` : ''})
            </dd>
            <dt>Transaction</dt>
            <dd className="m-0 break-all">
              <a
                href={explorerTxUrl(action.transactionHash)}
                rel="noreferrer noopener"
                target="_blank"
              >
                {action.transactionHash}
              </a>
            </dd>
          </dl>
        </details>
      </div>
    </li>
  );
}

/**
 * Indexed registry activity for the selected account. Public chain data only: the heading says
 * so, and nothing here approves, signs, confirms or verifies a review.
 */
const ADDRESS = /^0x[0-9a-f]{40}$/;

/** Public lookup: any reviewer's registry activity is public, so no passkey is needed to look. */
function ReviewerLookup() {
  const { controller } = useHistory();
  const [value, setValue] = useState('');
  const id = useId();
  const normalized = value.trim().toLowerCase();
  const valid = ADDRESS.test(normalized) && normalized !== `0x${'0'.repeat(40)}`;
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) controller?.setReviewer(normalized);
      }}
    >
      <div>
        <label htmlFor={id} className="block text-[0.875rem]">
          Reviewer address
        </label>
        <input
          id={id}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-hint`}
          className="min-h-11 w-80 max-w-full rounded border border-lj-edge bg-transparent px-3 text-[0.875rem]"
        />
      </div>
      <button type="submit" className={button} disabled={!valid}>
        Show history
      </button>
      <p id={`${id}-hint`} className="m-0 basis-full text-[0.8125rem] text-lj-secondary">
        Registry activity is public. This looks up an address; it does not sign in or approve
        anything.
      </p>
    </form>
  );
}

export function ReviewHistoryPanel() {
  const { state, controller, health } = useHistory();
  const titleId = useId();
  const busy = state.list === 'loading' || state.list === 'loading_more';
  return (
    <section aria-labelledby={titleId} className="max-w-3xl">
      <h2 id={titleId} className="m-0 text-xl font-medium">
        Review history
      </h2>
      <p className="mt-1 text-[0.875rem] text-lj-secondary">
        Public registry activity read from an index. Current status is checked live and shown
        separately.
      </p>
      <p className="m-0 text-[0.875rem]">
        Index: <IndexerStatusIndicator health={health} />
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          disabled={state.reviewer === null || busy}
          onClick={() => void controller?.refresh()}
        >
          Refresh
        </button>
      </div>
      <p role="status" aria-live="polite" className="m-0 mt-2 text-[0.875rem]">
        {state.announcement}
      </p>
      {state.reviewer === null ? (
        <p>Select an account, or enter a reviewer address, to see its review history.</p>
      ) : state.list === 'reset_required' ? (
        <p>History changed while you were reading it. Use Refresh to load it again.</p>
      ) : state.list === 'unavailable' ? (
        <p>
          History is unavailable right now ({state.health?.indexConsistency ?? 'unknown'}). Live
          verification does not depend on it.
        </p>
      ) : state.list === 'failed' ? (
        <p>History could not be read. Try Refresh.</p>
      ) : state.empty ? (
        <p>No indexed history.</p>
      ) : (
        <ol className="m-0 mt-2 list-none p-0" aria-busy={busy}>
          {state.items.map((action) => (
            <Row key={action.id} action={action} />
          ))}
        </ol>
      )}
      {state.nextCursor !== null ? (
        <button
          type="button"
          className={`${button} mt-2`}
          disabled={busy}
          onClick={() => void controller?.loadMore()}
        >
          Load more
        </button>
      ) : null}
      <ReviewerLookup />
      <ReceiptHistoryDetail />
    </section>
  );
}
