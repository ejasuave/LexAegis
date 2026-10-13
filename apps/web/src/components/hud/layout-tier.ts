import { useSyncExternalStore } from 'react';

/** Layout tiers follow available CSS width, so browser zoom changes them too. */
export type LayoutTier = 'wide' | 'medium' | 'narrow';

const WIDE = '(min-width: 1200px)';
const MEDIUM = '(min-width: 800px)';

export function tierFor(wide: boolean, medium: boolean): LayoutTier {
  return wide ? 'wide' : medium ? 'medium' : 'narrow';
}

function subscribe(listener: () => void): () => void {
  const lists = [window.matchMedia(WIDE), window.matchMedia(MEDIUM)];
  for (const list of lists) list.addEventListener('change', listener);
  return () => {
    for (const list of lists) list.removeEventListener('change', listener);
  };
}

const read = (): LayoutTier =>
  tierFor(window.matchMedia(WIDE).matches, window.matchMedia(MEDIUM).matches);

/** The server renders the wide tier; the client corrects it after hydration. */
export function useLayoutTier(): LayoutTier {
  return useSyncExternalStore(subscribe, read, () => 'wide');
}
