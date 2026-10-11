'use client';

import type { PackagePreview, PackageFailure } from '@/features/review/public';
import { usePackage } from './package-context';

const btn =
  'min-h-11 rounded border border-lj-edge px-4 text-[0.875rem] aria-disabled:text-lj-muted';

const FAILURE_TEXT: Record<PackageFailure, string> = {
  NOT_READY: 'The review is not ready to package.',
  ACCOUNT_LOCKED: 'Unlock your account first.',
  NO_REGISTRY: 'No registry is configured, so a package cannot be prepared for this network.',
  DECISIONS_NOT_RECORDED:
    'Record your review decisions first. That is a separate step from approval.',
  DRAFT_FAILED: 'The package contents could not be assembled from the current results.',
  MANIFEST_INVALID: 'The package contents did not pass validation, so nothing was frozen.',
  PROFILE_INCOMPLETE: 'A required kind of artifact is missing for this review profile.',
  STALE: 'Your working review changed. Build the preview again.',
  NO_PREVIEW: 'There is no current preview to freeze.',
  PREPARE_FAILED: 'The package could not be captured. Nothing was saved.',
  SAVE_FAILED: 'The package was not saved.',
  NOT_VERIFIED: 'The saved package could not be verified in this unlock.',
  BUSY: 'Another package step is still running.',
};

