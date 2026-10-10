import type { Metadata } from 'next';
import { ReviewHistoryPanel } from '@/components/history/ReviewHistoryPanel';

export const metadata: Metadata = { title: 'History · LexAegis' };

export default function HistoryPage() {
  return <ReviewHistoryPanel />;
}
