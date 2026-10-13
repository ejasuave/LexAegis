'use client';

import { useEffect, useRef } from 'react';
import type { EffectsMode } from '@/features/hud/public';
import { NeuralRenderer, type SceneState } from '@/features/hud/public';
import { effectsModeFor } from './effects-preference';

/**
 * Canvas lifecycle only: it creates one canvas, hands it to the renderer, keeps it sized from
 * real layout and stops it when the page is hidden or effects are off. It owns no business state,
 * no network and no authority. Failing to start a canvas leaves the full DOM workbench.
 */
export function NeuralCanvas({
  mode,
  scene,
  onFail,
}: {
  mode: EffectsMode;
  scene: SceneState;
  onFail: () => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const renderer = useRef<NeuralRenderer | null>(null);
  const latest = useRef({ mode, scene });
  latest.current = { mode, scene };
  const off = mode === 'off';

  useEffect(() => {
    const element = host.current;
    if (element === null || off) return;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    let created: NeuralRenderer;
    try {
      // The mode is re-read at this instant so reduced motion applies before the first frame.
      created = new NeuralRenderer(canvas, {
        mode: effectsModeFor(false) === 'off' ? 'reduced' : effectsModeFor(false),
      });
    } catch {
      onFail();
      return;
    }
    element.append(canvas);
    renderer.current = created;
    // Read-only diagnostics for tests and traces: no DOM write per frame.
    Object.defineProperty(canvas, 'ljStats', { get: () => created.stats() });

    const size = () => {
      const r = element.getBoundingClientRect();
      created.resize(r.width, r.height, window.devicePixelRatio);
    };
    size();
    created.setMode(latest.current.mode);
    created.setScene(latest.current.scene);
    created.setVisible(document.visibilityState === 'visible');

    const observer = new ResizeObserver(size);
    observer.observe(element);
    const onVisibility = () => created.setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    // A zoom or monitor change alters the pixel ratio without resizing the element.
    let ratio = window.matchMedia(`(resolution: ${String(window.devicePixelRatio)}dppx)`);
    const onRatio = () => {
      size();
      ratio.removeEventListener('change', onRatio);
      ratio = window.matchMedia(`(resolution: ${String(window.devicePixelRatio)}dppx)`);
      ratio.addEventListener('change', onRatio);
    };
    ratio.addEventListener('change', onRatio);

    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      ratio.removeEventListener('change', onRatio);
      created.dispose();
      renderer.current = null;
      canvas.remove();
    };
  }, [off, onFail]);

  useEffect(() => {
    renderer.current?.setMode(mode);
  }, [mode]);
  useEffect(() => {
    renderer.current?.setScene(scene);
  }, [scene]);

  return <div ref={host} className="lj-art-host" />;
}
