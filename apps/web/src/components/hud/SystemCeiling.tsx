'use client';

import { useState, type ReactNode } from 'react';

import { Icon, type IconName } from '@/components/shell/icons';
import { NavBar } from '@/components/shell/NavBar';
import type { Reading, Tone } from '@/features/hud/public';
import { useHud } from './hud-context';

const ICON: Record<Reading['id'], IconName> = {
  matter: 'file',
  network: 'network',
  indexer: 'index',
  'mera-session': 'key',
  'public-account': 'key',
  vault: 'lock',
  transaction: 'tx',
  'server-sign-in': 'key',
};

/** Tone is a supplementary mark; the reading's words always carry the meaning. */
const MARK: Record<Tone, string> = { ok: '●', attention: '▲', warn: '◐', bad: '○', muted: '·' };
const STATUS: ReadonlySet<Reading['id']> = new Set([
  'indexer',
  'mera-session',
  'vault',
  'transaction',
  'server-sign-in',
]);

/** Shortened public address with a deliberate reveal and copy. Public value only. */
function PublicAccount({ reading }: { reading: Reading }) {
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const address = reading.fullValue;
  if (address === null) return <span>{reading.text}</span>;
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
        {full ? address : reading.text}
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

function value(reading: Reading): ReactNode {
  if (reading.id === 'public-account') return <PublicAccount reading={reading} />;
  return (
    <>
      {STATUS.has(reading.id) ? (
        <span aria-hidden="true" data-tone={reading.tone}>
          {MARK[reading.tone]}{' '}
        </span>
      ) : null}
      {reading.text}
    </>
  );
}

const ESSENTIAL: ReadonlySet<Reading['id']> = new Set([
  'matter',
  'mera-session',
  'vault',
  'transaction',
]);

/**
 * Flush telemetry ceiling. Each reading comes from the one accepted HUD view and from its own
 * controller; none implies another. Nothing here ticks, animates or counts on its own: ages
 * advance from a local clock and everything else changes only when a controller reports.
 */
export function SystemCeiling() {
  const { view } = useHud();
  const renderReading = (reading: Reading, extra = '') => (
    <div
      key={reading.id}
      className={`flex min-w-0 items-center gap-2 ${extra}`}
      data-reading={reading.id}
    >
      <Icon name={ICON[reading.id]} className="shrink-0 text-lj-muted" />
      <dt className="text-lj-muted">{reading.label}</dt>
      <dd className="min-w-0 break-words text-lj-text">{value(reading)}</dd>
    </div>
  );
  const primary = view.readings.filter((r) => r.id !== 'server-sign-in');
  const essential = primary.filter((r) => ESSENTIAL.has(r.id));
  const secondary = view.readings.filter((r) => r.id === 'server-sign-in');
  return (
    <header className="lj-ceiling" aria-label="System status">
      <div className="lj-ceiling-row">
        <dl className="hidden flex-wrap gap-x-5 gap-y-1 min-[1200px]:flex">
          {primary.map((r) => renderReading(r))}
        </dl>
        <dl className="grid gap-y-1 min-[1200px]:hidden">
          {essential.map((r) => renderReading(r))}
        </dl>
        <details className="text-[0.8125rem] text-lj-secondary">
          <summary className="inline-flex min-h-6 cursor-pointer items-center">
            System status
          </summary>
          <dl className="mt-1 grid gap-y-1">
            {primary
              .filter((r) => !ESSENTIAL.has(r.id))
              .map((r) => renderReading(r, 'min-[1200px]:hidden'))}
            {secondary.map((r) => renderReading(r))}
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
