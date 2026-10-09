'use client';

import { useMemo, useState } from 'react';
import { reconcilePayments, formatGbp } from '@lexaegis/agent/review';
import { useReview } from './review-context';
import { btn, field, h2, muted } from './styles';

interface Row {
  readonly id: string;
  readonly amount: string;
}

const pounds = (pence: string) => {
  const p = pence.padStart(3, '0');
  return `${p.slice(0, -2)}.${p.slice(-2)}`;
};

/**
 * SIMULATED. Copies the real figures into isolated state, runs the same arithmetic kernel in
 * simulation mode and shows the difference from the actual figures. It cannot update a fact,
 * a finding, source bytes, package readiness or any transaction, and it is cleared on lock.
 */
export function PaymentWhatIfPanel() {
  const { snapshot } = useReview();
  const actual = snapshot.checks.payments.find((p) => p.mode === 'review') ?? null;
  const seed = useMemo(
    () => ({
      total: actual?.statedTotalPence ? pounds(actual.statedTotalPence) : '',
      rows: (actual?.includedItems ?? []).map((i) => ({
        id: i.lineItemId,
        amount: pounds(i.amountPence),
      })),
    }),
    [actual],
  );
  const [total, setTotal] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const shownTotal = total ?? seed.total;
  const shownRows = rows ?? seed.rows;

  const result = useMemo(
    () =>
      reconcilePayments({
        mode: 'simulation',
        group: 'settlement',
        statedTotal:
          shownTotal === ''
            ? null
            : {
                amount: shownTotal,
                currency: 'GBP',
                basis: actual?.basis ?? 'gross',
                confirmed: false,
              },
        items: shownRows.map((r) => ({
          lineItemId: r.id,
          amount: r.amount,
          currency: 'GBP',
          basis: actual?.basis ?? 'gross',
          sourceKey: `sim:${r.id}`,
          factId: null,
          confirmed: false,
        })),
      }),
    [shownTotal, shownRows, actual],
  );

  return (
    <section
      aria-label="Payment what-if (simulated)"
      className="min-w-0 rounded border border-lj-violet p-3"
    >
      <h2 className={h2}>
        Payment what-if <span className="text-lj-violet">SIMULATED</span>
      </h2>
      <p className={muted}>
        Hypothetical figures only. Nothing here changes the agreement, your confirmed facts, the
        findings or any package. A changed figure needs a new source version and a new review.
      </p>
      {actual === null ? (
        <p className={muted}>
          Run the checks with confirmed payment facts to start from the real figures.
        </p>
      ) : null}
      <label className="mt-2 block text-[0.875rem]">
        SIMULATED stated total (£)
        <input className={field} value={shownTotal} onChange={(e) => setTotal(e.target.value)} />
      </label>
      {shownRows.map((row, index) => (
        <label key={row.id} className="mt-2 block text-[0.875rem]">
          SIMULATED instalment {index + 1} (£)
          <input
            className={field}
            value={row.amount}
            onChange={(e) =>
              setRows(
                shownRows.map((r) => (r.id === row.id ? { ...r, amount: e.target.value } : r)),
              )
            }
          />
        </label>
      ))}
      <button
        type="button"
        className={`${btn} mt-2`}
        onClick={() => {
          setTotal(null);
          setRows(null);
        }}
      >
        Reset
      </button>
      <p
        role="status"
        aria-live="polite"
        className="m-0 mt-2 text-[0.875rem]"
        data-testid="simulation-result"
      >
        SIMULATED result: {result.outcome.replaceAll('_', ' ')}
        {result.differencePence !== null
          ? ` · difference ${formatGbp(result.differencePence)}`
          : ''}
        {actual?.differencePence != null
          ? ` · actual difference ${formatGbp(actual.differencePence)}`
          : ''}
      </p>
    </section>
  );
}
