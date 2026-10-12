import type { Page } from 'playwright';
import { selectQuote } from './browser';
import { fund } from './chain';
import { addMatterAndDocument, createAccountAndVault } from './flows';
import type { Suite } from './suite';

/*
 * Rendered-control helpers for the Aegis lifecycle, voice and accessibility specs. Everything here is a
 * click, a typed value or a browser event a person or the browser could produce. The speech objects are
 * SCRIPTED STAND-INS installed before the page loads: they exercise the application's controllers and
 * prove nothing about any operating system's or browser's real speech engine or its locality.
 */

export interface SpeechScript {
  /** Install a SpeechRecognition stand-in. Default true. */
  readonly recognition?: boolean;
  /** Install a speechSynthesis stand-in. Default true. */
  readonly synthesis?: boolean;
  /** What available() reports for the language. Default 'available'. */
  readonly availability?: 'available' | 'downloadable' | 'downloading' | 'unavailable';
  /** Report a recognizer that never calls onstart (a permission prompt that is still open). */
  readonly neverStarts?: boolean;
}

/** The control surface the stand-ins expose on `window.__speech` and `window.__synth`. */
export interface SpeechControl {
  instances: number;
  asked: string[];
  lastProcessLocally: boolean | null;
  availability: string;
  deny: boolean;
  neverStarts: boolean;
  installs: number;
  starts: number;
  stops: number;
  aborts: number;
}
export interface SynthControl {
  spoken: { text: string; voice: string | null; lang: string }[];
  cancels: number;
  pauses: number;
  autoStart: boolean;
  voices: { voiceURI: string; name: string; lang: string; localService: boolean }[];
}

