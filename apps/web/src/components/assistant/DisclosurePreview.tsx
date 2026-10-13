'use client';

import { useId } from 'react';
import { DISCLOSURE_FACTS, type PendingDisclosure } from '@/features/assistant/public';

const button = 'min-h-11 rounded border border-lj-edge px-4 text-[0.875rem]';

/**
 * Shows exactly what one request would send, and to whom, before anything leaves the browser.
 * Send is the only control that creates consent, and only for the content listed here.
 */
export function DisclosurePreview({
  pending,
  matterTitle,
  documentLabel,
  onSend,
  onCancel,
}: {
  pending: PendingDisclosure;
  matterTitle: string;
  documentLabel: string | null;
  onSend: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const { summary, providerScope } = pending;
  const provider = pending.testProvider ? 'Scripted test provider (not Qwen)' : 'Qwen';
  return (
    <section
      aria-labelledby={titleId}
      data-testid="disclosure-preview"
      className="mt-3 rounded border border-lj-edge bg-lj-soft p-3 text-[0.875rem]"
    >
      <h3 id={titleId} className="m-0 text-base font-medium">
        Review what will be sent
      </h3>
      <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-lj-secondary">Provider</dt>
        <dd className="m-0" data-testid="disclosure-provider">
          {provider}, model {providerScope.model}
        </dd>
        <dt className="text-lj-secondary">Endpoint region</dt>
        <dd className="m-0">{providerScope.region}</dd>
        <dt className="text-lj-secondary">Matter</dt>
        <dd className="m-0">{matterTitle}</dd>
        <dt className="text-lj-secondary">Document</dt>
        <dd className="m-0">{documentLabel ?? 'None selected (matter-level request)'}</dd>
        <dt className="text-lj-secondary">Excerpts</dt>
        <dd className="m-0" data-testid="disclosure-excerpts">
          {summary.excerpts.length === 0
            ? 'None'
            : summary.excerpts
                .map((excerpt) => `${excerpt.handle}: page ${excerpt.page}, ${excerpt.bytes} bytes`)
                .join('; ')}
        </dd>
        <dt className="text-lj-secondary">Confirmed facts</dt>
        <dd className="m-0">{summary.facts}</dd>
        <dt className="text-lj-secondary">Evidence links</dt>
        <dd className="m-0">{summary.evidenceDescriptors}</dd>
        <dt className="text-lj-secondary">Saved context</dt>
        <dd className="m-0">{summary.savedContextEntries}</dd>
        <dt className="text-lj-secondary">Earlier messages</dt>
        <dd className="m-0">{summary.conversationMessages}</dd>
      </dl>
      {pending.body.context.searchedScope.automatic !== undefined ? (
        <p className="m-0 mt-3 text-lj-secondary" role="status">
          Automatic matter search: {pending.body.context.searchedScope.automatic.includedDocuments}
          {' of '}
          {pending.body.context.searchedScope.automatic.availableDocuments}
          {' documents included; '}
          {pending.body.context.searchedScope.automatic.excerptedPages}
          {' of '}
          {pending.body.context.searchedScope.automatic.availablePages}
          {
            ' readable pages sampled. This is a partial evidence review, not a complete case analysis.'
          }
        </p>
      ) : null}
      <ul className="m-0 mt-2 list-disc pl-5 text-lj-secondary">
        {DISCLOSURE_FACTS.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
        {pending.notices.map((notice) => (
          <li key={notice}>{notice}</li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={`${button} bg-lj-bg`}
          onClick={onSend}
          data-testid="disclosure-send"
        >
          Send to {pending.testProvider ? 'test provider' : 'Qwen'}
        </button>
        <button type="button" className={button} onClick={onCancel} data-testid="disclosure-cancel">
          Cancel, send nothing
        </button>
      </div>
    </section>
  );
}
