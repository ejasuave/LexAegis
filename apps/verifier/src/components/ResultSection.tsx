import { useId, useState, type ReactNode } from 'react';
import type { CheckResult, VerificationReportV1 } from '@lexaegis/sdk';
import type { VerifierSnapshot } from '../controller';
import {
  CHECK_LABEL,
  ISSUE_TEXT,
  artifactLabel,
  bindingLabel,
  lifecycleLabel,
  manifestLabel,
  registryLabel,
  signerLabel,
} from '../labels';
import { RESULT_FILE_NAME, RESULT_NOTICE, resultJson } from '../result-export';
import { CopyButton } from './CopyButton';
import { formatDecimalBytes } from './format';

interface Props {
  readonly snapshot: VerifierSnapshot;
}

type Tone = 'ok' | 'bad' | 'unknown';
const TONE_CLASS: Record<Tone, string> = {
  ok: 'text-lj-ok',
  bad: 'text-lj-bad',
  unknown: 'text-lj-warn',
};
const TONE_MARK: Record<Tone, string> = { ok: '✓', bad: '✕', unknown: '?' };
const TONE_WORD: Record<Tone, string> = {
  ok: 'Matches',
  bad: 'Does not match',
  unknown: 'Unknown',
};

const toneOf = (value: CheckResult): Tone =>
  value === 'match' ? 'ok' : value === 'mismatch' ? 'bad' : 'unknown';

/** Results: five independent panels, never one combined badge. */
export function ResultSection({ snapshot }: Props) {
  const { report, local } = snapshot;
  if (report === null) {
    return (
      <section aria-labelledby="results-title" className="mt-10">
        <h2 id="results-title" className="m-0 text-lg font-medium">
          3. Results
        </h2>
        <p className="m-0 mt-1 text-[0.875rem] text-lj-secondary" data-testid="no-results">
          No results yet. Nothing has been checked.
        </p>
      </section>
    );
  }
  const observed = snapshot.lastObserved;

  return (
    <section aria-labelledby="results-title" className="mt-10">
      <h2 id="results-title" className="m-0 text-lg font-medium">
        3. Results
      </h2>
      <p className="m-0 mt-1 text-[0.875rem] text-lj-secondary">
        Mode:{' '}
        {report.mode === 'full-package'
          ? 'files and manifest'
          : report.mode === 'manifest-only'
            ? 'manifest only'
            : 'reference only'}
        . Observed {new Date(report.observedAt).toUTCString()}. This is an observation at that time,
        not a certificate.
      </p>

      <ReferenceCard snapshot={snapshot} report={report} />

      <Panel
        id="manifest"
        title="Manifest integrity"
        tone={toneOf(report.manifestIntegrity)}
        label={manifestLabel(report)}
      >
        {report.referenceOrigin === 'file-declared' ? (
          <p className="m-0 text-[0.875rem]" data-testid="origin-warning">
            The expected reference was taken from the file itself. A file can agree with itself
            while being a different package from the one you meant to inspect. Supply the reference
            independently to rule that out.
          </p>
        ) : (
          <p className="m-0 text-[0.875rem]">
            The reference was supplied independently by you. This software cannot show where you got
            it.
          </p>
        )}
      </Panel>

      <Panel
        id="artifacts"
        title="Artifacts"
        tone={toneOf(report.artifactIntegrity)}
        label={artifactLabel(report)}
      >
        {local === null ? (
          <p className="m-0 text-[0.875rem]">No files were supplied.</p>
        ) : (
          <Inventory local={local} />
        )}
      </Panel>

      <Panel
        id="registry"
        title="Registry identity"
        tone={toneOf(report.registryIdentity)}
        label={registryLabel(report)}
      >
        {report.registryPolicyId === null ? (
          <p className="m-0 text-[0.875rem]">
            Not checked. The registry has not been read, so nothing is claimed about it.
          </p>
        ) : (
          <p className="m-0 text-[0.875rem]">Configured deployment: {report.registryPolicyId}.</p>
        )}
      </Panel>

      <Panel
        id="lifecycle"
        title="Receipt binding and status"
        tone={
          report.chainStatus === 'unknown' || report.receiptBinding === 'unknown'
            ? 'unknown'
            : report.receiptBinding === 'mismatch'
              ? 'bad'
              : report.chainStatus === 'active'
                ? 'ok'
                : 'unknown'
        }
        label={`${lifecycleLabel(report)} · ${bindingLabel(report)}`}
      >
        <Lifecycle snapshot={snapshot} report={report} observed={observed} />
      </Panel>

      <Panel
        id="signer"
        title="Signer acceptance"
        tone={
          report.signerAcceptance === 'accepted'
            ? 'ok'
            : report.signerAcceptance === 'rejected'
              ? 'bad'
              : 'unknown'
        }
        label={signerLabel(report)}
      >
        <p className="m-0 text-[0.875rem]">
          {report.signerPolicyId === null
            ? 'No signer policy selected. The reviewer named in a file is never taken as accepted.'
            : `Applied your rule “${report.signerPolicyId}”. It shows the account meets your selection, not that the person is qualified.`}
        </p>
      </Panel>

      <div className="card mt-4 text-[0.875rem]" data-testid="semantics">
        <strong>Content not evaluated.</strong> Declared profile{' '}
        {report.profile === null
          ? 'not available'
          : `${report.profile.id} version ${report.profile.version}`}
        . Whether the analysis is right, the facts are true or the decisions are acceptable is not
        assessed. A genuine package can still be wrong.
      </div>

      {report.issues.length > 0 ? <Issues report={report} /> : null}
      <Technical snapshot={snapshot} report={report} />
      <Download report={report} />
    </section>
  );
}