/** Adds the speech stand-ins and the object-URL, handoff and visibility instruments. */
export async function installInstruments(page: Page, speech: SpeechScript = {}): Promise<void> {
  await page.addInitScript((options: SpeechScript) => {
    const w = window as unknown as Record<string, unknown>;
    // ---- object URLs: every created URL must be revoked once private views are cleared ----
    const blobs = { created: [] as string[], revoked: [] as string[] };
    w.__blobs = blobs;
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = create(object);
      blobs.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      blobs.revoked.push(url);
      revoke(url);
    };

    // ---- speech recognition ----
    const control = {
      instances: 0,
      asked: [] as string[],
      lastProcessLocally: null as boolean | null,
      availability: options.availability ?? 'available',
      deny: false,
      neverStarts: options.neverStarts === true,
      installs: 0,
      starts: 0,
      stops: 0,
      aborts: 0,
    };
    w.__speech = control;
    type Handler = ((event?: unknown) => void) | null;
    const live: { current: Recorder | null } = { current: null };
    class Recorder {
      lang = '';
      continuous = true;
      interimResults = false;
      onstart: Handler = null;
      onend: Handler = null;
      onerror: Handler = null;
      onresult: Handler = null;
      constructor() {
        control.instances += 1;
        live.current = this;
      }
      start() {
        control.starts += 1;
        if (control.deny) {
          setTimeout(() => this.onerror?.({ error: 'not-allowed' }), 0);
          return;
        }
        if (!control.neverStarts) setTimeout(() => this.onstart?.(), 0);
      }
      stop() {
        control.stops += 1;
        setTimeout(() => this.onend?.(), 0);
      }
      abort() {
        control.aborts += 1;
      }
    }
    let local = false;
    Object.defineProperty(Recorder.prototype, 'processLocally', {
      get: () => local,
      set: (value: boolean) => {
        local = value;
        control.lastProcessLocally = value;
      },
      configurable: true,
    });
    const asRecognizer = Recorder as unknown as {
      available: (o: { langs: string[]; processLocally: boolean }) => Promise<string>;
      install: () => Promise<boolean>;
    };
    asRecognizer.available = (o) => {
      control.asked.push(JSON.stringify(o));
      return Promise.resolve(control.availability);
    };
    asRecognizer.install = () => {
      control.installs += 1;
      control.availability = 'available';
      return Promise.resolve(true);
    };
    if (options.recognition !== false) w.SpeechRecognition = Recorder;
    else
      // A browser without the API. (The real headless Chromium object must never be reached: its
      // available() call crashes the renderer here, see docs/system-validation/findings.json.)
      for (const key of ['SpeechRecognition', 'webkitSpeechRecognition'])
        Object.defineProperty(window, key, { value: undefined, configurable: true });
    /** Delivers results to the newest recognizer, as the engine would. */
    w.__speechEmit = (items: { isFinal: boolean; text: string }[]) => {
      live.current?.onresult?.({
        resultIndex: 0,
        results: items.map((item) => ({ isFinal: item.isFinal, 0: { transcript: item.text } })),
      });
    };
    /** The engine ends the session by itself (silence, timeout, loss). */
    w.__speechEnd = () => live.current?.onend?.();
    w.__speechError = (error: string) => live.current?.onerror?.({ error });

    // ---- speech synthesis ----
    const synth = {
      spoken: [] as { text: string; voice: string | null; lang: string }[],
      cancels: 0,
      pauses: 0,
      autoStart: true,
      voices: [
        { voiceURI: 'local-1', name: 'Local British', lang: 'en-GB', localService: true },
        { voiceURI: 'local-2', name: 'Local Second', lang: 'en-GB', localService: true },
        { voiceURI: 'cloud-1', name: 'Cloud Voice', lang: 'en-GB', localService: false },
      ],
    };
    w.__synth = synth;
    const listeners = new Set<() => void>();
    let utterance: { onstart?: Handler; onend?: Handler; onerror?: Handler } | null = null;
    const engine = {
      getVoices: () => synth.voices,
      addEventListener: (type: string, fn: () => void) => {
        if (type === 'voiceschanged') listeners.add(fn);
      },
      removeEventListener: (type: string, fn: () => void) => {
        if (type === 'voiceschanged') listeners.delete(fn);
      },
      speak: (
        u: { text: string; voice?: { voiceURI: string }; lang: string } & typeof utterance,
      ) => {
        synth.spoken.push({ text: u.text, voice: u.voice?.voiceURI ?? null, lang: u.lang });
        utterance = u;
        if (synth.autoStart) setTimeout(() => u.onstart?.(), 0);
      },
      cancel: () => {
        synth.cancels += 1;
      },
      pause: () => {
        synth.pauses += 1;
      },
      resume: () => undefined,
    };
    if (options.synthesis === false)
      Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
    if (options.synthesis !== false) {
      Object.defineProperty(window, 'speechSynthesis', { value: engine, configurable: true });
      w.SpeechSynthesisUtterance = class {
        text: string;
        lang = '';
        voice: unknown = null;
        onstart: Handler = null;
        onend: Handler = null;
        onerror: Handler = null;
        constructor(text: string) {
          this.text = text;
        }
      };
    }
    /** The voice list changed (a language pack removed, a voice uninstalled). */
    w.__synthSetVoices = (voices: SynthControl['voices']) => {
      synth.voices = voices;
      for (const fn of listeners) fn();
    };
    w.__synthStart = () => utterance?.onstart?.();
    w.__synthEnd = () => utterance?.onend?.();
    w.__synthError = (error: string) => utterance?.onerror?.({ error });

    // ---- the run stream: hold, release or cut it, as a slow or dropping transport would ----
    const stream = {
      hold: false,
      delivered: 0,
      queue: [] as { value?: Uint8Array; done?: boolean; error?: unknown }[],
      flush: () => {},
      release() {
        stream.hold = false;
        stream.flush();
      },
      cut: () => {},
    };
    w.__stream = stream;
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await realFetch(input, init);
      const target =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
      const path = new URL(target, location.href).pathname;
      if (
        path !== '/api/assistant/runs' ||
        (init?.method ?? 'GET') !== 'POST' ||
        response.body === null
      )
        return response;
      const reader = response.body.getReader();
      let sink: ReadableStreamDefaultController<Uint8Array> | null = null;
      let cutOff = false;
      stream.flush = () => {
        while (!stream.hold && stream.queue.length > 0 && sink !== null && !cutOff) {
          const item = stream.queue.shift();
          if (item === undefined) break;
          try {
            if (item.error !== undefined) sink.error(item.error);
            else if (item.done === true) sink.close();
            else if (item.value !== undefined) {
              sink.enqueue(item.value);
              stream.delivered += 1;
            }
          } catch {
            // the consumer already closed its side
          }
        }
      };
      stream.cut = () => {
        cutOff = true;
        stream.queue.length = 0;
        try {
          sink?.error(new TypeError('network error'));
        } catch {
          // already closed
        }
      };
      const pump = async () => {
        for (;;) {
          try {
            const { done, value } = await reader.read();
            stream.queue.push(done ? { done: true } : { value });
            stream.flush();
            if (done) return;
          } catch (error) {
            stream.queue.push({ error });
            stream.flush();
            return;
          }
        }
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          sink = controller;
          void pump();
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };

    // ---- cross-document handoffs and lifecycle events seen by the page ----
    const events: string[] = [];
    w.__lifecycle = events;
    for (const type of ['pagehide', 'pageshow', 'freeze', 'resume'])
      window.addEventListener(type, (event) => {
        const persisted = (event as PageTransitionEvent).persisted;
        // Whether private text was still on screen at the instant of the event, before the
        // application's own listeners for the same event ran (this one is registered first).
        const priv = /24,000|discrepancy-2000|Scripted test/.test(document.body.innerText);
        events.push(`${type}:${String(persisted)}:private=${String(priv)}`);
      });
  }, speech);
}

export interface StreamControl {
  hold: boolean;
  delivered: number;
  release(): void;
  cut(): void;
}

