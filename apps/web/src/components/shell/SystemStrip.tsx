'use client';

import type { ReactNode } from 'react';

import { useAccount } from '@/components/account/account-context';
import { accountStatusLabel } from '@/features/account/public';
import { useVault } from '@/components/vault/vault-context';
import { vaultStatusLabel } from '@/components/vault/status';
import { IndexerStatusIndicator } from '@/components/history/IndexerStatusIndicator';
import { useHistory } from '@/components/history/history-context';
import { useReview } from '@/components/review/review-context';
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
  const review = useReview().snapshot;
  const account =
    availability === 'loading' ? 'Checking' : accountStatusLabel(snapshot, availability);
  // The title is shown only in this in-memory view; it is never put in a URL or document title.
  const matter = vault.snapshot.selectedMatter;
  const selectedDocs = review.documents.filter((doc) => doc.selected);
  const matterText =
    matter === null
      ? 'None selected'
      : `${matter.title}, ${
          selectedDocs.length === 0
            ? 'no document selected'
            : selectedDocs.length === 1
              ? `version ${selectedDocs[0]?.documentVersionId.slice(0, 8) ?? ''}`
              : `${selectedDocs.length} versions`
        }`;
  const readings: Reading[] = [
    { label: 'Matter', value: matterText, icon: 'file' },
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
  // Narrow screens show the matter and the two readings that decide what can be done; every
  // other reading is one tap away. Wide screens show them all.
  const essential = readings.filter((r) =>
    ['Matter', 'Passkey session', 'Vault'].includes(r.label),
  );
  const renderReading = (reading: Reading) => (
    <div key={reading.label} className="flex min-w-0 items-center gap-2">
      <Icon name={reading.icon} className="shrink-0 text-lj-muted" />
      <dt className="text-lj-muted">{reading.label}</dt>
      <dd className="m-0 min-w-0 break-words text-lj-text">{reading.value}</dd>
    </div>
  );
  return (
    <header
      className="lj-safe-x min-h-16 border-b border-lj-divider py-2"
      aria-label="System status"
    >
      <dl className="m-0 hidden flex-wrap gap-x-6 gap-y-1 text-[0.8125rem] leading-5 lg:flex">
        {readings.map(renderReading)}
      </dl>
      <dl className="m-0 grid gap-y-1 text-[0.8125rem] leading-5 lg:hidden">
        {essential.map(renderReading)}
      </dl>
      <details className="mt-1 text-[0.8125rem] text-lj-secondary">
        <summary className="min-h-6 cursor-pointer">Diagnostics</summary>
        <dl className="m-0 mt-1 grid gap-y-1 lg:hidden">
          {readings.filter((r) => !essential.includes(r)).map(renderReading)}
        </dl>
        <p className="m-0 mt-1">
          Readings are separate: a usable passkey session does not mean the vault is unlocked,
          server sign-in does not approve anything, and indexed history never replaces a live
          network read.
        </p>
      </details>
    </header>
  );
}
