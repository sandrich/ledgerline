import { notFound } from 'next/navigation';
import { AddressView } from '../../../components/views/AddressView';

export default async function AddressPage({ params }: { params: Promise<{ address: string }> }) {
  const address = (await params).address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) notFound();
  return <AddressView key={address} address={address} />;
}
