import { describe, expect, it } from 'vitest';
import type {
  LocalAvailability,
  RecognitionAdapter,
  RecognitionResultLike,
  RecognizerLike,
  SynthesisAdapter,
  UtteranceHandlers,
  VoiceInfo,
} from './adapter';
import { MAX_CAPTURE_MS, VoiceController } from './recognition';
import { MAX_READ_CHARS, ReadAloudController, toPlainText } from './read-aloud';

class FakeRecognizer implements RecognizerLike {
  lang = '';
  processLocally = false;
  continuous = true;
  interimResults = false;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((error: string) => void) | null = null;
  onresult: ((results: readonly RecognitionResultLike[]) => void) | null = null;
  calls: string[] = [];
  start() {
    this.calls.push('start');
    this.onstart?.();
  }
  stop() {
    this.calls.push('stop');
  }
  abort() {
    this.calls.push('abort');
  }
}

function recognitionRig(availability: LocalAvailability = 'available', supported = true) {
  const recognizers: FakeRecognizer[] = [];
  const asked: string[] = [];
  let state = availability;
  const adapter: RecognitionAdapter = {
    supported,
    available: (language) => (asked.push(language), Promise.resolve(state)),
    install: () => {
      state = 'available';
      return Promise.resolve(true);
    },
    create: () => {
      const r = new FakeRecognizer();
      recognizers.push(r);
      return r;
    },
  };
  const finals: string[] = [];
  let playbackStops = 0;
  let timer: (() => void) | null = null;
  const controller = new VoiceController({
    adapter,
    onFinalText: (t) => finals.push(t),
    stopPlayback: () => {
      playbackStops++;
    },
    setTimer: (fn) => ((timer = fn), 1),
    clearTimer: () => (timer = null),
  });
  return {
    controller,
    recognizers,
    asked,
    finals,
    playbacks: () => playbackStops,
    fireTimer: () => timer?.(),
  };
}

describe('local dictation', () => {
  it('asks the browser for en-GB local availability and enables only when it says available', async () => {
    const r = recognitionRig('available');
    await r.controller.refreshCapability();
    expect(r.asked).toEqual(['en-GB']);
    expect(r.controller.getSnapshot().capability).toBe('ready');
  });

  it('keeps unsupported, unavailable and downloadable distinct, and never captures without local support', async () => {
    const a = recognitionRig('unavailable', false);
    await a.controller.refreshCapability();
    expect(a.controller.getSnapshot().capability).toBe('unsupported');
    expect(a.controller.start()).toBe(false);
    const b = recognitionRig('unavailable');
    await b.controller.refreshCapability();
    expect(b.controller.getSnapshot().capability).toBe('unavailable');
    expect(b.controller.start()).toBe(false);
    expect(b.recognizers).toHaveLength(0); // no recognizer was created: there is no cloud fallback
    const c = recognitionRig('downloadable');
    await c.controller.refreshCapability();
    expect(c.controller.getSnapshot().capability).toBe('downloadable');
    expect(c.controller.start()).toBe(false);
  });

  it('downloads the language pack only on request, then re-checks', async () => {
    const r = recognitionRig('downloadable');
    await r.controller.refreshCapability();
    await r.controller.downloadLanguagePack();
    expect(r.controller.getSnapshot().capability).toBe('ready');
    expect(r.asked.length).toBe(2);
  });

  it('configures local, non-continuous recognition and delivers final text after Finish', async () => {
    const r = recognitionRig();
    await r.controller.refreshCapability();
    expect(r.controller.start()).toBe(true);
    const rec = r.recognizers[0];
    if (rec === undefined) throw new Error('no recognizer');
    expect(rec).toMatchObject({ lang: 'en-GB', processLocally: true, continuous: false });
    expect(r.playbacks()).toBe(1); // starting dictation stops playback
    rec.onresult?.([{ isFinal: false, transcript: 'check the pay' }]);
    expect(r.controller.getSnapshot().interim).toBe('check the pay');
    expect(r.finals).toEqual([]); // provisional text never reaches the draft
    rec.onresult?.([{ isFinal: true, transcript: 'check the payments' }]);
    r.controller.finish();
    expect(rec.calls).toContain('stop');
    expect(r.controller.getSnapshot().phase).toBe('finishing'); // release keeps the pending final phase
    rec.onend?.();
    expect(r.finals).toEqual(['check the payments']);
    expect(r.controller.getSnapshot().phase).toBe('idle');
  });

  it('abort rejects late results and does not restart', async () => {
    const r = recognitionRig();
    await r.controller.refreshCapability();
    r.controller.start();
    const rec = r.recognizers[0];
    if (rec === undefined) throw new Error('no recognizer');
    const results = rec.onresult;
    const end = rec.onend;
    r.controller.abort();
    expect(rec.calls).toContain('abort');
    results?.([{ isFinal: true, transcript: 'approve and sign' }]);
    end?.();
    expect(r.finals).toEqual([]);
    expect(r.recognizers).toHaveLength(1);
    expect(r.controller.getSnapshot().phase).toBe('idle');
  });

  it('allows one recognizer at a time and ends capture at the 30-second limit', async () => {
    const r = recognitionRig();
    await r.controller.refreshCapability();
    expect(r.controller.start()).toBe(true);
    expect(r.controller.start()).toBe(false);
    expect(r.recognizers).toHaveLength(1);
    expect(MAX_CAPTURE_MS).toBe(30_000);
    r.fireTimer();
    expect(r.recognizers[0]?.calls).toContain('stop');
  });

  it('reports a permission denial as its own state and leaves typing usable', async () => {
    const r = recognitionRig();
    await r.controller.refreshCapability();
    r.controller.start();
    r.recognizers[0]?.onerror?.('not-allowed');
    expect(r.controller.getSnapshot()).toMatchObject({ capability: 'denied', phase: 'idle' });
    expect(r.controller.start()).toBe(false);
  });

  it('a spoken approval is only text: it reaches the draft callback and nothing else', async () => {
    const r = recognitionRig();
    await r.controller.refreshCapability();
    r.controller.start();
    r.recognizers[0]?.onresult?.([{ isFinal: true, transcript: 'yes approve and sign it' }]);
    r.controller.finish();
    r.recognizers[0]?.onend?.();
    expect(r.finals).toEqual(['yes approve and sign it']);
  });
});

