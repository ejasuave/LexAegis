import type { LocalAvailability, RecognitionAdapter, RecognizerLike } from './adapter';

/*
 * Optional on-device dictation. Recognition is requested with processLocally=true only and is
 * enabled only when the browser itself reports that local recognition is available for the
 * language. There is no cloud fallback, no audio capture or upload, no wake word and no
 * background listening. Results go into an editable draft that still needs Send, and nothing
 * spoken can confirm a fact, approve, sign or send a transaction.
 */

export const DEFAULT_LANGUAGE = 'en-GB';
export const MAX_CAPTURE_MS = 30_000;

export type VoiceCapability =
  | 'unsupported'
  | 'checking'
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'ready'
  | 'denied'
  | 'failed';

export type CapturePhase = 'idle' | 'starting' | 'listening' | 'finishing';

export interface VoiceSnapshot {
  readonly language: string;
  readonly capability: VoiceCapability;
  readonly phase: CapturePhase;
  /** Provisional text. It is shown but never put in the draft until final. */
  readonly interim: string;
  readonly message: string;
}

const INITIAL = (language: string): VoiceSnapshot =>
  Object.freeze({ language, capability: 'checking', phase: 'idle', interim: '', message: '' });

export interface VoiceDeps {
  readonly adapter: RecognitionAdapter;
  readonly language?: string;
  /** Final text, appended by the caller to the latest draft. Never replaces manual edits. */
  readonly onFinalText: (text: string) => void;
  /** Dictation and playback never overlap: starting capture stops playback first. */
  readonly stopPlayback: () => void;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

const MAP: Record<LocalAvailability, VoiceCapability> = {
  available: 'ready',
  downloadable: 'downloadable',
  downloading: 'downloading',
  unavailable: 'unavailable',
};

export class VoiceController {
  readonly #deps: VoiceDeps;
  readonly #listeners = new Set<() => void>();
  #state: VoiceSnapshot;
  #recognizer: RecognizerLike | null = null;
  /** Callbacks belong to one capture generation; anything from another is ignored. */
  #generation = 0;
  #timer: unknown = null;
  #finalChunks: string[] = [];
  #aborted = false;

  constructor(deps: VoiceDeps) {
    this.#deps = deps;
    this.#state = INITIAL(deps.language ?? DEFAULT_LANGUAGE);
    if (!deps.adapter.supported)
      this.#state = Object.freeze({ ...this.#state, capability: 'unsupported' });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getSnapshot = (): VoiceSnapshot => this.#state;
  /** For the coordinated Stop: any capture work that is still pending. */
  isActive = (): boolean => this.#state.phase !== 'idle';

  #set(patch: Partial<VoiceSnapshot>): void {
    this.#state = Object.freeze({ ...this.#state, ...patch });
    for (const listener of this.#listeners) listener();
  }

  /** Asks the browser whether local recognition exists for this language. Never infers it. */
  async refreshCapability(): Promise<void> {
    if (!this.#deps.adapter.supported) {
      this.#set({ capability: 'unsupported' });
      return;
    }
    this.#set({ capability: 'checking' });
    const answer = await this.#deps.adapter.available(this.#state.language);
    // A denial or failure already observed is not overwritten by a late availability answer.
    if (this.#state.capability === 'denied' || this.#state.capability === 'failed') return;
    this.#set({ capability: MAP[answer] });
  }

  /** Explicit download of the on-device language pack, then a re-check. */
  async downloadLanguagePack(): Promise<void> {
    if (this.#state.capability !== 'downloadable') return;
    this.#set({ capability: 'downloading', message: '' });
    const installed = await this.#deps.adapter.install(this.#state.language);
    if (!installed) this.#set({ message: 'The language pack did not install.' });
    await this.refreshCapability();
  }

  /** Push-to-talk start. Only when the browser reported local recognition as ready. */
  start(): boolean {
    if (
      this.#state.capability !== 'ready' ||
      this.#state.phase !== 'idle' ||
      this.#recognizer !== null
    )
      return false;
    this.#deps.stopPlayback();
    const generation = ++this.#generation;
    this.#aborted = false;
    this.#finalChunks = [];
    let recognizer: RecognizerLike;
    try {
      recognizer = this.#deps.adapter.create();
    } catch {
      this.#set({ capability: 'failed', message: 'Speech recognition could not be created.' });
      return false;
    }
    recognizer.lang = this.#state.language;
    recognizer.processLocally = true; // never false: no cloud fallback exists
    recognizer.continuous = false;
    recognizer.interimResults = true;
    recognizer.onstart = () => {
      if (generation !== this.#generation) return;
      this.#set({ phase: 'listening' });
    };
    recognizer.onresult = (results) => {
      if (generation !== this.#generation || this.#aborted) return;
      let interim = '';
      for (const item of results) {
        if (item.isFinal) this.#finalChunks.push(item.transcript);
        else interim += item.transcript;
      }
      this.#set({ interim });
    };
    recognizer.onerror = (error) => {
      if (generation !== this.#generation) return;
      this.#teardown(generation);
      this.#set({
        capability:
          error === 'not-allowed' || error === 'service-not-allowed' ? 'denied' : 'failed',
        message:
          error === 'not-allowed' || error === 'service-not-allowed'
            ? 'Microphone permission was denied. Typing still works.'
            : `Dictation stopped (${error}). Typing still works.`,
        phase: 'idle',
        interim: '',
      });
    };
    recognizer.onend = () => {
      if (generation !== this.#generation) return;
      // Normal end after Finish: deliver the final text. After an abort, deliver nothing.
      const text = this.#aborted ? '' : this.#finalChunks.join(' ').trim();
      this.#teardown(generation);
      this.#set({ phase: 'idle', interim: '' });
      if (text !== '') this.#deps.onFinalText(text);
    };
    this.#recognizer = recognizer;
    this.#set({ phase: 'starting', interim: '', message: '' });
    const setTimer = this.#deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#timer = setTimer(() => {
      if (generation === this.#generation && this.#state.phase !== 'idle') this.finish();
    }, MAX_CAPTURE_MS);
    try {
      recognizer.start();
    } catch {
      this.#teardown(generation);
      this.#set({ phase: 'idle', capability: 'failed', message: 'Dictation could not start.' });
      return false;
    }
    return true;
  }

  /** Normal button release or Finish: stop() so the final result still arrives. */
  finish(): void {
    const recognizer = this.#recognizer;
    if (recognizer === null || this.#state.phase === 'idle' || this.#state.phase === 'finishing')
      return;
    this.#set({ phase: 'finishing' });
    recognizer.stop();
  }

  /** Stop and every involuntary loss of control: abort() and reject late results. */
  abort(): void {
    const recognizer = this.#recognizer;
    if (recognizer === null) return;
    this.#aborted = true;
    const generation = this.#generation;
    recognizer.abort();
    this.#teardown(generation);
    this.#set({ phase: 'idle', interim: '' });
  }

  #teardown(generation: number): void {
    if (generation !== this.#generation) return;
    const recognizer = this.#recognizer;
    if (recognizer !== null) {
      recognizer.onstart = null;
      recognizer.onend = null;
      recognizer.onerror = null;
      recognizer.onresult = null;
    }
    this.#recognizer = null;
    if (this.#timer !== null)
      (this.#deps.clearTimer ?? ((h) => clearTimeout(h as never)))(this.#timer);
    this.#timer = null;
    this.#generation++;
  }

  /** Lock, matter or version switch, hidden page, unmount: abort and detach everything. */
  dispose(): void {
    this.abort();
    this.#listeners.clear();
  }
}
