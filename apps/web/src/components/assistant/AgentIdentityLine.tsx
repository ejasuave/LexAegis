'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useVault } from '@/components/vault/vault-context';
import { useFeatureFlag } from '@/components/shell/feature-flags-context';
import { AgentIdentityController, describeView, fetchIdentity } from '@/features/identity/public';

/**
 * The CURRENT assistant's ERC-8004 identity, one line. Absent entirely when the server flag is off
 * (no placeholder, no request). A read happens only on Check or Refresh; changing matter, locking
 * the vault or unmounting cancels it. It is not the identity recorded with any particular review,
 * and it never blocks the review, approval or account flows.
 */
export function AgentIdentityLine() {
  const enabled = useFeatureFlag('agentIdentity');
  const vault = useVault();
  const controller = useMemo(
    () => new AgentIdentityController({ enabled, fetch: fetchIdentity }),
    [enabled],
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const scope = `${vault.snapshot.state}:${vault.snapshot.selectedMatterId ?? ''}`;
  useEffect(() => {
    controller.invalidate();
    return () => controller.invalidate();
  }, [controller, scope]);
  if (snapshot.phase === 'off') return null;

  const text = describeView(
    snapshot.phase === 'done' && snapshot.view !== null
      ? snapshot.view
      : snapshot.phase === 'checking'
        ? 'checking'
        : 'idle',
  );
  const link = snapshot.view?.kind === 'registered' ? snapshot.view.cardLink : null;
  return (
    <section
      aria-label="Assistant agent identity"
      data-testid="agent-identity-line"
      className="grid gap-1 rounded-md border border-lj-line p-3 text-[0.875rem]"
    >
      <p className="m-0 font-medium" role="status" aria-live="polite">
        <span className="text-lj-muted">Current assistant: </span>
        {text.headline}
      </p>
      <p className="m-0 break-words text-lj-secondary">{text.detail}</p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="min-h-11 min-w-11 rounded-md border border-lj-line px-3"
          disabled={snapshot.phase === 'checking'}
          onClick={() => void controller.inspect()}
        >
          {snapshot.phase === 'done' ? 'Refresh agent identity' : 'Check agent identity'}
        </button>
        {link !== null ? (
          <a href={link} target="_blank" rel="noopener noreferrer" className="underline">
            Open registered card (self-declared)
          </a>
        ) : null}
      </div>
    </section>
  );
}
