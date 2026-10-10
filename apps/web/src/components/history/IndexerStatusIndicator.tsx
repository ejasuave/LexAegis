'use client';

import type { HistoryHealth } from '@/domain/history/response';
import { indexerLabel } from '@/features/history/public';

const TONE: Record<string, string> = {
  ok: 'text-lj-text',
  warn: 'text-lj-text',
  bad: 'text-lj-text',
  muted: 'text-lj-secondary',
};
const MARK: Record<string, string> = { ok: '●', warn: '◐', bad: '○', muted: '·' };

/**
 * The index reading, stated in words. It says nothing about the registry's current state,
 * package integrity or whether a transaction confirmed; those come from live verification.
 */
export function IndexerStatusIndicator({ health }: { health: HistoryHealth | null }) {
  const label = indexerLabel(health);
  return (
    <span className={TONE[label.tone]} data-indexer-state={label.tone}>
      <span aria-hidden="true">{MARK[label.tone]} </span>
      {label.text}
    </span>
  );
}
