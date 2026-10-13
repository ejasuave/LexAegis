'use client';

import { useReview } from '@/components/review/review-context';
import { useFeatureFlag } from '@/components/shell/feature-flags-context';
import { useWorkspace } from '@/components/shell/workspace-context';
import { useAssistant } from './assistant-context';

const btn =
  'min-h-11 rounded border border-lj-edge px-3 text-[0.875rem] aria-disabled:text-lj-muted aria-disabled:cursor-not-allowed';

/**
 * Contextual entry actions for the Command centre. Each runs through the same Chapter 9 handler
 * as its slash command: nothing here creates a model call for navigation or status copy, and a
 * disabled action says exactly why.
 */
export function CommandActions() {
  const { controller, snapshot } = useAssistant();
  const review = useReview().snapshot;
  const { setMode } = useWorkspace();
  const briefing = useFeatureFlag('matterBriefing');
  const busy = snapshot.phase === 'running' || snapshot.phase === 'stopping';
  const noMatter = review.matterId === null;
  const noDoc = !review.documents.some((doc) => doc.selected);
  const noSelection = snapshot.selectionCount === 0;

  const reason = (
    needs: 'matter' | 'document' | 'selection' | 'checks' | 'facts' | null,
  ): string | null => {
    if (controller === null) return 'The assistant is not available in this session.';
    if (busy) return 'A run is in progress. Stop it first.';
    if (needs === null) return null;
    if (noMatter) return 'Open a matter first.';
    if (needs === 'matter') return null;
    if (noDoc) return 'Select a document first.';
    if (needs === 'selection' && noSelection) return 'Select a passage in the document first.';
    if (needs === 'checks' && review.checks.status !== 'fresh') return 'Run the checks first.';
    return null;
  };

  const items: {
    id: string;
    label: string;
    needs: Parameters<typeof reason>[0];
    run: () => void;
  }[] = [
    {
      id: 'analyse-matter',
      label: 'Analyse matter',
      needs: 'matter',
      run: () =>
        void controller?.action('ask_matter', {
          utterance:
            'Analyse this matter: summarise the available evidence, identify risks and gaps, and suggest the next steps. Cite sources and clearly state any limits to coverage.',
        }),
    },
    {
      id: 'explain',
      label: 'Explain selection',
      needs: 'selection',
      run: () => {
        setMode('review');
        void controller?.action('explain');
      },
    },
    {
      id: 'payments',
      label: 'Check payments',
      needs: 'document',
      run: () => void controller?.submit('/check-payments'),
    },
    {
      id: 'missing',
      label: 'Missing evidence',
      needs: 'document',
      run: () => void controller?.submit('/missing-evidence'),
    },
    ...(briefing
      ? [
          {
            id: 'brief',
            label: 'Brief this matter',
            needs: 'matter' as const,
            run: () => void controller?.action('brief_matter'),
          },
        ]
      : []),
    {
      id: 'prepare',
      label: 'Prepare review',
      needs: 'checks',
      run: () => void controller?.action('prepare_review'),
    },
  ];

  return (
    <section aria-label="Suggested actions" className="mt-4 w-full max-w-xl text-left">
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {items.map((item) => {
          const why = reason(item.needs);
          return (
            <li key={item.id}>
              <button
                type="button"
                className={btn}
                aria-disabled={why !== null}
                aria-describedby={why !== null ? `why-${item.id}` : undefined}
                data-testid={`action-${item.id}`}
                onClick={() => {
                  if (why === null) item.run();
                }}
              >
                {item.label}
              </button>
              {why !== null ? (
                <span id={`why-${item.id}`} className="sr-only">
                  Unavailable: {why}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="m-0 mt-2 text-[0.8125rem] text-lj-secondary">
        Actions that need the model show what would be sent before anything leaves this browser.
      </p>
    </section>
  );
}
