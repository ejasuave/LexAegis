'use client';

import { useReview } from '@/components/review/review-context';
import { useWorkspace } from './workspace-context';

const SECTIONS = [
  {
    title: 'Local processing',
    empty: 'No local document work.',
  },
  {
    title: 'Assistant and tool activity',
    empty: 'No assistant activity. The assistant is not connected yet.',
  },
  { title: 'Human decisions', empty: 'No recorded decisions.' },
  {
    title: 'On-chain events',
    empty:
      'No chain events in this session. Operation progress appears here; the indexer is not connected until a later chapter.',
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
          {section.title === 'Local processing' && local.length > 0 ? (
            <ul className="m-0 mt-1 list-none p-0 text-[0.875rem] text-lj-secondary">
              {local.map((line) => (
                <li key={line}>{line}</li>
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