// ---- Read-aloud ---------------------------------------------------------------------------------

function synthRig(voices: VoiceInfo[]) {
  const spoken: { text: string; voiceURI: string; handlers: UtteranceHandlers }[] = [];
  let listener: (() => void) | null = null;
  let current = voices;
  const calls: string[] = [];
  const adapter: SynthesisAdapter = {
    supported: true,
    voices: () => current,
    onVoicesChanged: (l) => ((listener = l), () => (listener = null)),
    speak: (text, voiceURI, _lang, handlers) => {
      spoken.push({ text, voiceURI, handlers });
    },
    pause: () => void calls.push('pause'),
    resume: () => void calls.push('resume'),
    cancel: () => void calls.push('cancel'),
  };
  let listening = false;
  const store = new Map<string, string>();
  const controller = new ReadAloudController({
    adapter,
    isListening: () => listening,
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
  });
  return {
    controller,
    spoken,
    calls,
    store,
    setListening: (v: boolean) => (listening = v),
    setVoices: (v: VoiceInfo[]) => {
      current = v;
      listener?.();
    },
  };
}

const LOCAL: VoiceInfo = { voiceURI: 'local-1', name: 'Local', lang: 'en-GB', localService: true };
const REMOTE: VoiceInfo = {
  voiceURI: 'remote-1',
  name: 'Remote',
  lang: 'en-GB',
  localService: false,
};

describe('read-aloud', () => {
  it('offers only on-device voices and refuses to select a remote one', () => {
    const r = synthRig([LOCAL, REMOTE]);
    expect(r.controller.getSnapshot().localVoices.map((v) => v.voiceURI)).toEqual(['local-1']);
    expect(r.controller.selectVoice('remote-1')).toBe(false);
    expect(r.controller.selectVoice('local-1')).toBe(true);
  });

  it('needs an explicitly chosen voice and never falls back to a default or remote one', () => {
    const r = synthRig([LOCAL, REMOTE]);
    expect(r.controller.play('hello')).toBe(false);
    expect(r.spoken).toHaveLength(0);
  });

  it('speaks plain text only, bounded to 4,000 characters, and never stores the text', () => {
    const r = synthRig([LOCAL]);
    r.controller.selectVoice('local-1');
    expect(r.controller.play('<speak>Hello <break/> & goodbye</speak>')).toBe(true);
    expect(r.spoken[0]?.text).not.toMatch(/[<>&]/);
    expect(r.controller.play('x'.repeat(MAX_READ_CHARS + 1))).toBe(false);
    expect(r.controller.getSnapshot().message).toContain('4,000');
    expect([...r.store.values()].join('')).not.toContain('Hello');
    expect(toPlainText('a  <b>')).toBe('a b');
  });

  it('refuses while dictation is active and stops when the chosen voice disappears', () => {
    const r = synthRig([LOCAL]);
    r.controller.selectVoice('local-1');
    r.setListening(true);
    expect(r.controller.play('hello')).toBe(false);
    r.setListening(false);
    r.controller.play('hello');
    r.setVoices([]);
    expect(r.controller.getSnapshot()).toMatchObject({ selectedVoiceURI: null, playback: 'idle' });
    expect(r.calls).toContain('cancel');
    expect(r.controller.play('again')).toBe(false);
  });

  it('ignores late callbacks from a cancelled utterance and supports pause, resume and stop', () => {
    const r = synthRig([LOCAL]);
    r.controller.selectVoice('local-1');
    r.controller.play('one');
    const first = r.spoken[0];
    r.controller.pause();
    expect(r.controller.getSnapshot().playback).toBe('paused');
    r.controller.resume();
    r.controller.cancel('stop');
    first?.handlers.onstart();
    expect(r.controller.getSnapshot().playback).toBe('idle');
    expect(r.calls).toEqual(expect.arrayContaining(['pause', 'resume', 'cancel']));
  });

  it('reports unsupported honestly and keeps text usable', () => {
    const adapter: SynthesisAdapter = {
      supported: false,
      voices: () => [],
      onVoicesChanged: () => () => undefined,
      speak: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      cancel: () => undefined,
    };
    const c = new ReadAloudController({ adapter, isListening: () => false });
    expect(c.getSnapshot().supported).toBe(false);
    expect(c.getSnapshot().message).toContain('not available');
    expect(c.play('hello')).toBe(false);
  });
});
