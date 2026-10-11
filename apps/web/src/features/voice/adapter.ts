/*
 * Typed capability adapters for on-device speech. They describe only what the browser reports:
 * the real SpeechRecognition (with processLocally, available() and install()) and the real
 * speechSynthesis. A fake object, a prefixed constructor, a browser name or a granted microphone
 * permission is never taken as proof that recognition is local. Tests inject their own adapters;
 * mocked speech proves controller behaviour only, not a real device.
 */

export type LocalAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

export interface RecognitionResultLike {
  readonly isFinal: boolean;
  readonly transcript: string;
}

export interface RecognizerLike {
  lang: string;
  processLocally: boolean;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((error: string) => void) | null;
  onresult: ((results: readonly RecognitionResultLike[]) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface RecognitionAdapter {
  /** Secure context and the constructor, available() and processLocally all exist. */
  readonly supported: boolean;
  available(language: string): Promise<LocalAvailability>;
  install(language: string): Promise<boolean>;
  create(): RecognizerLike;
}

export interface VoiceInfo {
  readonly voiceURI: string;
  readonly name: string;
  readonly lang: string;
  readonly localService: boolean;
}

export interface UtteranceHandlers {
  onstart: () => void;
  onend: () => void;
  onerror: (error: string) => void;
}

export interface SynthesisAdapter {
  readonly supported: boolean;
  voices(): readonly VoiceInfo[];
  /** Calls back whenever the voice list changes. Returns the unsubscribe. */
  onVoicesChanged(listener: () => void): () => void;
  speak(text: string, voiceURI: string, lang: string, handlers: UtteranceHandlers): void;
  pause(): void;
  resume(): void;
  cancel(): void;
}

// ---- Real browser adapters (never used in tests) ------------------------------------------------

interface SpeechRecognitionCtor {
  new (): {
    lang: string;
    processLocally?: boolean;
    continuous: boolean;
    interimResults: boolean;
    onstart: (() => void) | null;
    onend: (() => void) | null;
    onerror: ((event: { error?: string }) => void) | null;
    onresult:
      | ((event: {
          resultIndex: number;
          results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
        }) => void)
      | null;
    start(): void;
    stop(): void;
    abort(): void;
  };
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
  install?: (options: { langs: string[]; processLocally: boolean }) => Promise<boolean>;
}

/** The unprefixed constructor only: a prefixed one does not prove processLocally support. */
function recognitionCtor(win: Window): SpeechRecognitionCtor | null {
  const ctor = (win as unknown as { SpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition;
  return typeof ctor === 'function' ? ctor : null;
}

export function browserRecognitionAdapter(win: Window): RecognitionAdapter {
  const ctor = recognitionCtor(win);
  const supported =
    win.isSecureContext &&
    ctor !== null &&
    typeof ctor.available === 'function' &&
    typeof ctor.install === 'function' &&
    'processLocally' in ctor.prototype;
  return {
    supported,
    async available(language) {
      if (ctor?.available === undefined) return 'unavailable';
      try {
        const answer = await ctor.available({ langs: [language], processLocally: true });
        return answer === 'available' || answer === 'downloadable' || answer === 'downloading'
          ? answer
          : 'unavailable';
      } catch {
        return 'unavailable';
      }
    },
    async install(language) {
      if (ctor?.install === undefined) return false;
      try {
        return await ctor.install({ langs: [language], processLocally: true });
      } catch {
        return false;
      }
    },
    create() {
      if (ctor === null) throw new Error('SpeechRecognition is not available');
      const native = new ctor();
      const wrapper: RecognizerLike = {
        get lang() {
          return native.lang;
        },
        set lang(value) {
          native.lang = value;
        },
        get processLocally() {
          return native.processLocally === true;
        },
        set processLocally(value) {
          native.processLocally = value;
        },
        get continuous() {
          return native.continuous;
        },
        set continuous(value) {
          native.continuous = value;
        },
        get interimResults() {
          return native.interimResults;
        },
        set interimResults(value) {
          native.interimResults = value;
        },
        onstart: null,
        onend: null,
        onerror: null,
        onresult: null,
        start: () => native.start(),
        stop: () => native.stop(),
        abort: () => native.abort(),
      };
      native.onstart = () => wrapper.onstart?.();
      native.onend = () => wrapper.onend?.();
      native.onerror = (event) => wrapper.onerror?.(event.error ?? 'unknown');
      native.onresult = (event) => {
        const out: RecognitionResultLike[] = [];
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const item = event.results[i];
          if (item !== undefined)
            out.push({ isFinal: item.isFinal, transcript: item[0].transcript });
        }
        wrapper.onresult?.(out);
      };
      return wrapper;
    },
  };
}

export function browserSynthesisAdapter(win: Window): SynthesisAdapter {
  const synth = (win as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  const supported =
    win.isSecureContext && synth !== undefined && typeof SpeechSynthesisUtterance !== 'undefined';
  return {
    supported,
    voices: () =>
      synth === undefined
        ? []
        : synth.getVoices().map((voice) => ({
            voiceURI: voice.voiceURI,
            name: voice.name,
            lang: voice.lang,
            localService: voice.localService,
          })),
    onVoicesChanged(listener) {
      synth?.addEventListener('voiceschanged', listener);
      return () => synth?.removeEventListener('voiceschanged', listener);
    },
    speak(text, voiceURI, lang, handlers) {
      if (synth === undefined) return;
      const voice = synth.getVoices().find((v) => v.voiceURI === voiceURI);
      // The choice must exist and be local at the moment of speaking, or nothing is spoken.
      if (voice === undefined || !voice.localService) {
        handlers.onerror('voice-unavailable');
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = voice;
      utterance.lang = lang;
      utterance.onstart = () => handlers.onstart();
      utterance.onend = () => handlers.onend();
      utterance.onerror = (event) => handlers.onerror(event.error);
      synth.speak(utterance);
    },
    pause: () => synth?.pause(),
    resume: () => synth?.resume(),
    cancel: () => synth?.cancel(),
  };
}
