'use client';

import { useId, type SyntheticEvent } from 'react';
import { useAssistant } from '@/components/assistant/assistant-context';
import { useReview } from '@/components/review/review-context';
import { availableCommands } from '@/features/hud/public';
import { useCommandDispatch } from '@/components/hud/use-command-dispatch';
import { decideEnter } from './command-input';
import { useFeatureFlag } from './feature-flags-context';
import { useStop } from './stop-context';
import { useApproval } from '@/components/review/approval-context';
import { useTransaction } from '@/components/chain/transaction-context';
import { useVoice } from '@/components/voice/voice-context';
import { VoiceControls } from '@/components/voice/VoiceControls';
import { Icon } from './icons';
import { useWorkspace } from './workspace-context';

/** The allowlisted commands with every optional feature off; the registry in features/hud is the source. */
export const SLASH_COMMANDS = availableCommands({ matterBriefing: false }).map(
  (entry) => entry.command,
);

const button =
  'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded border border-lj-edge px-3 text-[0.875rem]';

const IDLE_TEXT = {
  unknown: 'Checking whether the assistant is available.',
  loading: 'Checking whether the assistant is available.',
  signed_out: 'Sign in on the Vault page to ask Aegis. Local commands such as /status still work.',
  unreachable: 'The assistant service could not be reached. Local commands still work.',
  ready: 'Type a question or a command. Nothing is sent until you review it and choose Send.',
} as const;

/**
 * Persistent command dock. Typed input, slash commands and the Stop control all go to the same
 * assistant controller. Send here only prepares a request: text reaches a provider solely through
 * the disclosure preview's own Send. The voice control exists only while the voice flag is on.
 */
export function CommandDock() {
  const {
    draft,
    setDraft,
    activityOpen,
    setActivityOpen,
    contextOpen,
    setContextOpen,
    paletteOpen,
    setPaletteOpen,
    dockInput,
    commandNote,
  } = useWorkspace();
  const dispatch = useCommandDispatch();
  const review = useReview().snapshot;
  const { controller, snapshot } = useAssistant();
  const stopper = useStop();
  // Re-render when any stoppable part changes state, so Stop reflects what can really be stopped.
  useApproval();
  useTransaction();
  useVoice();
  const voiceEnabled = useFeatureFlag('voice');
  const inputId = useId();
  const noticeId = useId();
  const scopeId = useId();
  const stoppable =
    snapshot.phase === 'running' ||
    snapshot.phase === 'stopping' ||
    snapshot.phase === 'preview' ||
    stopper.canStop();

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (text === '') return;
    // /stop cancels directly. Everything else is the normal consent and validation path.
    if (dispatch.resolve(text).kind === 'stop') {
      dispatch.stop();
      setDraft('');
      return;
    }
    if (controller === null) return;
    // The draft is cleared only once the request was taken up; a refused one stays for editing.
    void controller.submit(text).then(() => {
      const after = controller.getSnapshot();
      if (after.phase !== 'idle' || after.conversation.length > 0) setDraft('');
    });
  };

  const notice =
    controller === null
      ? 'The assistant is not available in this browser session yet.'
      : snapshot.notice !== ''
        ? snapshot.notice
        : IDLE_TEXT[snapshot.availabilityStatus];

  return (
    <section aria-label="Command dock" className="lj-dock lj-gutter">
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={button}
          aria-haspopup="dialog"
          aria-expanded={paletteOpen}
          data-testid="commands-launcher"
          onClick={() => setPaletteOpen(true)}
        >
          Commands
        </button>

        <label htmlFor={inputId} className="sr-only">
          Command or question for Aegis
        </label>
        <textarea
          id={inputId}
          ref={dockInput}
          rows={1}
          autoComplete="off"
          spellCheck={false}
          maxLength={2000}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            const decision = decideEnter({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
              draft,
              busy: snapshot.phase === 'running' || snapshot.phase === 'stopping',
              available: controller !== null,
            });
            if (event.key === 'Enter' && decision !== 'newline') {
              event.preventDefault();
              if (decision === 'send') event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Ask Aegis or type / for commands"
          aria-describedby={`${noticeId} ${scopeId}`}
          data-testid="aegis-input"
          className="min-h-11 min-w-0 flex-1 basis-40 resize-y sm:basis-64 lj-dock-field rounded border border-lj-edge bg-lj-soft px-3 py-2 font-mono text-base leading-6 text-lj-text placeholder:text-lj-muted"
        />

        <button
          type="submit"
          className={button}
          aria-disabled={controller === null}
          data-testid="aegis-send"
        >
          <Icon name="send" /> <span className="sr-only sm:not-sr-only">Send</span>
        </button>
        {voiceEnabled ? <VoiceControls /> : null}
        <button
          type="button"
          aria-disabled={!stoppable}
          title={stoppable ? 'Stop the assistant' : 'There is no active run to stop.'}
          className={`${button} ${stoppable ? '' : 'text-lj-muted'}`}
          data-testid="aegis-stop"
          onClick={() => {
            if (!stoppable) return;
            // /stop in the text box takes the assistant path; this button stops every part.
            dispatch.stop();
          }}
        >
          <Icon name="stop" />{' '}
          <span className="sr-only sm:not-sr-only">
            {snapshot.phase === 'stopping' ? 'Stopping' : 'Stop'}
          </span>
        </button>
        <button
          type="button"
          className={button}
          aria-expanded={contextOpen}
          aria-controls="context-drawer"
          onClick={() => setContextOpen(!contextOpen)}
        >
          <Icon name="file" /> <span className="sr-only sm:not-sr-only">Saved context</span>
        </button>
        <button
          type="button"
          className={button}
          aria-expanded={activityOpen}
          aria-controls="activity-drawer"
          onClick={() => setActivityOpen(!activityOpen)}
        >
          <Icon name="activity" /> <span className="sr-only sm:not-sr-only">Activity</span>
        </button>
      </form>
      <div className="flex flex-wrap gap-x-6">
        <p
          id={scopeId}
          className="m-0 mt-1 line-clamp-1 text-[0.8125rem] text-lj-secondary lg:line-clamp-none"
          data-testid="aegis-scope"
        >
          Scope:{' '}
          {snapshot.selectionCount > 0
            ? `${snapshot.selectionCount} selected passage(s) in ${
                review.documents.find((doc) => doc.selected)?.label ?? 'the selected document'
              }. You review exactly what would be sent before Send.`
            : 'no passage selected. Local checks stay on this device.'}
        </p>
        <p
          id={noticeId}
          role="status"
          aria-live="polite"
          data-testid="aegis-notice"
          // Only the idle hint is shortened on small screens. A refusal, an error or what Stop did not
          // do is shown whole: it must never be clipped out of sight.
          className={`m-0 mt-1 min-h-5 text-[0.8125rem] text-lj-secondary ${
            commandNote === '' && snapshot.notice === '' ? 'line-clamp-1 lg:line-clamp-none' : ''
          }`}
        >
          {commandNote !== '' ? `${commandNote} ` : ''}
          {notice}
        </p>
      </div>
    </section>
  );
}
