'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useAccount } from '@/components/account/account-context';
import {
  explorerAddressUrl,
  explorerTxUrl,
  fundingText,
  monText,
  type FundingView,
} from './status';

const FAUCET = 'https://faucet.monad.xyz';
const EXPLORER = 'https://testnet.monadvision.com';
const button = 'min-h-11 rounded border border-lj-edge px-4 text-[0.875rem] disabled:text-lj-muted';

interface Status {
  readonly status: string;
  readonly checkpoint?: { blockNumber: string; blockTimestamp: string; observedAt: string };
  readonly chain?: { registryAddress?: string };
}
interface AccountView {
  readonly balanceWei: string;
  readonly observedBlock: string;
  readonly observedAt: string;
  readonly undelegated: boolean;
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Monad Testnet, the selected Mera address, usable MON, registry availability and the last live
 * check. Passkey, server sign-in, vault, transaction and indexer states stay separate; funding
 * says nothing about review approval or a receipt, and the app is not gasless.
 */
export function ChainPanel() {
  const { snapshot } = useAccount();
  const titleId = useId();
  const liveId = useId();
  const [network, setNetwork] = useState<Status | null>(null);
  const [account, setAccount] = useState<AccountView | null>(null);
  const [funding, setFunding] = useState<FundingView | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const address = snapshot.account?.address ?? null;
  const signedIn = snapshot.backend.state === 'signed_in';

  const refresh = useCallback(async () => {
    setNetwork(await getJson<Status>('/api/chain/status'));
    if (signedIn) {
      const result = await getJson<{ account: AccountView }>('/api/chain/account');
      setAccount(result?.account ?? null);
    } else {
      setAccount(null);
    }
  }, [signedIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function requestFunds() {
    setBusy(true);
    try {
      const response = await fetch('/api/chain/funding', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-lexaegis-request': '1' },
        body: '{}',
      });
      const json = (await response.json().catch(() => null)) as { funding?: FundingView } | null;
      setFunding(json?.funding ?? { status: 'unknown' });
      await refresh();
    } catch {
      setFunding({ status: 'unknown' });
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (address === null) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const registry =
    network === null
      ? 'Checking'
      : network.status === 'ready'
        ? 'Available'
        : network.status === 'not_deployed'
          ? 'Not deployed yet'
          : network.status === 'not_configured'
            ? 'Not configured'
            : 'Unknown';
  const checkpoint = network?.checkpoint;
  const needsFunds =
    funding !== null && funding.status !== 'confirmed' && funding.status !== 'pending';

  return (
    <section aria-labelledby={titleId} className="mt-6 max-w-[48rem]">
      <h2 id={titleId} className="m-0 text-lg font-medium">
        Network and test funds
      </h2>
      <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.875rem]">
        <dt className="text-lj-muted">Network</dt>
        <dd className="m-0">Monad Testnet</dd>
        <dt className="text-lj-muted">Account</dt>
        <dd className="m-0 break-all">{address ?? 'No account on this device'}</dd>
        <dt className="text-lj-muted">Usable balance</dt>
        <dd className="m-0">{account === null ? 'Not checked' : monText(account.balanceWei)}</dd>
        <dt className="text-lj-muted">Registry</dt>
        <dd className="m-0">{registry}</dd>
        <dt className="text-lj-muted">Last live check</dt>
        <dd className="m-0">
          {checkpoint === undefined
            ? 'None'
            : `Block ${checkpoint.blockNumber} at ${new Date(checkpoint.observedAt).toLocaleTimeString()}`}
        </dd>
      </dl>
      <p className="m-0 mt-2 text-[0.8125rem] text-lj-secondary">
        Your account pays transaction fees with test MON; the app is not gasless. Funding does not
        approve a review or create a receipt.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          disabled={busy || !signedIn}
          onClick={() => void requestFunds()}
        >
          Request test MON
        </button>
        <button
          type="button"
          className={button}
          disabled={address === null}
          onClick={() => void copy()}
        >
          Copy address
        </button>
        <button type="button" className={button} onClick={() => void refresh()}>
          Retry status
        </button>
        <a
          className={`${button} inline-flex items-center`}
          href={FAUCET}
          target="_blank"
          rel="noreferrer noopener"
        >
          Official faucet
        </a>
        {address !== null ? (
          <a
            className={`${button} inline-flex items-center`}
            href={explorerAddressUrl(EXPLORER, address)}
            target="_blank"
            rel="noreferrer noopener"
          >
            View on explorer
          </a>
        ) : null}
      </div>
      {!signedIn ? (
        <p className="m-0 mt-1 text-[0.8125rem] text-lj-secondary">
          Sign in with your passkey account to request funds.
        </p>
      ) : null}
      <p id={liveId} role="status" aria-live="polite" className="m-0 mt-2 text-[0.875rem]">
        {copied ? 'Address copied. ' : ''}
        {funding === null ? '' : fundingText(funding.status)}
        {funding?.retryAfter
          ? ` Try again after ${new Date(funding.retryAfter).toLocaleString()}.`
          : ''}
      </p>
      {funding?.transactionHash ? (
        <a
          className="text-[0.875rem] underline"
          href={explorerTxUrl(EXPLORER, funding.transactionHash)}
          target="_blank"
          rel="noreferrer noopener"
        >
          View funding transaction
        </a>
      ) : null}
      {needsFunds ? null : null}
    </section>
  );
}
