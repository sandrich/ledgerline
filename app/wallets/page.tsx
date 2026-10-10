import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ManageView } from '../../components/views/ManageView';
import { PageSkeleton } from '../../components/views/parts';

export const metadata: Metadata = { title: 'Wallets' };

export default function WalletsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ManageView />
    </Suspense>
  );
}