export const control = {
  stream: (page: Page) => ({
    hold: (value: boolean) =>
      page.evaluate((hold) => {
        (window as unknown as { __stream: StreamControl }).__stream.hold = hold;
      }, value),
    release: () =>
      page.evaluate(() => (window as unknown as { __stream: StreamControl }).__stream.release()),
    cut: () =>
      page.evaluate(() => (window as unknown as { __stream: StreamControl }).__stream.cut()),
    delivered: () =>
      page.evaluate(() => (window as unknown as { __stream: StreamControl }).__stream.delivered),
  }),
  speech: (page: Page) =>
    page.evaluate(() => (window as unknown as { __speech: SpeechControl }).__speech),
  synth: (page: Page) =>
    page.evaluate(() => (window as unknown as { __synth: SynthControl }).__synth),
  blobs: (page: Page) =>
    page.evaluate(
      () => (window as unknown as { __blobs: { created: string[]; revoked: string[] } }).__blobs,
    ),
};

/** Types into the Aegis composer exactly as a person would and presses Enter. */
export async function typeToAegis(page: Page, text: string): Promise<void> {
  await page.getByTestId('aegis-input').click();
  await page.getByTestId('aegis-input').fill(text);
  await page.keyboard.press('Enter');
}

/** Selects the synthetic payment total and starts a request the scripted provider holds open. */
export async function startSlowRun(page: Page, providerRequests: () => number): Promise<void> {
  const before = providerRequests();
  if (!(await selectQuote(page, '24,000'))) throw new Error('no text to select');
  await typeToAegis(page, 'SLOW-TEST explain this clause');
  await page.getByTestId('disclosure-preview').waitFor({ timeout: 15_000 });
  await page.getByTestId('disclosure-send').click();
  const deadline = Date.now() + 20_000;
  while (providerRequests() <= before) {
    if (Date.now() > deadline) throw new Error('the provider never received the request');
    await page.waitForTimeout(100);
  }
}

/** Strings that exist only in private panes: source text, file name, answers. */
export const PRIVATE_MARKERS = [/24,000/, /discrepancy-2000\.pdf/, /Scripted test/];

/** Which private markers are visible in the rendered text right now. */
export async function visiblePrivate(page: Page): Promise<string[]> {
  const text = await page.evaluate(() => document.body.innerText);
  return PRIVATE_MARKERS.filter((marker) => marker.test(text)).map(String);
}

/** A signed-in account with an unlocked vault, a matter and an imported synthetic document. */
export async function preparedSession(
  s: Suite,
  title: string,
  options: { speech?: SpeechScript; clock?: boolean } = {},
): Promise<{ page: Page; address: string }> {
  const { page } = await s.newSession({ clock: options.clock === true });
  await installInstruments(page, options.speech);
  const account = await createAccountAndVault(page, s.app.origin);
  if (s.chain === null) throw new Error('chain');
  await fund(s.chain, account.address, 10n * 10n ** 18n);
  await addMatterAndDocument(page, title);
  return { page, address: account.address };
}

/**
 * Where a pattern is found in this origin's browser storage (local, session, IndexedDB values, Cache
 * API entries), searching text and the bytes of binary values. Ciphertext is expected to be there; a
 * decrypted marker is not.
 */
export async function storageHolds(page: Page, pattern: RegExp): Promise<string[]> {
  return page.evaluate(
    async ([source, flags]) => {
      const re = new RegExp(source, flags);
      const found: string[] = [];
      const look = (where: string, value: unknown) => {
        let text: string;
        try {
          if (typeof value === 'string') text = value;
          else if (value instanceof ArrayBuffer)
            text = new TextDecoder('latin1').decode(new Uint8Array(value));
          else if (ArrayBuffer.isView(value))
            text = new TextDecoder('latin1').decode(
              new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
            );
          // JSON.stringify returns undefined at runtime for undefined and functions.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          else text = JSON.stringify(value) ?? '';
        } catch {
          text = '';
        }
        if (re.test(text)) found.push(where);
      };
      for (const [name, store] of [
        ['localStorage', localStorage],
        ['sessionStorage', sessionStorage],
      ] as const)
        for (let index = 0; index < store.length; index += 1) {
          const key = store.key(index) ?? '';
          look(`${name}:key`, key);
          look(`${name}:${key}`, store.getItem(key));
        }
      for (const info of await indexedDB.databases()) {
        if (info.name === undefined) continue;
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(info.name as string);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
        });
        for (const storeName of Array.from(db.objectStoreNames)) {
          const rows = await new Promise<unknown[]>((resolve, reject) => {
            const request = db.transaction(storeName).objectStore(storeName).getAll();
            request.onsuccess = () => resolve(request.result as unknown[]);
            request.onerror = () => reject(request.error ?? new Error('indexedDB read failed'));
          });
          for (const row of rows) look(`indexedDB:${info.name}/${storeName}`, row);
        }
        db.close();
      }
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          look(`cache:${name}:url`, request.url);
          const response = await cache.match(request);
          if (response !== undefined) look(`cache:${name}:${request.url}`, await response.text());
        }
      }
      return found;
    },
    [pattern.source, pattern.flags] as const,
  );
}
