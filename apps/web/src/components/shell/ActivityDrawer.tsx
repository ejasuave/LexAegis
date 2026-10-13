'use client';

import { useId, useRef, useState } from 'react';
import { useDrawerFocus } from './drawer-focus';
import { useAssistant } from '@/components/assistant/assistant-context';
import { useTransaction } from '@/components/chain/transaction-context';
import { IndexerStatusIndicator } from '@/components/history/IndexerStatusIndicator';
import { useHistory } from '@/components/history/history-context';
import { useApproval } from '@/components/review/approval-context';
import { useDecisions } from '@/components/review/decision-context';
import { usePackage } from '@/components/review/package-context';
import { useReview } from '@/components/review/review-context';
import { describeAction } from '@/features/history/public';
import { useWorkspace } from './workspace-context';

type View = 'assistant' | 'decisions' | 'receipts';
const VIEWS: { id: View; label: string }[] = [
  { id: 'assistant', label: 'Assistant work' },
  { id: 'decisions', label: 'Human decisions' },
  { id: 'receipts', label: 'Public receipts' },
];

const list = 'm-0 mt-1 list-none p-0 text-[0.875rem] text-lj-secondary';
const empty = 'm-0 mt-1 text-[0.875rem] text-lj-secondary';

function Section({
  title,
  lines,
  none,
}: {
  title: string;
  lines: readonly string[];
  none: string;
}) {
  return (
    <section className="mt-4" aria-label={title}>
      <h3 className="m-0 text-base font-medium">{title}</h3>
      {lines.length > 0 ? (
        <ul className={list}>
          {lines.map((line, index) => (
            <li key={`${index}:${line}`}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className={empty}>{none}</p>
      )}
    </section>
  );
}

/**
 * Activity in three separate views. An unsigned local decision, a signed authorisation and an
 * observed on-chain event are different kinds of evidence and are never listed together.
 */
export function ActivityDrawer() {
  const { activityOpen, setActivityOpen } = useWorkspace();
  const [view, setView] = useState<View>('assistant');
  const tabsId = useId();
  const drawer = useRef<HTMLElement | null>(null);
  useDrawerFocus(activityOpen, () => setActivityOpen(false), drawer);
  const { snapshot } = useReview();
  const assistant = useAssistant().snapshot;
  const decisions = useDecisions().snapshot;
  const pkg = usePackage().snapshot;
  const approval = useApproval().snapshot;
  const transaction = useTransaction().state;
  const history = useHistory();

  const local: string[] = [];
  if (snapshot.intake.state === 'running') local.push(`Reading ${snapshot.intake.label}`);
  if (snapshot.intake.state === 'done') local.push(`Imported ${snapshot.intake.label}`);
  if (snapshot.intake.state === 'failed') local.push(`Not imported: ${snapshot.intake.label}`);
  if (snapshot.checks.status === 'running') local.push('Running checks');
  if (snapshot.checks.status === 'stale') local.push('Check results are out of date');
  if (snapshot.checks.status === 'fresh')
    local.push(`${snapshot.checks.findings.length} findings from the current inputs`);
  if (snapshot.comparison.status === 'running') local.push('Comparing versions');
  if (snapshot.save === 'unsaved') local.push('Unsaved review changes');

  const runs: string[] = [];
  for (const item of assistant.conversation) {
    const run = item.run;
    if (run === null || run.origin === 'local') continue;
    const tools = run.tools.map((tool) => tool.toolName.replaceAll('_', ' ')).join(', ');
    runs.push(
      `${run.startedAt}: ${run.intent?.replaceAll('_', ' ') ?? 'request'}, ${run.state.replaceAll('_', ' ')}${
        run.complete ? '' : ' (incomplete)'
      }${tools === '' ? '' : `; tools: ${tools}`}`,
    );
  }

  // Unsigned records of what the reviewer did, with the time they did it.
  const recorded = decisions.dispositions.map(
    (d) =>
      `${d.recordedAt}: you chose "${d.kind.replaceAll('_', ' ')}" for a finding (unsigned, local)`,
  );
  if (decisions.log !== null)
    recorded.push(
      `${decisions.log.record.recordedAt}: you recorded review decisions (unsigned, local; not approval)`,
    );
  if (pkg.frozen !== null)
    recorded.push(
      `${pkg.frozen.preparedAt || 'earlier'}: package frozen, ${
        pkg.frozen.state === 'recoverable' ? 'saved and verified' : pkg.frozen.state
      } (not approved)`,
    );
  // A signed authorisation is its own kind of record, apart from the decisions above.
  const authorisations: string[] = [];
  if (approval.stage === 'signed')
    authorisations.push('Approval signed by your account; publication not confirmed');
  if (transaction.stage !== 'idle')
    authorisations.push(
      `Your transaction: ${transaction.stage.replaceAll('_', ' ')}${
        transaction.operation?.transactionHash != null
          ? ` (${transaction.operation.transactionHash})`
          : ''
      }`,
    );

  const chain = history.state.items
    .slice(0, 8)
    .map(
      (item) =>
        `${describeAction(item)} at block ${item.blockNumber}${item.provisional ? ' (provisional)' : ''}`,
    );

  return (
    <aside
      ref={drawer}
      id="activity-drawer"
      aria-label="Activity"
      hidden={!activityOpen}
      className="lj-drawer lj-safe-bottom fixed inset-x-0 bottom-24 z-40 max-h-[55dvh] overflow-y-auto p-4 lg:left-auto lg:w-[26rem]"
    >
      <div className="flex items-center justify-between">
        <h2 className="m-0 text-lg font-medium">Activity</h2>
        <button
          type="button"
          onClick={() => setActivityOpen(false)}
          className="min-h-11 min-w-11 rounded border border-lj-edge px-3 text-[0.875rem]"
        >
          Close
        </button>
      </div>
      <div role="tablist" aria-label="Activity views" className="mt-2 flex flex-wrap gap-1">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${tabsId}-${item.id}`}
            aria-selected={view === item.id}
            aria-controls={`${tabsId}-panel`}
            onClick={() => setView(item.id)}
            className={`min-h-11 rounded border px-3 text-[0.875rem] ${
              view === item.id ? 'border-lj-cyan text-lj-text' : 'border-lj-edge text-lj-secondary'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${view}`}>
        {view === 'assistant' ? (
          <>
            <Section title="Local processing" lines={local} none="No local document work." />
            <Section
              title="Assistant and tool activity"
              lines={runs}
              none="No assistant activity in this session."
            />
          </>
        ) : null}
        {view === 'decisions' ? (
          <>
            <Section
              title="Your decisions (unsigned, local)"
              lines={recorded}
              none="No recorded decisions."
            />
            <Section
              title="Signed authorisations"
              lines={authorisations}
              none="Nothing has been signed."
            />
          </>
        ) : null}
        {view === 'receipts' ? (
          <>
            <Section
              title="Observed on-chain events"
              lines={chain}
              none="No indexed chain events for this account."
            />
            <p className={empty}>
              <IndexerStatusIndicator health={history.health} />. Indexed events can lag and can be
              reorganised; the live registry read decides a receipt&apos;s state.
            </p>
          </>
        ) : null}
      </div>
    </aside>
  );
}
