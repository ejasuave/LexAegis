'use client';

import { useState, type ReactNode } from 'react';

import { useAccount } from '@/components/account/account-context';
import { STAGE_LABEL } from '@/components/chain/status';
import { useTransaction } from '@/components/chain/transaction-context';
import { IndexerStatusIndicator } from '@/components/history/IndexerStatusIndicator';
import { useHistory } from '@/components/history/history-context';
import { useReview } from '@/components/review/review-context';
import { Icon, type IconName } from '@/components/shell/icons';
import { useVault } from '@/components/vault/vault-context';
import { vaultStatusLabel } from '@/components/vault/status';
import { accountStatusLabel } from '@/features/account/public';
import { NavBar } from '@/components/shell/NavBar';

interface Reading {
  readonly label: string;
  readonly value: ReactNode;
  readonly icon: IconName;
}

/** Shortened public address with a deliberate reveal and copy. Public value only. */
function PublicAccount({ address }: { address: string | null }) {
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  if (address === null) return <span>None</span>;
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  const copy = () => {
    try {
      void navigator.clipboard.writeText(address).then(
        () => setCopied(true),
        () => setCopied(false),
      );
    } catch {
      setCopied(false);
    }
  };
  const small =
    'inline-flex min-h-6 min-w-6 items-center px-1 text-[0.8125rem] text-lj-secondary underline decoration-lj-edge underline-offset-2';
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      <span className="font-mono break-all" title={full ? undefined : address}>
        {full ? address : short}
      </span>
      <button
        type="button"
        className={small}
        aria-expanded={full}
        onClick={() => setFull((value) => !value)}
      >
        {full ? 'Shorten' : 'Show full'}
      </button>
      <button type="button" className={small} onClick={copy}>
        Copy
      </button>
      <span role="status" className="sr-only">
        {copied ? 'Public address copied.' : ''}
      </span>
    </span>
  );
}

/**
 * Flush telemetry ceiling. Matter, network, passkey session, public account, vault, transaction
 * and indexer are separate readings, each from its own controller; none implies another. The
 * readings come from real observations only: nothing here ticks, animates or counts on its own.
 */
export function SystemCeiling({ networkLabel }: { networkLabel: string }) {
  const { availability, snapshot } = useAccount();
  const vault = useVault();
  const history = useHistory();
  const review = useReview().snapshot;
  const transaction = useTransaction().state;
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
      label: 'Public account',
      value: <PublicAccount address={snapshot.account?.address ?? null} />,
      icon: 'key',
    },
    { label: 'Vault', value: vaultStatusLabel(vault.snapshot, vault.available), icon: 'lock' },
    { label: 'Transaction', value: STAGE_LABEL[transaction.stage], icon: 'tx' },
    { label: 'Indexer', value: <IndexerStatusIndicator health={history.health} />, icon: 'index' },
  ];
  const secondary: Reading = {
    label: 'Server sign-in',
    value: snapshot.backend.state === 'signed_in' ? 'Signed in' : 'Not signed in',
    icon: 'key',
  };
  // Narrow screens keep the matter, the session and vault warnings and the active operation; the
  // other readings sit in a labelled disclosure. Wide screens show every reading.
  const essential = readings.filter((r) =>
    ['Matter', 'Passkey session', 'Vault', 'Transaction'].includes(r.label),
  );
  const renderReading = (reading: Reading, extra = '') => (
    <div key={reading.label} className={`flex min-w-0 items-center gap-2 ${extra}`}>
      <Icon name={reading.icon} className="shrink-0 text-lj-muted" />
      <dt className="text-lj-muted">{reading.label}</dt>
      <dd className="min-w-0 break-words text-lj-text">{reading.value}</dd>
    </div>
  );
  return (
    <header className="lj-ceiling" aria-label="System status">
      <div className="lj-ceiling-row">
        <dl className="hidden flex-wrap gap-x-5 gap-y-1 min-[1200px]:flex">
          {readings.map((r) => renderReading(r))}
        </dl>
        <dl className="grid gap-y-1 min-[1200px]:hidden">
          {essential.map((r) => renderReading(r))}
        </dl>
        <details className="text-[0.8125rem] text-lj-secondary">
          <summary className="inline-flex min-h-6 cursor-pointer items-center">
            System status
          </summary>
          <dl className="mt-1 grid gap-y-1">
            {readings
              .filter((r) => !essential.includes(r))
              .map((r) => renderReading(r, 'min-[1200px]:hidden'))}
            {renderReading(secondary)}
          </dl>
          <p className="m-0 mt-1">
            Readings are separate: a usable passkey session does not mean the vault is unlocked,
            server sign-in does not approve anything, and indexed history never replaces a live
            network read.
          </p>
        </details>
      </div>
      <NavBar />
    </header>
  );
}
