'use client';

import { useEffect, useRef } from 'react';
import { useReview } from '@/components/review/review-context';
import { useVault } from '@/components/vault/vault-context';
import type { RunView } from '@/features/assistant/public';
import { useAssistant } from './assistant-context';
import { DisclosurePreview } from './DisclosurePreview';
import { RunCard } from './RunCard';
import { RunActions } from './RunActions';
import { AgentIdentityLine } from './AgentIdentityLine';

/**
 * The conversation, shared by both layouts: expanded in the Command centre and docked beside the
 * document in Review mode. It is held in memory only and is cleared on lock, sign-out or a
 * change of matter.
 */
export function ConversationPanel({ compact = false }: { compact?: boolean }) {
  const { controller, snapshot } = useAssistant();
  const { setFocus } = useReview();
  const vault = useVault();
  const end = useRef<HTMLDivElement | null>(null);
  const count = snapshot.conversation.length;
  useEffect(() => {
    // Only follow new messages: an empty or freshly mounted transcript must not scroll the stage.
    if (count > 0 || snapshot.pending !== null) end.current?.scrollIntoView({ block: 'nearest' });
  }, [count, snapshot.pending]);

  /** Reopens the exact cited passage, only if it still matches the current verified artifacts. */
  const open = (run: RunView | null, handle: string) => {
    const focus = run === null ? null : (controller?.openSource(run.id, handle) ?? null);
    if (focus !== null) setFocus(focus);
  };

  const matter = vault.snapshot.selectedMatter;
  const pending = snapshot.pending;
  const documentLabel =
    pending?.body.documentVersionId == null
      ? null
      : (matter?.sources.find((s) => s.documentVersionId === pending.body.documentVersionId)
          ?.label ?? 'Selected document');

  return (
    <div className={compact ? 'grid gap-3' : 'grid gap-4'} data-testid="assistant-conversation">
      <AgentIdentityLine />
      {snapshot.conversation.length === 0 && pending === null ? (
        <p className="m-0 mt-2 text-[0.875rem] text-lj-secondary">
          No conversation. Select text and choose Explain selection, or use the command dock.
          Messages are kept in memory only and are not saved unless you save an outcome.
        </p>
      ) : null}
      <ol className="m-0 grid list-none gap-3 p-0" aria-label="Conversation">
        {snapshot.conversation.map((item) => (
          <li key={item.id} data-role={item.role}>
            {item.role === 'user' ? (
              <p className="m-0 break-words text-[0.9375rem]">
                <span className="text-lj-muted">You: </span>
                {item.text}
              </p>
            ) : item.run !== null ? (
              <RunCard run={item.run} onOpenSource={(handle) => open(item.run, handle)}>
                <RunActions run={item.run} onOpenSource={(handle) => open(item.run, handle)} />
              </RunCard>
            ) : (
              <p
                className="m-0 text-[0.875rem] text-lj-secondary"
                data-testid="assistant-notice-item"
              >
                {item.text}
              </p>
            )}
          </li>
        ))}
      </ol>
      {pending !== null ? (
        <div>
          <DisclosurePreview
            pending={pending}
            matterTitle={matter?.title ?? 'Selected matter'}
            documentLabel={documentLabel}
            onSend={() => void controller?.send()}
            onCancel={() => controller?.cancelPreview()}
          />
          <label className="mt-2 flex min-h-11 items-center gap-2 text-[0.875rem]">
            <input
              type="checkbox"
              checked={snapshot.includeHistory}
              onChange={(event) => void controller?.setIncludeHistory(event.target.checked)}
            />
            Include earlier messages from this conversation
          </label>
        </div>
      ) : null}
      <div ref={end} />
    </div>
  );
}
