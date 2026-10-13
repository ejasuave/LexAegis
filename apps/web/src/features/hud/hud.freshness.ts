import type { Freshness } from './hud.types';

/** A reading older than this is shown as stale, with its age, rather than as current. */
export const INDEXER_STALE_MS = 90_000;
/** An active run with no accepted event for this long can no longer be shown as running. SSE heartbeats are deliberately not progress, so a long silent model call can reach it. */
export const RUN_EVENT_STALE_MS = 60_000;

export function freshnessOf(
  observedAtMs: number | null,
  nowMs: number,
  staleAfterMs: number,
): Freshness {
  if (observedAtMs === null || !Number.isFinite(observedAtMs)) return 'unknown';
  // A reading from the future means the clocks disagree: its age is not known.
  if (observedAtMs > nowMs + 5_000) return 'unknown';
  return nowMs - observedAtMs > staleAfterMs ? 'stale' : 'live';
}

/** Honest elapsed time from a local clock; never a countdown to something the chain decides. */
export function ageText(observedAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - observedAtMs) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${String(seconds)} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min ago`;
  return `${String(Math.floor(minutes / 60))} h ago`;
}
