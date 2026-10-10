'use client';

import { useState } from 'react';
import type { FactProposal } from '@lexaegis/agent/contracts';
import { formatGbp } from '@lexaegis/agent/review';
import type { RunView } from '@/features/assistant/public';
import { useAssistant } from './assistant-context';

const button = 'min-h-11 rounded border border-lj-edge px-3 text-[0.8125rem]';

const FIELD_LABEL: Record<FactProposal['field'], string> = {
  employer: 'Employer',
  employee: 'Employee',
  adviser_name: 'Adviser name',
  adviser_organisation: 'Adviser organisation',
  agreement_date: 'Agreement date',
  termination_date: 'Termination date',
  payment_total: 'Payment total (pence)',
  payment_instalment: 'Payment instalment (pence)',
  payment_basis: 'Payment basis',
};

const money = (field: FactProposal['field'], value: string): string =>
  (field === 'payment_total' || field === 'payment_instalment') &&
  /^(0|[1-9][0-9]{0,17})$/.test(value)
    ? ` (${formatGbp(value)})`
    : '';

/**
 * One proposed fact beside its source. It is a proposal until you choose Confirm; nothing a
 * model, a file or a typed reply says can confirm it. Edit lets you correct the value first.
 */
export function ProposalCard({
  run,
  proposal,
  onOpenSource,
}: {
  run: RunView;
  proposal: FactProposal;
  onOpenSource: (handle: string) => void;
}) {
  const { controller } = useAssistant();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(proposal.value);
  const [busy, setBusy] = useState(false);
  const decided = run.proposals[proposal.proposalId];
  const inputId = `proposal-${run.id}-${proposal.proposalId}`;

  const confirm = async () => {
    if (controller === null || busy) return;
    setBusy(true);
    await controller.confirmProposal(
      run.id,
      proposal.proposalId,
      editing && value.trim() !== proposal.value ? value : undefined,
    );
    setBusy(false);
  };

  return (
    <div
      className="rounded border border-lj-edge p-2 text-[0.875rem]"
      data-testid="fact-proposal"
      data-proposal={proposal.proposalId}
      data-decision={decided ?? 'open'}
    >
      <p className="m-0">
        <span className="text-lj-muted">Proposed, not confirmed: </span>
        {FIELD_LABEL[proposal.field]}: <strong>{proposal.value}</strong>
        {money(proposal.field, proposal.value)}
      </p>
      <p className="m-0 mt-1 text-[0.8125rem] text-lj-secondary">
        Group {proposal.group}, slot {proposal.slot}. Shown by {proposal.sources.join(', ')}.
      </p>
      <div className="mt-1 flex flex-wrap gap-2">
        {proposal.sources.map((handle) => (
          <button
            key={handle}
            type="button"
            className={button}
            onClick={() => onOpenSource(handle)}
          >
            Open source {handle}
          </button>
        ))}
      </div>
      {decided === undefined ? (
        <>
          {editing ? (
            <div className="mt-2">
              <label htmlFor={inputId} className="block text-[0.8125rem] text-lj-secondary">
                Corrected value
              </label>
              <input
                id={inputId}
                className="min-h-11 w-full rounded border border-lj-edge bg-transparent px-2"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                data-testid="proposal-edit-value"
              />
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => void confirm()}
              data-testid="proposal-confirm"
            >
              {editing ? 'Confirm corrected value' : 'Confirm'}
            </button>
            <button
              type="button"
              className={button}
              onClick={() => setEditing((on) => !on)}
              data-testid="proposal-edit"
            >
              {editing ? 'Cancel edit' : 'Edit'}
            </button>
            <button
              type="button"
              className={button}
              onClick={() => controller?.dismissProposal(run.id, proposal.proposalId)}
              data-testid="proposal-dismiss"
            >
              Dismiss
            </button>
          </div>
        </>
      ) : (
        <p className="m-0 mt-2 text-[0.8125rem]" role="status">
          {decided === 'confirmed'
            ? 'Confirmed by you. Save facts to keep it.'
            : 'Dismissed. Nothing was recorded.'}
        </p>
      )}
    </div>
  );
}
