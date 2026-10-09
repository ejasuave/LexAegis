import type { Metadata } from 'next';
import { AccountPanel } from '@/components/account/AccountPanel';
import { ChainPanel } from '@/components/chain/ChainPanel';
import { VaultPanel } from '@/components/vault/VaultPanel';

export const metadata: Metadata = { title: 'Account and vault · LexAegis' };

export default function VaultPage() {
  return (
    <>
      <AccountPanel />
      <ChainPanel />
      <VaultPanel />
    </>
  );
}
