'use client';

import { useId, useState } from 'react';
import { useAccount } from '@/components/account/account-context';
import { useTransaction } from '@/components/chain/transaction-context';
import { useVault } from '@/components/vault/vault-context';
import { createLiveStateReader } from '@/features/transactions/public';
import { useApproval } from './approval-context';
import { usePackage } from './package-context';

const btn =
  'min-h-11 rounded border border-lj-edge px-4 text-[0.875rem] aria-disabled:text-lj-muted';
const field =
  'min-h-11 w-full rounded border border-lj-edge bg-lj-soft px-3 font-mono text-[0.875rem] text-lj-text';
const COMMITMENT = /^0x[0-9a-f]{64}$/;

/**
 * Receipt lifecycle actions. Each has its own preview and the same two-stage flow as issuing.
 * Revoke and replace go through the approval controller (a signed instruction); cancelling an
 * outstanding authorisation is a separate fee-paying transaction with no review signature.
 */
export function ReceiptActions() {
  const { snapshot, publicConfig } = useAccount();
  const vault = useVault();
  const approval = useApproval();
  const pkg = usePackage();
  const tx = useTransaction();
  const revokeId = useId();
  const replaceId = useId();
  const [revokeTarget, setRevokeTarget] = useState('');
  const [replaceTarget, setReplaceTarget] = useState('');
  const [nonce, setNonce] = useState<{ value: string | null; note: string }>({
    value: null,
    note: '',
  });

  const reviewer = snapshot.account?.address ?? null;
  const chainId = publicConfig.chainId ?? '';
  const registry = publicConfig.registryAddress?.toLowerCase() ?? '';
  const saved = vault.snapshot.selectedMatter?.frozenReviews ?? [];
  const usable = reviewer !== null && registry !== '' && snapshot.signing.state === 'unlocked';

  const reference = (commitment: string) => ({
    schema: 'lexaegis.receipt-ref.v1' as const,
    chainId,
    registryAddress: registry,
    reviewerAddress: reviewer ?? '',
    commitment,
  });

  async function readNonce() {
    if (reviewer === null) return;
    const read = await createLiveStateReader()(reviewer, `0x${'00'.repeat(32)}`);
    setNonce(
      read.status === 'ok'
        ? { value: read.registryNonce, note: `Read at block ${read.blockNumber}.` }
        : { value: null, note: 'The nonce could not be read. That is not the same as zero.' },
    );
  }

  return (
    <section aria-label="Receipt actions" className="mt-6" data-testid="receipt-actions">
      <h2 className="m-0 text-lg font-medium">Receipt actions</h2>
      <p className="m-0 mt-1 text-[0.8125rem] text-lj-secondary">
        Only for receipts issued by your own account. Each action is checked against the live
        registry first and needs its own explicit approval.
      </p>

      <div className="mt-3">
        <label htmlFor={revokeId} className="block text-[0.875rem]">
          Revoke a receipt (its commitment)
        </label>
        <input
          id={revokeId}
          className={field}
          list={`${revokeId}-saved`}
          value={revokeTarget}
          onChange={(event) => setRevokeTarget(event.target.value.trim().toLowerCase())}
          placeholder="0x…"
          spellCheck={false}
        />
        <datalist id={`${revokeId}-saved`}>
          {saved.map((item) => (
            <option key={item.commitment} value={item.commitment} />
          ))}
        </datalist>
        <p className="m-0 mt-1 text-[0.8125rem] text-lj-secondary">
          Revoking marks the receipt as withdrawn. Its evidence and history stay as they are, and
          you do not need the private documents.
        </p>
        <button
          type="button"
          className={`${btn} mt-1`}
          aria-disabled={!usable || !COMMITMENT.test(revokeTarget)}
          data-testid="preview-revoke"
          onClick={() => {
            if (usable && COMMITMENT.test(revokeTarget))
              void approval.controller?.prepare({
                kind: 'revoke',
                reference: reference(revokeTarget),
              });
          }}
        >
          Check and preview revocation
        </button>
      </div>

      <div className="mt-4">
        <label htmlFor={replaceId} className="block text-[0.875rem]">
          Replace an earlier receipt with a new reviewed package
        </label>
        <input
          id={replaceId}
          className={field}
          list={`${replaceId}-saved`}
          value={replaceTarget}
          onChange={(event) => setReplaceTarget(event.target.value.trim().toLowerCase())}
          placeholder="Commitment of the Active receipt to replace"
          spellCheck={false}
        />
        <datalist id={`${replaceId}-saved`}>
          {saved.map((item) => (
            <option key={item.commitment} value={item.commitment} />
          ))}
        </datalist>
        <p className="m-0 mt-1 text-[0.8125rem] text-lj-secondary">
          The replacement must be separately reviewed, frozen and saved, and it declares the receipt
          it replaces. The old package is never edited. Build the replacement package preview with
          this predecessor, then freeze it and approve it as a replacement.
        </p>
        <button
          type="button"
          className={`${btn} mt-1`}
          aria-disabled={!usable || !COMMITMENT.test(replaceTarget)}
          data-testid="preview-replacement"
          onClick={() => {
            if (usable && COMMITMENT.test(replaceTarget))
              void pkg.controller?.buildPreview({ supersedes: reference(replaceTarget) });
          }}
        >
          Preview replacement package
        </button>
      </div>

      <div className="mt-4">
        <h3 className="m-0 text-base font-medium">Cancel outstanding authorisation</h3>
        <p className="m-0 mt-1 text-[0.8125rem] text-lj-secondary">
          Every instruction you signed with the current nonce stops working. It does not revoke a
          receipt that was already issued, and it can lose a race against someone submitting that
          instruction first. It is a separate transaction and costs a fee.
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btn}
            aria-disabled={!usable}
            onClick={() => void readNonce()}
          >
            Read current nonce
          </button>
          {nonce.value !== null ? (
            <>
              <span className="text-[0.875rem]" data-testid="nonce-value">
                Nonce <span className="font-mono">{nonce.value}</span>
              </span>
              <button
                type="button"
                className={btn}
                data-testid="preview-cancel-authorisation"
                aria-disabled={
                  tx.state.stage !== 'idle' &&
                  tx.state.stage !== 'cancelled' &&
                  tx.state.stage !== 'failed'
                }
                onClick={() =>
                  void tx.controller?.begin(
                    { kind: 'invalidate_nonce', expectedNonce: nonce.value ?? '' },
                    null,
                  )
                }
              >
                Prepare cancellation of nonce {nonce.value}
              </button>
            </>
          ) : null}
        </div>
        <p role="status" className="m-0 mt-1 text-[0.8125rem]">
          {nonce.note}
        </p>
      </div>
    </section>
  );
}
