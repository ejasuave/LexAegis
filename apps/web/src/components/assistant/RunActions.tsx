'use client';

import type { RunView } from '@/features/assistant/public';
import { useAssistant } from './assistant-context';
import { ProposalCard } from './ProposalCard';

const button = 'min-h-11 rounded border border-lj-edge px-3 text-[0.8125rem]';

/**
 * Controls the reviewer may operate after a run. Each is an application control from a fixed
 * list; nothing here runs by itself, and none of them approves, signs or freezes anything.
 */
export function RunActions({
  run,
  onOpenSource,
}: {
  run: RunView;
  onOpenSource: (handle: string) => void;
}) {
  const { controller, snapshot } = useAssistant();
  const idle = snapshot.phase === 'idle';
  const actions = run.summary?.nextActions ?? [];
  const proposals = run.summary?.factProposals ?? [];
  if (controller === null) return null;
  const savable = run.complete && run.localStatus === null && run.blocks.length > 0;
  return (
    <>
      {proposals.length > 0 ? (
        <div className="mt-2 grid gap-2" aria-label="Proposed facts">
          {proposals.map((proposal) => (
            <ProposalCard
              key={proposal.proposalId}
              run={run}
              proposal={proposal}
              onOpenSource={onOpenSource}
            />
          ))}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {savable ? (
          <button
            type="button"
            className={button}
            disabled={run.stale || run.save.state === 'saving' || run.save.state === 'saved'}
            data-testid="save-outcome"
            onClick={() => void controller.saveOutcome(run.id)}
          >
            {run.save.state === 'saved'
              ? 'Saved and checked'
              : run.save.state === 'saving'
                ? 'Saving encrypted files'
                : 'Save outcome'}
          </button>
        ) : null}
        {run.origin === 'local' && run.intent === 'check_payments' ? (
          <button
            type="button"
            className={button}
            disabled={!idle}
            data-testid="ask-aegis-payments"
            onClick={() => void controller.action('check_payments')}
          >
            Ask Aegis to explain this result
          </button>
        ) : null}
        {run.origin === 'local' && run.intent === 'missing_evidence' ? (
          <button
            type="button"
            className={button}
            disabled={!idle}
            onClick={() => void controller.action('missing_evidence')}
          >
            Ask Aegis to explain these gaps
          </button>
        ) : null}
        {actions.includes('run_payment_check') ? (
          <button
            type="button"
            className={button}
            disabled={!idle}
            onClick={() => void controller.submit('/check-payments')}
          >
            Run payment check
          </button>
        ) : null}
        {actions.includes('prepare_review') ? (
          <button
            type="button"
            className={button}
            disabled={!idle}
            onClick={() => void controller.action('prepare_review')}
          >
            Prepare review
          </button>
        ) : null}
        {actions.includes('open_status') ? (
          <button
            type="button"
            className={button}
            disabled={!idle}
            onClick={() => void controller.submit('/status')}
          >
            Show status
          </button>
        ) : null}
      </div>
      {savable ? (
        <p
          className="m-0 mt-1 text-[0.8125rem] text-lj-secondary"
          role="status"
          data-testid="save-state"
          data-save={run.save.state}
        >
          {run.save.state === 'saved'
            ? 'Saved to your encrypted vault as an observation. It is not a confirmed fact.'
            : run.save.state === 'failed'
              ? (run.save.message ?? 'Not saved.')
              : run.save.state === 'saving'
                ? 'Saving. Not saved yet.'
                : 'Unsaved. This result exists only in this tab until you save it.'}
        </p>
      ) : null}
    </>
  );
}
