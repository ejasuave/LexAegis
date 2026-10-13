import { useSyncExternalStore } from 'react';
import type { HudInput } from '@/features/hud/public';

/*
 * A synthetic input can replace the live one only while the gated fixtures page is mounted. The
 * page itself answers 404 unless the server was started with HUD_FIXTURES=1, so nothing in a
 * normal run can set this.
 */

let current: HudInput | null = null;
const listeners = new Set<() => void>();

export function setHudFixture(input: HudInput | null): void {
  current = input;
  for (const listener of listeners) listener();
}

export function useHudFixture(): HudInput | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}