function Panel(props: {
  id: string;
  title: string;
  tone: Tone;
  label: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="card mt-3" data-testid={`panel-${props.id}`}>
      <h3 id={titleId} className="m-0 text-base font-medium">
        {props.title}
      </h3>
      <p className={`m-0 mt-1 font-medium ${TONE_CLASS[props.tone]}`}>
        <span aria-hidden="true">{TONE_MARK[props.tone]} </span>
        <span className="sr-only">{TONE_WORD[props.tone]}: </span>
        <span data-testid={`label-${props.id}`}>{props.label}</span>
      </p>
      <div className="mt-2">{props.children}</div>
    </section>
  );
}

function ReferenceCard({
  snapshot,
  report,
}: {
  snapshot: VerifierSnapshot;
  report: VerificationReportV1;
}) {
  const declared = snapshot.local?.declaredReference ?? null;
  const same =
    declared !== null &&
    declared.commitment === report.expectedReference.commitment &&
    declared.chainId === report.expectedReference.chainId &&
    declared.registryAddress === report.expectedReference.registryAddress &&
    declared.reviewerAddress === report.expectedReference.reviewerAddress;
  return (
    <div className="card mt-3" data-testid="reference-card">
      <h3 className="m-0 text-base font-medium">Receipt reference being checked</h3>
      <p className="m-0 mt-1 text-[0.875rem]" data-testid="reference-origin">
        {report.referenceOrigin === 'independent'
          ? 'Supplied independently by you.'
          : 'Taken from the imported file. Not independently supplied.'}
      </p>
      <ReferenceRows reference={report.expectedReference} />
      {declared !== null && !same ? (
        <div className="mt-3" data-testid="declared-conflict">
          <p className="m-0 text-[0.875rem] text-lj-bad">
            The file declares a different reference. It was not used.
          </p>
          <ReferenceRows reference={declared} />
        </div>
      ) : null}
    </div>
  );
}

function ReferenceRows({ reference }: { reference: VerificationReportV1['expectedReference'] }) {
  const rows: [string, string][] = [
    ['Chain', reference.chainId],
    ['Registry', reference.registryAddress],
    ['Reviewer', reference.reviewerAddress],
    ['Commitment', reference.commitment],
  ];
  return (
    <dl className="mono m-0 mt-2 grid gap-1">
      {rows.map(([term, value]) => (
        <div key={term} className="flex flex-wrap items-center gap-2">
          <dt className="min-w-24 text-lj-secondary">{term}</dt>
          <dd className="m-0 flex flex-wrap items-center gap-2">
            <span>{value}</span>
            <CopyButton value={value} label={term.toLowerCase()} />
          </dd>
        </div>
      ))}
      <div className="mt-1">
        <CopyButton value={JSON.stringify(reference)} label="whole reference" />
      </div>
    </dl>
  );
}

