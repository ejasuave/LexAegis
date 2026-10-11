'use client';

import { useState } from 'react';
import { useAccount } from '@/components/account/account-context';
import { useVault } from '@/components/vault/vault-context';
import { ExportAndImport, NoticeContext } from '@/components/vault/VaultPanel';
import { readVerifiedDecisionLog } from '@/features/review/public';
import { usePackage } from './package-context';

const btn = 'min-h-11 rounded border border-lj-edge px-4 text-[0.875rem]';

/**
 * Saved frozen reviews, opened read-only. Opening one reads it back and verifies it in this
 * unlock; what it shows is the package as it was frozen, apart from current working results.
 * Exports and the verifier handoff are explicit: nothing downloads or uploads automatically, and
 * the public receipt reference is copied without the private opening.
 */
export function SavedReviews() {
  const vault = useVault();
  const pkg = usePackage();
  const { snapshot: account, publicConfig } = useAccount();
  const [copied, setCopied] = useState('');
  const matter = vault.snapshot.selectedMatter;
  const unlocked = vault.snapshot.state === 'unlocked' || vault.snapshot.state === 'saving';
  const reviewer = account.account?.address ?? '';
  if (!unlocked || matter === null) return null;

  return (
    <section aria-label="Saved reviews" className="mt-6" data-testid="saved-reviews">
      <h2 className="m-0 text-lg font-medium">Saved reviews</h2>
      {matter.frozenReviews.length === 0 ? (
        <p className="m-0 mt-1 text-[0.875rem] text-lj-secondary">
          No frozen reviews are saved for this matter.
        </p>
      ) : (
        <ul className="m-0 mt-1 list-none p-0">
          {matter.frozenReviews.map((item) => {
            const subject = vault.handle?.recoverableSubject(item.commitment) ?? null;
            const log =
              subject === null ? null : readVerifiedDecisionLog(subject.decisionLogBytes, reviewer);
            return (
              <li
                key={item.commitment}
                className="border-b border-lj-divider py-3 text-[0.9375rem]"
              >
                <p className="m-0 break-all font-mono text-[0.8125rem]">{item.commitment}</p>
                <p className="m-0 text-[0.8125rem] text-lj-secondary">Saved {item.savedAt}</p>
                {subject === null ? (
                  <button
                    type="button"
                    className={`${btn} mt-1`}
                    onClick={() => void pkg.controller?.reconnect(item.commitment)}
                  >
                    Open read-only (verify now)
                  </button>
                ) : (
                  <div className="mt-1 text-[0.875rem]" data-testid="frozen-readonly">
                    <p className="m-0">
                      Frozen package, verified in this unlock: {subject.artifacts.length} artifacts
                      {subject.supersedes !== null ? ', a replacement for an earlier receipt' : ''}.
                      {log !== null
                        ? ` ${log.dispositions.length} recorded decision(s).`
                        : ' Its decision log could not be read, so it cannot be approved.'}
                    </p>
                    <p className="m-0 text-lj-secondary">
                      This is how the package was when it was frozen. Your current working results
                      are separate, and removing a working note does not change it.
                    </p>
                    <button
                      type="button"
                      className={`${btn} mt-1`}
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(JSON.stringify(subject.reference))
                          .then(() => setCopied(item.commitment));
                      }}
                    >
                      Copy public receipt reference
                    </button>
                    {copied === item.commitment ? (
                      <span role="status" className="ml-2 text-[0.8125rem]">
                        Copied. It holds no opening, label or file hash.
                      </span>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="m-0 mt-2 text-[0.8125rem] text-lj-secondary">
        An address identifies a signing account. It is not a verified professional identity.
      </p>
      <NoticeContext.Provider value={() => undefined}>
        <ExportAndImport matterId={matter.matterId} />
      </NoticeContext.Provider>
      <p className="m-0 mt-2 text-[0.875rem]" data-testid="verifier-handoff">
        Independent verifier:{' '}
        {publicConfig.verifierOrigin === undefined
          ? 'not configured.'
          : 'the verifier is a separate application at '}
        {publicConfig.verifierOrigin !== undefined ? (
          <span className="font-mono">{publicConfig.verifierOrigin}</span>
        ) : null}
        . Verification is not available in this build, so nothing here is reported as verified. When
        it is, you hand it a downloaded file yourself; files are never put in a URL or sent between
        sites automatically.
      </p>
    </section>
  );
}
