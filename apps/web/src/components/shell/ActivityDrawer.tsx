'use client';

import { useAssistant } from '@/components/assistant/assistant-context';
import { useHistory } from '@/components/history/history-context';
import { describeAction } from '@/features/history/public';
import { useReview } from '@/components/review/review-context';
import { useWorkspace } from './workspace-context';

const SECTIONS = [
  {
    title: 'Local processing',
    empty: 'No local document work.',
  },
  {
    title: 'Assistant and tool activity',
    empty: 'No assistant activity in this session.',
  },
  { title: 'Human decisions', empty: 'No recorded decisions.' },
  {
    title: 'On-chain events',
    empty: 'No indexed chain events for this account.',
  },
] as const;

/** Keeps local processing, assistant work, human decisions and on-chain events in separate sections. */
export function ActivityDrawer() {
  const { activityOpen, setActivityOpen } = useWorkspace();
  const { snapshot } = useReview();
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
  // Assistant work is listed apart from local processing, human decisions and chain events. A
  // finished run is none of the others: it confirms, approves and sends nothing.
  const assistant = useAssistant().snapshot;
  const runs: string[] = [];
  for (const item of assistant.conversation) {
    const run = item.run;
    if (run === null || run.origin === 'local') continue;
    const tools = run.tools.map((tool) => tool.toolName.replaceAll('_', ' ')).join(', ');
    runs.push(
      `${run.intent?.replaceAll('_', ' ') ?? 'request'}: ${run.state.replaceAll('_', ' ')}${
        run.complete ? '' : ' (incomplete)'
      }${tools === '' ? '' : `; tools: ${tools}`}`,
    );
  }
  // Public-chain section: indexed registry events only, never assistant work or decisions.
  const history = useHistory().state;
  const chain = history.items
    .slice(0, 5)
    .map(
      (item) =>
        `${describeAction(item)} at block ${item.blockNumber}${item.provisional ? ' (provisional)' : ''}`,
    );
  const lines: Record<string, string[]> = {
    'On-chain events': chain,
    'Local processing': local,
    'Assistant and tool activity': runs,
  };
  return (
    <aside
      id="activity-drawer"
      aria-label="Activity"
      hidden={!activityOpen}
      className="fixed inset-x-0 bottom-24 z-10 max-h-[50dvh] overflow-y-auto border-t border-lj-divider bg-lj-soft p-4 lg:left-auto lg:w-96 lg:border-l"
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
      {SECTIONS.map((section) => (
        <section key={section.title} className="mt-4" aria-label={section.title}>
          <h3 className="m-0 text-base font-medium">{section.title}</h3>
          {(lines[section.title]?.length ?? 0) > 0 ? (
            <ul className="m-0 mt-1 list-none p-0 text-[0.875rem] text-lj-secondary">
              {(lines[section.title] ?? []).map((line, index) => (
                <li key={`${index}:${line}`}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="m-0 mt-1 text-[0.875rem] text-lj-secondary">{section.empty}</p>
          )}
        </section>
      ))}
    </aside>
  );
}
