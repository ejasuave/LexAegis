import type { SynthesisAdapter, VoiceInfo } from './adapter';

/*
 * Opt-in read-aloud with an explicitly selected on-device voice (localService === true). It
 * reads one user-selected, validated passage as plain text, bounded to 4,000 characters, never
 * new model output automatically, with no remote voice, SSML or external provider. If the chosen
 * voice is missing or not local at the moment of playback, nothing is spoken.
 */

export const MAX_READ_CHARS = 4000;
export const VOICE_PREFERENCE_KEY = 'lexaegis.voice.preference.v1';

export type PlaybackState = 'idle' | 'speaking' | 'paused' | 'error';

export interface ReadAloudSnapshot {
  readonly supported: boolean;
  readonly localVoices: readonly VoiceInfo[];
  readonly selectedVoiceURI: string | null;
  readonly playback: PlaybackState;
  readonly message: string;
}

export interface ReadAloudDeps {
  readonly adapter: SynthesisAdapter;
  readonly language?: string;
  /** Dictation and playback never overlap. */
  readonly isListening: () => boolean;
  /** Non-sensitive preference store (voice choice only). Never holds spoken text. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

/** Plain text only: markup characters are removed so an engine cannot read them as SSML. */
export function toPlainText(text: string): string {
  return text.replace(/[<>&]/g, ' ').replace(/\s+/g, ' ').trim();
}

export class ReadAloudController {
  readonly #deps: ReadAloudDeps;
  readonly #listeners = new Set<() => void>();
  readonly #off: () => void;
  #state: ReadAloudSnapshot;
  #generation = 0;

  constructor(deps: ReadAloudDeps) {
    this.#deps = deps;
    const supported = deps.adapter.supported;
    this.#state = Object.freeze({
      supported,
      localVoices: supported ? this.#localVoices() : [],
      selectedVoiceURI: supported ? this.#loadPreference() : null,
      playback: 'idle',
      message: supported
        ? ''
        : 'Read-aloud is not available: local speech cannot be verified here.',
    });
    this.#off = supported
      ? deps.adapter.onVoicesChanged(() => this.#refreshVoices())
      : () => undefined;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getSnapshot = (): ReadAloudSnapshot => this.#state;
  isActive = (): boolean =>
    this.#state.playback === 'speaking' || this.#state.playback === 'paused';

  #localVoices(): VoiceInfo[] {
    return this.#deps.adapter.voices().filter((voice) => voice.localService);
  }

  #loadPreference(): string | null {
    try {
      const raw = this.#deps.storage?.getItem(VOICE_PREFERENCE_KEY) ?? null;
      const parsed = raw === null ? null : (JSON.parse(raw) as { voiceURI?: unknown });
      return typeof parsed?.voiceURI === 'string' &&
        this.#localVoices().some((v) => v.voiceURI === parsed.voiceURI)
        ? parsed.voiceURI
        : null;
    } catch {
      return null;
    }
  }

  #set(patch: Partial<ReadAloudSnapshot>): void {
    this.#state = Object.freeze({ ...this.#state, ...patch });
    for (const listener of this.#listeners) listener();
  }

  #refreshVoices(): void {
    const local = this.#localVoices();
    const stillThere = local.some((v) => v.voiceURI === this.#state.selectedVoiceURI);
    // A chosen voice that disappeared stops playback; no default or remote voice is substituted.
    if (this.#state.selectedVoiceURI !== null && !stillThere) {
      this.cancel('voice_gone');
      this.#set({
        localVoices: local,
        selectedVoiceURI: null,
        message: 'The selected on-device voice is no longer available. Choose another.',
      });
      return;
    }
    this.#set({ localVoices: local });
  }

  selectVoice(voiceURI: string): boolean {
    if (!this.#localVoices().some((v) => v.voiceURI === voiceURI)) return false;
    try {
      // Only the voice identifier is kept: never spoken text.
      this.#deps.storage?.setItem(VOICE_PREFERENCE_KEY, JSON.stringify({ voiceURI }));
    } catch {
      // Preferences are a convenience.
    }
    this.#set({ selectedVoiceURI: voiceURI, message: '' });
    return true;
  }

  play(text: string): boolean {
    if (!this.#deps.adapter.supported) return false;
    if (this.#deps.isListening()) {
      this.#set({ message: 'Finish dictation first, then read aloud.' });
      return false;
    }
    const voiceURI = this.#state.selectedVoiceURI;
    if (voiceURI === null) {
      this.#set({ message: 'Choose an on-device voice first.' });
      return false;
    }
    // The voice must still exist and still be local right now.
    const voice = this.#deps.adapter.voices().find((v) => v.voiceURI === voiceURI);
    if (voice === undefined || !voice.localService) {
      this.#set({ selectedVoiceURI: null, message: 'That on-device voice is not available now.' });
      return false;
    }
    const plain = toPlainText(text);
    if (plain === '') return false;
    if (plain.length > MAX_READ_CHARS) {
      this.#set({
        message: `Read-aloud is limited to ${MAX_READ_CHARS.toLocaleString()} characters. Select a shorter passage.`,
      });
      return false;
    }
    this.cancel('replaced');
    const generation = ++this.#generation;
    this.#deps.adapter.speak(plain, voiceURI, voice.lang || (this.#deps.language ?? 'en-GB'), {
      onstart: () => {
        if (generation === this.#generation) this.#set({ playback: 'speaking', message: '' });
      },
      onend: () => {
        if (generation === this.#generation) this.#set({ playback: 'idle' });
      },
      onerror: (error) => {
        if (generation !== this.#generation) return;
        // A cancel we asked for is not an error.
        this.#set({
          playback: error === 'canceled' || error === 'interrupted' ? 'idle' : 'error',
          message:
            error === 'canceled' || error === 'interrupted' ? '' : `Read-aloud stopped (${error}).`,
        });
      },
    });
    this.#set({ playback: 'speaking' });
    return true;
  }

  pause(): void {
    if (this.#state.playback !== 'speaking') return;
    this.#deps.adapter.pause();
    this.#set({ playback: 'paused' });
  }

  resume(): void {
    if (this.#state.playback !== 'paused') return;
    this.#deps.adapter.resume();
    this.#set({ playback: 'speaking' });
  }

  /** Stop, lock, hidden page, switch or unmount: cancel the queue and ignore late callbacks. */
  cancel(_reason = 'user'): void {
    this.#generation++;
    this.#deps.adapter.cancel();
    if (this.#state.playback !== 'idle') this.#set({ playback: 'idle' });
  }

  dispose(): void {
    this.cancel('unmount');
    this.#off();
    this.#listeners.clear();
  }
}