function Inventory({ local }: { local: NonNullable<VerifierSnapshot['local']> }) {
  return (
    <ul className="m-0 list-none p-0" data-testid="inventory">
      {local.inventory.map((item) => (
        <li
          key={item.artifactId}
          className="flex flex-wrap items-baseline justify-between gap-2 border-t border-lj-divider py-2 text-[0.875rem] first:border-t-0"
        >
          <span>
            <span className="text-lj-secondary">{item.role}</span>{' '}
            {/* Untrusted text: React escapes it, and it is never rendered as markup or a link. */}
            <span data-testid="artifact-label">{item.label ?? '(no label)'}</span>
          </span>
          <span>
            {formatDecimalBytes(item.byteLength)} ·{' '}
            <span
              className={
                item.check === 'match'
                  ? 'text-lj-ok'
                  : item.check === 'mismatch' || item.check === 'missing'
                    ? 'text-lj-bad'
                    : 'text-lj-warn'
              }
            >
              {CHECK_LABEL[item.check]}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Lifecycle({
  snapshot,
  report,
  observed,
}: {
  snapshot: VerifierSnapshot;
  report: VerificationReportV1;
  observed: VerificationReportV1 | null;
}) {
  const history = report.history;
  return (
    <div className="text-[0.875rem]">
      {report.checkpoint === null ? (
        <p className="m-0" data-testid="no-checkpoint">
          No registry block was read, so the status is unknown.
        </p>
      ) : (
        <p className="m-0" data-testid="checkpoint">
          Read at block {report.checkpoint.blockNumber} (finalized height{' '}
          {report.checkpoint.finalizedHeight}, chain {report.checkpoint.chainId}) on{' '}
          {new Date(report.checkpoint.observedAt).toUTCString()}.
        </p>
      )}
      {snapshot.refreshFailed && observed !== null ? (
        <p className="m-0 mt-2 text-lj-warn" data-testid="as-of">
          The refresh failed. The last status read was {lifecycleLabel(observed)}, as of{' '}
          {new Date(observed.observedAt).toUTCString()}. It may have changed since.
        </p>
      ) : null}
      {report.chainStatus === 'active' ? (
        <p className="m-0 mt-2">
          Active shows only what the registry recorded at that block. A later revocation or
          replacement would not appear here until you refresh.
        </p>
      ) : null}
      {history !== null ? (
        <div className="mt-3" data-testid="history">
          <h4 className="m-0 text-[0.875rem] font-medium">Replacements</h4>
          {!history.complete ? (
            <p className="m-0 mt-1 text-lj-warn" data-testid="history-incomplete">
              Incomplete history. Later links were not fully read.
            </p>
          ) : null}
          <ul className="m-0 mt-1 list-none p-0">
            {history.successors.map((link) => (
              <li key={link.reference.commitment} className="py-1">
                <span className="mono">{link.reference.commitment}</span> — {link.chainStatus}. Its
                files have not been checked here; inspect it as a separate reference.{' '}
                <CopyButton value={JSON.stringify(link.reference)} label="replacement reference" />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Issues({ report }: { report: VerificationReportV1 }) {
  const unique = [...new Set(report.issues.map((issue) => issue.code))];
  return (
    <div className="card mt-3 text-[0.875rem]" data-testid="issues">
      <h3 className="m-0 text-base font-medium">Notes</h3>
      <ul className="m-0 mt-1 list-disc pl-5">
        {unique.map((code) => (
          <li key={code}>{ISSUE_TEXT[code] ?? code}</li>
        ))}
      </ul>
    </div>
  );
}

function Technical({
  snapshot,
  report,
}: {
  snapshot: VerifierSnapshot;
  report: VerificationReportV1;
}) {
  const { local } = snapshot;
  return (
    <details className="card mt-3 text-[0.875rem]" data-testid="technical">
      <summary className="flex min-h-11 cursor-pointer items-center">
        Technical details (private, shown only here)
      </summary>
      <p className="m-0 mt-2 text-lj-secondary">
        These values are private to the package. They are shown on this device only and are not part
        of the downloadable result.
      </p>
      {local !== null ? (
        <ul className="mono m-0 mt-2 list-none p-0">
          {local.inventory.map((item) => (
            <li key={item.artifactId}>
              {item.artifactId} · {item.sha256}
            </li>
          ))}
        </ul>
      ) : null}
      {report.checkpoint !== null ? (
        <dl className="mono m-0 mt-2">
          <dt>Block hash</dt>
          <dd className="m-0">{report.checkpoint.blockHash}</dd>
          <dt>Block timestamp</dt>
          <dd className="m-0">{report.checkpoint.blockTimestamp}</dd>
        </dl>
      ) : null}
    </details>
  );
}

function Download({ report }: { report: VerificationReportV1 }) {
  const [status, setStatus] = useState('');
  const download = () => {
    const blob = new Blob([resultJson(report)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = RESULT_FILE_NAME;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // The temporary address is revoked straight away.
    URL.revokeObjectURL(url);
    setStatus('Downloaded.');
  };
  return (
    <div className="card mt-3 text-[0.875rem]" data-testid="download-card">
      <h3 className="m-0 text-base font-medium">Download verification result</h3>
      <p className="m-0 mt-1">
        {RESULT_NOTICE} It contains the public reference, the check results, policy names and the
        block read. It does not contain files, the opening, hashes, labels or the endpoint.
      </p>
      <button type="button" className="btn mt-2" onClick={download} data-testid="download">
        Download verification result
      </button>
      <span role="status" className="ml-3">
        {status}
      </span>
    </div>
  );
}
