'use client';

import { useId, useState, type SyntheticEvent } from 'react';
import { useAssistant } from '@/components/assistant/assistant-context';
import { useFeatureFlag } from './feature-flags-context';
import { Icon } from './icons';
import { useWorkspace } from './workspace-context';

export const SLASH_COMMANDS = [
  '/summarise',
  '/explain',
  '/check-payments',
  '/missing-evidence',
  '/prepare-review',
  '/status',
  '/stop',
] as const;

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
  const { draft, setDraft, activityOpen, setActivityOpen } = useWorkspace();
  const { controller, snapshot } = useAssistant();
  const [menuOpen, setMenuOpen] = useState(false);
  const voiceEnabled = useFeatureFlag('voice');
  const briefing = useFeatureFlag('matterBriefing');
  const inputId = useId();
  const noticeId = useId();
  const stoppable =
    snapshot.phase === 'running' || snapshot.phase === 'stopping' || snapshot.phase === 'preview';
  const commands = briefing ? [...SLASH_COMMANDS.slice(0, 6), '/brief', '/stop'] : SLASH_COMMANDS;

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (text === '' || controller === null) return;
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
    <section
      aria-label="Command dock"
      className="lj-safe-x lj-safe-bottom sticky bottom-0 z-10 border-t border-lj-divider bg-lj-bg py-2"
    >
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <button
            type="button"
            className={button}
            aria-expanded={menuOpen}
            aria-controls="command-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            Commands
          </button>
          {menuOpen ? (
            <ul
              id="command-menu"
              aria-label="Commands"
              className="absolute bottom-full left-0 z-20 m-0 mb-2 min-w-56 list-none border border-lj-edge bg-lj-soft p-1"
            >
              {commands.map((command) => (
                <li key={command}>
                  <button
                    type="button"
                    className="min-h-11 w-full px-3 text-left font-mono text-[0.875rem] hover:bg-lj-bg"
                    onClick={() => {
                      setDraft(command);
                      setMenuOpen(false);
                    }}
                  >
                    {command}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <label htmlFor={inputId} className="sr-only">
          Command or question for Aegis
        </label>
        <input
          id={inputId}
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={2000}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask Aegis or type / for commands"
          aria-describedby={noticeId}
          data-testid="aegis-input"
          className="min-h-11 min-w-0 flex-1 basis-64 rounded border border-lj-edge bg-lj-soft px-3 font-mono text-base text-lj-text placeholder:text-lj-muted"
        />

        <button
          type="submit"
          className={`${button} bg-lj-soft`}
          aria-disabled={controller === null}
          data-testid="aegis-send"
        >
          <Icon name="send" /> Send
        </button>
        {voiceEnabled ? (
          <button
            type="button"
            aria-disabled="true"
            title="Voice input is not available on this device."
            className={`${button} text-lj-muted`}
          >
            <Icon name="mic" /> Voice unavailable
          </button>
        ) : null}
        <button
          type="button"
          aria-disabled={!stoppable}
          title={stoppable ? 'Stop the assistant' : 'There is no active run to stop.'}
          className={`${button} ${stoppable ? '' : 'text-lj-muted'}`}
          data-testid="aegis-stop"
          onClick={() => {
            if (stoppable) void controller?.stop();
          }}
        >
          <Icon name="stop" /> {snapshot.phase === 'stopping' ? 'Stopping' : 'Stop'}
        </button>
        <button
          type="button"
          className={button}
          aria-expanded={activityOpen}
          aria-controls="activity-drawer"
          onClick={() => setActivityOpen(!activityOpen)}
        >
          <Icon name="activity" /> Activity
        </button>
      </form>
      <p
        id={noticeId}
        role="status"
        aria-live="polite"
        data-testid="aegis-notice"
        className="m-0 mt-1 min-h-5 text-[0.8125rem] text-lj-secondary"
      >
        {notice}
      </p>
    </section>
  );
}
