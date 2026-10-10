'use client';

import type { ReactNode } from 'react';

import { useAccount } from '@/components/account/account-context';
import { accountStatusLabel } from '@/features/account/public';
import { useVault } from '@/components/vault/vault-context';
import { vaultStatusLabel } from '@/components/vault/status';
import { IndexerStatusIndicator } from '@/components/history/IndexerStatusIndicator';
import { useHistory } from '@/components/history/history-context';
import { Icon, type IconName } from './icons';

interface Reading {
  readonly label: string;
  readonly value: ReactNode;
  readonly icon: IconName;
}

/**
 * Account, server sign-in, vault lock, transaction and indexer states are separate readings.
 * The account readings come from the real controller; the rest have no controller yet and say so.
 */
export function SystemStrip({ networkLabel }: { networkLabel: string }) {
  const { availability, snapshot } = useAccount();
  const vault = useVault();
  const history = useHistory();
  const account =
    availability === 'loading' ? 'Checking' : accountStatusLabel(snapshot, availability);
  const readings: Reading[] = [
    { label: 'Matter', value: 'None selected', icon: 'file' },
    { label: 'Network', value: networkLabel, icon: 'network' },
    { label: 'Passkey session', value: account, icon: 'key' },
    {
      label: 'Server sign-in',
      value: snapshot.backend.state === 'signed_in' ? 'Signed in' : 'Not signed in',
      icon: 'key',
    },
    { label: 'Vault', value: vaultStatusLabel(vault.snapshot, vault.available), icon: 'lock' },
    { label: 'Transaction', value: 'None', icon: 'tx' },
    { label: 'Indexer', value: <IndexerStatusIndicator health={history.health} />, icon: 'index' },
  ];
  return (
    <header className="border-b border-lj-divider px-3 py-2" aria-label="System status">
      <dl className="m-0 flex flex-wrap gap-x-6 gap-y-1 text-[0.8125rem] leading-5">
        {readings.map((reading) => (
          <div key={reading.label} className="flex items-center gap-2">
            <Icon name={reading.icon} className="text-lj-muted" />
            <dt className="text-lj-muted">{reading.label}</dt>
            <dd className="m-0 text-lj-text">{reading.value}</dd>
          </div>
        ))}
      </dl>
    </header>
  );
}
