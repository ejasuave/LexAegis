import type { Metadata } from 'next';
import { ReviewWorkspace } from '@/components/review/ReviewWorkspace';

export const metadata: Metadata = { title: 'Review · LexAegis' };

export default function ReviewPage() {
  return <ReviewWorkspace />;
}
