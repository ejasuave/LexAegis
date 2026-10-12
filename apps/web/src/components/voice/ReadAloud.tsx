'use client';

import { useId } from 'react';
import { useVoice } from './voice-context';

const btn = 'min-h-11 rounded border border-lj-edge px-3 text-[0.8125rem]';

/**
 * Read one answer aloud with an on-device voice you chose. Only the text you select here is
 * spoken, as plain text, up to 4,000 characters. Nothing is read automatically.
 */
export function ReadAloudButton({ text }: { text: string }) {
  const { reader, readState } = useVoice();
  const selectId = useId();
  if (reader === null || readState === null) return null;
  if (!readState.supported)
    return <p className="m-0 mt-1 text-[0.8125rem] text-lj-secondary">{readState.message}</p>;
  const speaking =
    readState.playback === 'starting' ||
    readState.playback === 'speaking' ||
    readState.playback === 'paused';
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <label htmlFor={selectId} className="text-[0.8125rem] text-lj-secondary">
        On-device voice
      </label>
      <select
        id={selectId}
        className="min-h-11 rounded border border-lj-edge bg-lj-soft px-2 text-[0.875rem]"
        value={readState.selectedVoiceURI ?? ''}
        onChange={(event) => reader.selectVoice(event.target.value)}
      >
        <option value="">Choose…</option>
        {readState.localVoices.map((voice) => (
          <option key={voice.voiceURI} value={voice.voiceURI}>
            {voice.name} ({voice.lang})
          </option>
        ))}
      </select>
      {!speaking ? (
        <button
          type="button"
          className={btn}
          data-testid="read-aloud-play"
          onClick={() => reader.play(text)}
        >
          Read aloud
        </button>
      ) : (
        <>
          {readState.playback === 'speaking' ? (
            <button type="button" className={btn} onClick={() => reader.pause()}>
              Pause
            </button>
          ) : readState.playback === 'paused' ? (
            <button type="button" className={btn} onClick={() => reader.resume()}>
              Resume
            </button>
          ) : null}
          <button
            type="button"
            className={btn}
            data-testid="read-aloud-stop"
            onClick={() => reader.cancel('stop')}
          >
            Stop reading
          </button>
        </>
      )}
      <span
        role="status"
        aria-live="polite"
        className="text-[0.8125rem] text-lj-secondary"
        data-testid="read-aloud-status"
      >
        {readState.playback === 'starting'
          ? 'Starting on this device. Nothing is speaking yet.'
          : readState.playback === 'speaking'
            ? 'Speaking on this device'
            : readState.playback === 'paused'
              ? 'Paused'
              : readState.message}
      </span>
    </div>
  );
}
