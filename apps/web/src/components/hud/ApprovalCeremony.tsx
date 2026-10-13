'use client';

import { useEffect, useRef, type KeyboardEvent } from 'react';
import { ReviewActionPreview } from '@/components/review/ReviewActionPreview';
import { useApproval } from '@/components/review/approval-context';
import { useStop } from '@/components/shell/stop-context';
import { isCeremonyStage } from './ceremony';

const FOCUSABLE =
  'button:not([disabled]):not([aria-disabled="true"]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * The exact-action approval, central and exclusive. The canvas dims and stops while it is open,
 * the content surface is transparent over a registered reading region, everything behind is
 * inert, and no palette opens over it. Escape closes the preview and approves nothing; Stop is
 * inside the dialog because a background control made inert is not a Stop control. Approval
 * still happens only through the preview's own trusted-click button.
 */
export function ApprovalCeremony() {
  const { snapshot, controller } = useApproval();
  const stopper = useStop();
  const open = isCeremonyStage(snapshot.stage);
  const dialog = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const heading = dialog.current?.querySelector<HTMLElement>('h2');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus();
    return () => {
      // The opening button may have moved into this dialog; fall back to where it lives again.
      const back =
        document.querySelector<HTMLElement>('[data-testid="preview-approval"]') ??
        document.querySelector<HTMLElement>('#main');
      back?.focus();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      // Closing the preview is cancellation of an unused preview; it never approves or signs.
      if (snapshot.stage === 'preview') controller?.cancelPreview();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="lj-ceremony-scrim" data-testid="approval-ceremony">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Approval"
        className="lj-ceremony"
        data-hud-quiet=""
        onKeyDown={onKeyDown}
      >
        <ReviewActionPreview />
        <div className="lj-rule mt-4 flex flex-wrap items-center gap-2 pt-3">
          <button
            type="button"
            className="min-h-11 min-w-11 rounded border border-lj-edge px-4 text-[0.875rem]"
            data-testid="ceremony-stop"
            onClick={() => stopper.stop()}
          >
            Stop
          </button>
          <p className="m-0 text-[0.8125rem] text-lj-secondary">
            Escape or Stop closes an unused preview. Neither approves or signs anything.
          </p>
        </div>
      </div>
    </div>
  );
}
