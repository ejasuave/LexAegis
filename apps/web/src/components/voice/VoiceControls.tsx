'use client';

import { useId, type KeyboardEvent } from 'react';
import { Icon } from '@/components/shell/icons';
import { useVoice } from './voice-context';

const btn =
  'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded border border-lj-edge px-3 text-[0.875rem] aria-disabled:text-lj-muted';

const CAPABILITY_TEXT = {
  unsupported: 'This browser cannot do on-device voice input. Typing works as usual.',
  checking: 'Checking on-device voice input…',
  unavailable:
    'On-device voice input is not available for British English here. Typing works as usual.',
  downloadable: 'On-device voice input needs a language pack.',
  downloading: 'Downloading the language pack…',
  ready: 'On-device voice input is ready.',
  denied: 'Microphone permission was denied. Typing works as usual.',
  failed: 'Voice input stopped working. Typing works as usual.',
} as const;

/**
 * Push-to-talk dictation. Hold the button (or press Enter or Space to start, and again to finish).
 * The text goes into the draft for you to edit and send. Nothing spoken is sent anywhere, and no
 * spoken word can approve, confirm or sign.
 */
export function VoiceControls() {
  const { voice, voiceState } = useVoice();
  const statusId = useId();
  if (voice === null || voiceState === null)
    return (
      <span role="status" className="text-[0.8125rem] text-lj-secondary">
        Checking on-device voice input…
      </span>
    );
  const { capability, phase, interim, message } = voiceState;
  const ready = capability === 'ready';
  const active = phase !== 'idle';

  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key !== 'Enter' && event.key !== ' ') || event.repeat) return;
    event.preventDefault();
    if (!ready && !active) return;
    if (active) voice.finish();
    else voice.start();
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={btn}
        aria-disabled={!ready && !active}
        aria-describedby={statusId}
        aria-pressed={active}
        data-testid="voice-talk"
        onPointerDown={(event) => {
          if (event.pointerType === 'mouse' && event.button !== 0) return;
          if (ready) voice.start();
        }}
        onPointerUp={() => voice.finish()}
        onPointerCancel={() => voice.abort()}
        onKeyDown={onKey}
        onClick={(event) => event.preventDefault()}
      >
        <Icon name="mic" />
        <span className="sr-only sm:not-sr-only">
          {phase === 'finishing'
            ? 'Finishing…'
            : active
              ? 'Listening: release or press to finish'
              : 'Hold to talk'}
        </span>
      </button>
      {capability === 'downloadable' ? (
        <button type="button" className={btn} onClick={() => void voice.downloadLanguagePack()}>
          Download language pack
        </button>
      ) : null}
      <span
        id={statusId}
        role="status"
        aria-live="polite"
        className={`text-[0.8125rem] text-lj-secondary ${ready && !active ? 'sr-only sm:not-sr-only' : ''}`}
        data-testid="voice-status"
      >
        {phase === 'listening'
          ? `Listening on this device${interim === '' ? '' : `: ${interim}`}`
          : message !== ''
            ? message
            : CAPABILITY_TEXT[capability]}
      </span>
    </span>
  );
}
