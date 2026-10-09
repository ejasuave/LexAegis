'use client';

import { useId, useState, type SyntheticEvent } from 'react';
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

/**
 * Persistent command dock. The text input and menu work; sending and Stop are honest about being
 * unavailable (no assistant or active run exists yet) and never simulate work. The voice control
 * exists only while the voice flag is on, so with voice off nothing can acquire a microphone.
 */
export function CommandDock() {
  const { draft, setDraft, activityOpen, setActivityOpen } = useWorkspace();
  const [notice, setNotice] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const voiceEnabled = useFeatureFlag('voice');
  const inputId = useId();
  const noticeId = useId();

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice('The assistant is not available yet. Your draft has been kept and nothing was sent.');
  };

  return (
    <section aria-label="Command dock" className="border-t border-lj-divider bg-lj-bg px-3 py-2">
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
              {SLASH_COMMANDS.map((command) => (
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
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask Aegis or type / for commands"
          aria-describedby={noticeId}
          className="min-h-11 min-w-0 flex-1 basis-64 rounded border border-lj-edge bg-lj-soft px-3 font-mono text-base text-lj-text placeholder:text-lj-muted"
        />

        <button type="submit" className={`${button} bg-lj-soft`}>
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
          aria-disabled="true"
          title="There is no active run to stop."
          className={`${button} text-lj-muted`}
        >
          <Icon name="stop" /> Stop
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
        className="m-0 mt-1 min-h-5 text-[0.8125rem] text-lj-secondary"
      >
        {notice || 'The assistant and Stop are unavailable: no assistant run exists yet.'}
      </p>
    </section>
  );
}
