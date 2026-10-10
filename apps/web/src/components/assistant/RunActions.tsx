'use client';

import type { RunView } from '@/features/assistant/public';
import { useAssistant } from './assistant-context';

const button = 'min-h-11 rounded border border-lj-edge px-3 text-[0.8125rem]';

/**
 * Controls the reviewer may operate after a run. Each is an application control from a fixed
 * list; nothing here runs by itself, and none of them approves, signs or freezes anything.
 */
export function RunActions({ run }: { run: RunView }) {
  const { controller, snapshot } = useAssistant();
  const idle = snapshot.phase === 'idle';
  const actions = run.summary?.nextActions ?? [];
  if (controller === null) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
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
  );
}
