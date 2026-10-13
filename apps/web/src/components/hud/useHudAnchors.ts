'use client';

import { useEffect, useRef, useState } from 'react';
import type { HudView } from '@/features/hud/public';
import type { AlertTarget, NucleusMode } from '@/features/hud/public';
import type { Rect } from '@/features/hud/public';

/*
 * Measures registered DOM regions and visible finding markers, never every element. Reading
 * regions carry data-hud-quiet; the nucleus carries data-hud-nucleus; finding rows carry
 * data-hud-finding; the labelled Findings control carries data-hud-findings-control. Measuring
 * runs on layout changes, scroll and mutation, coalesced to at most one pass per interval.
 */

export interface Anchors {
  readonly regions: readonly Rect[];
  readonly nucleus: { readonly x: number; readonly y: number; readonly mode: NucleusMode } | null;
  readonly channelX: number | null;
  readonly alerts: readonly AlertTarget[];
  readonly stage: Rect | null;
}

const EMPTY: Anchors = { regions: [], nucleus: null, channelX: null, alerts: [], stage: null };
// One pass per frame at most: a mask that lags a layout change would leave art behind new text.
const MIN_GAP_MS = 0;

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
};
const onScreen = (r: Rect): boolean =>
  r.w > 0 &&
  r.h > 0 &&
  r.x < window.innerWidth &&
  r.y < window.innerHeight &&
  r.x + r.w > 0 &&
  r.y + r.h > 0;

export function useHudAnchors(
  view: HudView,
  setVisibleFindingIds: (ids: readonly string[]) => void,
  deps: readonly unknown[],
): Anchors {
  const [anchors, setAnchors] = useState<Anchors>(EMPTY);
  const viewRef = useRef(view);
  viewRef.current = view;
  const lastKey = useRef('');
  const visibleRef = useRef(setVisibleFindingIds);
  visibleRef.current = setVisibleFindingIds;

  useEffect(() => {
    let frame = 0;
    let last = 0;
    const measure = () => {
      frame = 0;
      last = performance.now();
      const regions = Array.from(document.querySelectorAll('[data-hud-quiet]'))
        .map(rectOf)
        .filter(onScreen);

      const nucleusEl = document.querySelector('[data-hud-nucleus]');
      const svg = nucleusEl?.querySelector('svg');
      let nucleus: Anchors['nucleus'] = null;
      if (svg !== null && svg !== undefined) {
        const r = rectOf(svg);
        if (onScreen(r)) {
          nucleus = {
            x: r.x + r.w / 2,
            y: r.y + r.h / 2,
            mode: r.w >= 100 ? 'hero' : 'compact',
          };
        }
      }

      // The gap channel between the working stage and the attention rail, when they sit side by side.
      const stage = document.querySelector('section[aria-label="Work"]');
      const rail = document.querySelector('[data-hud-rail="attention"]');
      let channelX: number | null = null;
      const stageRect = stage === null ? null : rectOf(stage);
      if (stage !== null && rail !== null) {
        const a = rectOf(stage);
        const b = rectOf(rail);
        if (a.w > 0 && b.w > 0 && a.x + a.w < b.x && Math.abs(a.y - b.y) < 8) {
          channelX = (a.x + a.w + b.x) / 2;
        }
      }

      // Finding rows that are really on screen, inside their scroll container.
      const visible: { id: string; r: Rect }[] = [];
      for (const row of document.querySelectorAll('[data-hud-finding]')) {
        const id = row.getAttribute('data-hud-finding');
        if (id === null) continue;
        const r = rectOf(row);
        const scroller = row.closest('.lj-workbench > *');
        const box = scroller === null ? null : rectOf(scroller);
        const inside =
          onScreen(r) &&
          (box === null || (r.y >= box.y && r.y + r.h <= box.y + box.h && r.x >= box.x - 1));
        if (inside) visible.push({ id, r });
      }
      visibleRef.current(visible.map((v) => v.id));

      const v = viewRef.current;
      const alerts: AlertTarget[] = [];
      for (const id of v.attention.highlighted) {
        const found = visible.find((entry) => entry.id === id);
        const severity = v.attention.severityById[id];
        if (found === undefined || severity === undefined) continue;
        // Beside the row's margin, never across its words.
        alerts.push({ severity, marker: { x: found.r.x + found.r.w + 6, y: found.r.y + 12 } });
      }
      if (v.attention.offscreenUnresolved > 0 && alerts.length < 3) {
        const control = Array.from(document.querySelectorAll('[data-hud-findings-control]'))
          .map((el) => ({ el, r: rectOf(el) }))
          .find((c) => onScreen(c.r));
        if (control !== undefined) {
          const holder = control.el.closest('[data-hud-quiet]');
          const edge = holder === null ? null : rectOf(holder);
          alerts.push({
            severity: v.attention.blocking ? 'failure' : 'alert',
            marker:
              edge === null
                ? { x: control.r.x + control.r.w / 2, y: control.r.y + control.r.h + 6 }
                : { x: edge.x - 6, y: control.r.y + control.r.h / 2 },
          });
        }
      }

      const next: Anchors = {
        regions,
        nucleus,
        channelX,
        alerts,
        stage: stageRect !== null && onScreen(stageRect) ? stageRect : null,
      };
      const key = JSON.stringify(next);
      if (key !== lastKey.current) {
        lastKey.current = key;
        setAnchors(next);
      }
    };

    const request = () => {
      watchRegions();
      if (frame !== 0) return;
      const wait = Math.max(0, MIN_GAP_MS - (performance.now() - last));
      frame = requestAnimationFrame(() => {
        if (wait > 0) window.setTimeout(measure, wait);
        else measure();
      });
    };

    const root = document.querySelector('.lj-app') ?? document.body;
    const resize = new ResizeObserver(request);
    resize.observe(root);
    const watched = new WeakSet<Element>();
    const watchRegions = () => {
      for (const el of document.querySelectorAll('[data-hud-quiet]')) {
        if (!watched.has(el)) {
          watched.add(el);
          resize.observe(el);
        }
      }
    };
    watchRegions();
    const main = document.querySelector('.lj-main');
    if (main !== null) resize.observe(main);
    // The visible stage box anchors the nucleus: any change to its size re-measures it.
    const workStage = document.querySelector('section[aria-label="Work"]');
    if (workStage !== null) resize.observe(workStage);
    const mutation = new MutationObserver(request);
    if (main !== null) {
      mutation.observe(main, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-active', 'open', 'class', 'aria-pressed'],
      });
    }
    window.addEventListener('resize', request);
    document.addEventListener('scroll', request, { capture: true, passive: true });
    request();
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener('resize', request);
      document.removeEventListener('scroll', request, { capture: true });
    };
    // The measurement depends on the page, not on the view: the view is read from a ref.
  }, deps);

  // A new view (for example a finding became highlighted) needs one fresh pass.
  useEffect(() => {
    window.dispatchEvent(new Event('resize'));
  }, [view.attention.highlighted.join('|'), view.attention.offscreenUnresolved]);

  return anchors;
}
