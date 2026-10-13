'use client';

import { useStop } from '@/components/shell/stop-context';
import { useHud } from './hud-context';

/**
 * The one sentence naming what is really pending, in the header row's reserved space so showing
 * it moves nothing. Stop is offered only when the work is something Stop reaches. It blocks no
 * focus and no other region; the live announcements are in the HUD shell, once each for start
 * and finish. "Still working" appears only from real elapsed time.
 */
export function LoadingStatus() {
  const { loading } = useHud();
  const stop = useStop();
  const { view } = loading;
  if (!view.visible || view.work === null)
    return <span className="lj-loading-slot" aria-hidden="true" />;
  const { work } = view;
  return (
    <span className="lj-loading-slot" data-testid="loading-status" data-region={work.region}>
      <span className="lj-loading-mark" aria-hidden="true" />
      <span className="lj-loading-text">
        {work.sentence}
        {work.step === null ? '' : ` Step ${String(work.step.done)} of ${String(work.step.total)}.`}
        {view.stillWorking ? ' Still working; this is taking longer than usual.' : ''}
      </span>
      {work.cancellable && stop.canStop() ? (
        <button type="button" className="lj-loading-stop" onClick={() => void stop.stop()}>
          Stop
        </button>
      ) : null}
    </span>
  );
}
