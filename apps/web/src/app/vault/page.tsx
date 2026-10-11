import type { Metadata } from 'next';
import { AccessGuide } from '@/components/account/AccessGuide';
import { AccountPanel } from '@/components/account/AccountPanel';
import { ChainPanel } from '@/components/chain/ChainPanel';
import { VaultPanel } from '@/components/vault/VaultPanel';

export const metadata: Metadata = { title: 'Account and vault · LexAegis' };

export default function VaultPage() {
  return (
    <>
      <AccountPanel />
      <AccessGuide />
      <ChainPanel />
      <VaultPanel />
    </>
  );
}
