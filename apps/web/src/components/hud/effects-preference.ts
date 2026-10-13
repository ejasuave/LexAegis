import { useSyncExternalStore } from 'react';
import {
  isEffectsPreference,
  resolveEffects,
  type EffectsEnvironment,
  type EffectsMode,
  type EffectsPreference,
} from '@/features/hud/public';

/*
 * The persistent Effects control's state. The stored value is a per-viewer convenience only: it
 * may fail to read or write (private windows, blocked storage) and the page works without it.
 * It is read here and nowhere near evidence, keys or business state.
 */

const KEY = 'lj-effects';
const listeners = new Set<() => void>();
let memory: EffectsPreference | null = null;

export function readPreference(): EffectsPreference {
  if (memory !== null) return memory;
  try {
    const stored = window.localStorage.getItem(KEY);
    if (isEffectsPreference(stored)) memory = stored;
  } catch {
    // Storage can throw; fall through to the default.
  }
  return memory ?? 'system';
}

export function writePreference(preference: EffectsPreference): void {
  memory = preference;
  try {
    window.localStorage.setItem(KEY, preference);
  } catch {
    // Not persisted; the choice still applies for this page.
  }
  for (const listener of listeners) listener();
}

const query = (q: string): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(q).matches;

/** Everything the policy needs except the canvas failure, read at this instant. */
export function readEffectsEnvironment(): Omit<EffectsEnvironment, 'canvasFailed'> {
  return {
    preference: readPreference(),
    osReducedMotion: query('(prefers-reduced-motion: reduce)'),
    forcedColors: query('(forced-colors: active)'),
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const lists = [
    window.matchMedia('(prefers-reduced-motion: reduce)'),
    window.matchMedia('(forced-colors: active)'),
  ];
  for (const list of lists) list.addEventListener('change', listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    for (const list of lists) list.removeEventListener('change', listener);
    window.removeEventListener('storage', listener);
  };
}

let cached = '';
let cachedValue: Omit<EffectsEnvironment, 'canvasFailed'> = {
  preference: 'system',
  osReducedMotion: false,
  forcedColors: false,
};
function snapshot(): Omit<EffectsEnvironment, 'canvasFailed'> {
  const next = readEffectsEnvironment();
  const key = `${next.preference}|${String(next.osReducedMotion)}|${String(next.forcedColors)}`;
  if (key !== cached) {
    cached = key;
    cachedValue = next;
  }
  return cachedValue;
}
const SERVER: Omit<EffectsEnvironment, 'canvasFailed'> = {
  preference: 'system',
  osReducedMotion: false,
  forcedColors: false,
};

export function useEffectsEnvironment(): Omit<EffectsEnvironment, 'canvasFailed'> {
  return useSyncExternalStore(subscribe, snapshot, () => SERVER);
}

export function effectsModeFor(canvasFailed: boolean): EffectsMode {
  return resolveEffects({ ...readEffectsEnvironment(), canvasFailed });
}
