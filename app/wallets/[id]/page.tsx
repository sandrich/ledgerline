import { notFound } from 'next/navigation';
import { PortfolioView } from '../../../components/views/PortfolioView';

export default async function WalletPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  return <PortfolioView key={id} walletId={id} />;
}
