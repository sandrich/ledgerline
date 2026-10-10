import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TransactionsView } from '../../components/views/TransactionsView';
import { PageSkeleton } from '../../components/views/parts';

export const metadata: Metadata = { title: 'Activity' };

export default function TransactionsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <TransactionsView />
    </Suspense>
  );
}