function Memo({ preview }: { preview: PackagePreview }) {
  const byRole = new Map<string, number>();
  for (const artifact of preview.artifacts)
    byRole.set(artifact.role, (byRole.get(artifact.role) ?? 0) + 1);
  return (
    <div className="lj-card mt-2 p-3 text-[0.9375rem]" data-testid="package-memo">
      <h3 className="m-0 text-base font-medium">Review memo</h3>
      <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.875rem]">
        <dt className="text-lj-muted">Reviewer</dt>
        <dd className="m-0 break-all font-mono">{preview.reviewer}</dd>
        <dt className="text-lj-muted">Network</dt>
        <dd className="m-0">Chain {preview.chainId}</dd>
        <dt className="text-lj-muted">Registry</dt>
        <dd className="m-0 break-all font-mono">{preview.registryAddress}</dd>
        <dt className="text-lj-muted">Model execution</dt>
        <dd className="m-0">
          {preview.modelExecution === 'none'
            ? 'None: only local checks and your own decisions.'
            : 'An assistant analysis is included, with its recorded configuration.'}
        </dd>
        <dt className="text-lj-muted">Rule pack</dt>
        <dd className="m-0">
          {preview.rulePackReviewState === 'demo_draft'
            ? 'Demonstration draft, not reviewed by a qualified person'
            : preview.rulePackReviewState}
        </dd>
        <dt className="text-lj-muted">Your decisions</dt>
        <dd className="m-0">{preview.decisionCount}</dd>
        <dt className="text-lj-muted">Replaces</dt>
        <dd className="m-0 break-all font-mono">
          {preview.supersedes === null ? 'Nothing: a new review.' : preview.supersedes.commitment}
        </dd>
      </dl>
      <h4 className="m-0 mt-3 text-[0.9375rem] font-medium">
        Contents ({preview.artifacts.length})
      </h4>
      <ul className="m-0 mt-1 list-none p-0 text-[0.875rem]">
        {[...byRole].map(([role, count]) => (
          <li key={role}>
            <span className="font-mono">{role}</span> × {count}
          </li>
        ))}
      </ul>
      {preview.acceptedConcerns.length > 0 ? (
        <>
          <h4 className="m-0 mt-3 text-[0.9375rem] font-medium">Concerns you accepted</h4>
          <ul className="m-0 mt-1 list-disc pl-5 text-[0.875rem]">
            {preview.acceptedConcerns.map((concern) => (
              <li key={concern.findingId} className="break-words">
                {concern.reason}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h4 className="m-0 mt-3 text-[0.9375rem] font-medium">Limitations</h4>
      <ul className="m-0 mt-1 list-disc pl-5 text-[0.875rem] text-lj-secondary">
        {preview.limitations.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <details className="mt-3 text-[0.8125rem]">
        <summary className="min-h-6 cursor-pointer">Technical details</summary>
        <p className="m-0 mt-1">
          Package ID: <span className="font-mono">{preview.packageId}</span>
        </p>
        <p className="m-0">Prepared at: {preview.preparedAt}</p>
        <p className="m-0">Scope: all {preview.scopeArtifactIds.length} artifacts, once each.</p>
      </details>
    </div>
  );
}

/**
 * Package preview, Freeze and the saved state. Frozen and saved are not approved or issued: this
 * panel never offers approval, and its wording says so.
 */
export function PackagePanel() {
  const { controller, snapshot } = usePackage();
  const { status, preview, frozen, failure, notice } = snapshot;
  return (
    <section aria-label="Review package" className="mt-4" data-testid="package-panel">
      <h2 className="m-0 text-lg font-medium">Review package</h2>
      {status === 'empty' ? (
        <>
          <p className="m-0 mt-2 text-[0.875rem] text-lj-secondary">
            Preview the exact contents before anything is frozen.
          </p>
          <button
            type="button"
            className={`${btn} mt-2`}
            data-testid="build-preview"
            onClick={() => void controller?.buildPreview()}
          >
            Preview review package
          </button>
        </>
      ) : null}
      {preview !== null && status === 'preview' ? (
        <>
          <Memo preview={preview} />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className={`${btn} lj-action`}
              data-testid="freeze-package"
              onClick={() => void controller?.freeze()}
            >
              Freeze review package
            </button>
            <button type="button" className={btn} onClick={() => controller?.discardPreview()}>
              Discard preview
            </button>
          </div>
          <p className="m-0 mt-1 text-[0.8125rem] text-lj-secondary">
            Freezing captures these exact contents and saves them encrypted. It does not approve
            anything.
          </p>
        </>
      ) : null}
      {status === 'freezing' || status === 'saving' ? (
        <p role="status" className="m-0 mt-2 text-[0.9375rem]" data-testid="package-saving">
          {status === 'freezing'
            ? 'Capturing the package…'
            : 'Saving encrypted files and checking them…'}
        </p>
      ) : null}
      {frozen !== null ? (
        <div className="lj-card mt-3 p-3 text-[0.9375rem]" data-testid="frozen-package">
          <h3 className="m-0 text-base font-medium">
            {frozen.state === 'recoverable'
              ? 'Saved and checked'
              : frozen.state === 'saving'
                ? 'Saving'
                : 'Not saved'}
          </h3>
          <p className="m-0 mt-1 break-all font-mono text-[0.8125rem]">
            Public commitment: {frozen.commitment}
          </p>
          <p className="m-0 mt-1 text-[0.875rem] text-lj-secondary">
            Read-only. This is not approved, signed or an active receipt.
          </p>
          {snapshot.workingChangedSinceFreeze ? (
            <p className="m-0 mt-1 text-[0.875rem] text-lj-amber">
              Your working review has changed since this package was frozen. The frozen package is
              unchanged; build a new preview to include the changes.
            </p>
          ) : null}
          {frozen.state === 'failed' ? (
            <button
              type="button"
              className={`${btn} mt-2`}
              onClick={() => void controller?.retry()}
            >
              Retry save
            </button>
          ) : null}
          <details className="mt-2 text-[0.8125rem]">
            <summary className="min-h-6 cursor-pointer">Technical details</summary>
            <p className="m-0 mt-1">
              Package ID:{' '}
              <span className="font-mono">{frozen.packageId || 'verified from storage'}</span>
            </p>
            <p className="m-0">Artifacts: {frozen.artifactCount}</p>
          </details>
        </div>
      ) : null}
      <p role="status" aria-live="polite" className="m-0 mt-2 text-[0.875rem]">
        {failure !== null ? FAILURE_TEXT[failure] : notice}
      </p>
    </section>
  );
}
