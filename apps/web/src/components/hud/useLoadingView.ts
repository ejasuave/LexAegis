'use client';

import { useEffect, useRef, useState } from 'react';
import { LoadingGate, type LoadingView, type PendingWork } from '@/features/hud/public';
import type { LoadingState } from './hud-context';

const IDLE: LoadingView = {
  visible: false,
  work: null,
  stillWorking: false,
  finished: null,
  nextChangeAtMs: null,
};

/**
 * Runs the pure loading gate against the controllers' real pending state. The only timer it owns
 * fires at an instant the gate itself named (the show-after, minimum-visible or elapsed
 * threshold); it never advances anything on its own, and a hidden tab needs none.
 */
export function useLoadingView(work: PendingWork | null): LoadingState {
  const gate = useRef(new LoadingGate());
  const [state, setState] = useState<LoadingState>({ view: IDLE, announcement: null });
  const wasVisible = useRef(false);
  const announced = useRef(0);
  const latest = useRef(work);
  latest.current = work;
  const signature = work === null ? '' : JSON.stringify(work);

  useEffect(() => {
    let timer = 0;
    const run = () => {
      const view = gate.current.update(latest.current, performance.now());
      let text: string | null = null;
      if (view.visible && !wasVisible.current && view.work !== null) text = view.work.sentence;
      if (view.finished !== null) text = view.finished;
      wasVisible.current = view.visible;
      if (text !== null) announced.current += 1;
      const announcement = text === null ? null : { id: announced.current, text };
      setState((previous) => {
        const same =
          previous.view.visible === view.visible &&
          previous.view.stillWorking === view.stillWorking &&
          previous.view.work?.key === view.work?.key &&
          previous.view.work?.sentence === view.work?.sentence &&
          previous.view.work?.step?.done === view.work?.step?.done &&
          announcement === null;
        if (same) return previous;
        return { view, announcement: announcement ?? previous.announcement };
      });
      if (view.nextChangeAtMs !== null) {
        timer = window.setTimeout(run, Math.max(0, view.nextChangeAtMs - performance.now()));
      }
    };
    run();
    return () => window.clearTimeout(timer);
  }, [signature]);

  return state;
}
