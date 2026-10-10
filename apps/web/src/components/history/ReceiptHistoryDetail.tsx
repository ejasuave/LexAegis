'use client';

import { useState } from 'react';
import { useHistory } from './history-context';
import { receiptReferenceText } from '@/features/history/public';

const button = 'min-h-11 rounded border border-lj-edge px-4 text-[0.875rem] disabled:text-lj-muted';
const short = (value: string): string => `${value.slice(0, 10)}…${value.slice(-6)}`;

const LIVE_TEXT: Record<string, string> = {
  not_found: 'Not found on the registry',
  active: 'Active',
  revoked: 'Revoked',
  superseded: 'Replaced by a newer version',
};
const INDEXED_TEXT: Record<string, string> = {
  ACTIVE: 'Active',
  REVOKED: 'Revoked',
  SUPERSEDED: 'Replaced by a newer version',
};
const COMPARISON_TEXT: Record<string, string> = {
  same_block_match: 'Index and live registry agree at the same block.',
  same_block_mismatch:
    'Index and live registry differ at the same block. Treat the live result as current.',
  different_checkpoints:
    'Index and live registry were read at different blocks, so they are not compared.',
  unavailable: 'No comparison is available.',
};

/** Indexed lifecycle and live verification for one receipt, as two separate readings. */
export function ReceiptHistoryDetail() {
  const { state, controller, labelFor } = useHistory();
  const [copied, setCopied] = useState(false);
  const detail = state.detail;
  if (state.selected === null) return null;
  if (state.detailState === 'loading' || (detail === null && state.detailState === 'idle')) {
    return <p role="status">Reading receipt history…</p>;
  }
  if (detail === null) {
    return (
      <p role="status">
        {state.detailState === 'unavailable'
          ? 'Receipt history is unavailable. Live verification is separate.'
          : 'Receipt history could not be read.'}
      </p>
    );
  }
  const label = labelFor(detail.commitment, detail.reviewer);
  const indexed = detail.indexed;
  const previous = indexed.state === 'indexed' ? indexed.predecessor : null;
  const next = indexed.state === 'indexed' ? indexed.successor : null;
  const cfg = detail.health.configured;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        receiptReferenceText({
          chainId: cfg.chainId,
          registryAddress: cfg.registryAddress,
          reviewer: detail.reviewer,
          commitment: detail.commitment,
        }),
      );
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section aria-label="Selected receipt" className="mt-4 rounded border border-lj-edge p-3">
      <h3 className="m-0 text-base font-medium">
        {label ?? `Receipt ${short(detail.commitment)}`}
      </h3>
      <p className="m-0 mt-1 break-all text-[0.8125rem] text-lj-secondary">
        Commitment {detail.commitment}
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div aria-label="Indexed lifecycle">
          <h4 className="m-0 text-[0.875rem] font-medium">Indexed history</h4>
          <p className="m-0 text-[0.875rem]">
            {indexed.state === 'not_indexed'
              ? 'Not indexed yet. This is not the same as not found.'
              : INDEXED_TEXT[indexed.lifecycle]}
          </p>
          <p className="m-0 text-[0.8125rem] text-lj-secondary">
            Index at block {detail.health.index?.progressBlock ?? 'unknown'}
          </p>
        </div>
        <div aria-label="Live verification">
          <h4 className="m-0 text-[0.875rem] font-medium">Live registry</h4>
          {detail.live.status === 'ok' ? (
            <>
              <p className="m-0 text-[0.875rem]">{LIVE_TEXT[detail.live.receiptStatus]}</p>
              <p className="m-0 text-[0.8125rem] text-lj-secondary">
                Read at block {detail.live.checkpointBlock}
              </p>
            </>
          ) : (
            <p className="m-0 text-[0.875rem]">
              Unknown. The registry could not be read ({detail.live.reason}).
            </p>
          )}
        </div>
      </div>
      <p className="mt-2 text-[0.8125rem] text-lj-secondary">
        {COMPARISON_TEXT[detail.comparison]}
      </p>
      {detail.provisionalNewerThanLive ? (
        <p className="m-0 text-[0.8125rem]">
          Provisional: the index is ahead of the confirmed live checkpoint.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          disabled={previous === null}
          onClick={() => void controller?.select(previous)}
        >
          Previous review
        </button>
        <button
          type="button"
          className={button}
          disabled={next === null}
          onClick={() => void controller?.select(next)}
        >
          Next review
        </button>
        <button type="button" className={button} onClick={() => void copy()}>
          Copy receipt reference
        </button>
        <button type="button" className={button} onClick={() => void controller?.select(null)}>
          Close
        </button>
      </div>
      <p role="status" className="m-0 mt-1 text-[0.8125rem] text-lj-secondary">
        {copied ? 'Receipt reference copied.' : ''}
      </p>
    </section>
  );
}
