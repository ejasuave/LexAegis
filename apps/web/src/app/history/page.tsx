import type { Metadata } from 'next';
import { EmptyState } from '@/components/shell/EmptyState';

export const metadata: Metadata = { title: 'History · LexAegis' };

export default function HistoryPage() {
  return (
    <EmptyState
      title="History"
      description="Receipt history is not available yet: the registry and indexer are not connected, so no events are shown and none are implied."
    />
  );
}
