import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { HDKey } from '@scure/bip32';
import type { Pool } from 'pg';
import type { BrowserContext, Page, Request, Response } from 'playwright';
import type { Observations } from './analyse';
import type { Canary } from './canary';
import { within } from './run-bounded';

/*
 * TEST-ONLY observation layer for the scripted browser journeys. It is attached only when
 * PRIVACY_OBSERVE_DIR is set (by `pnpm test:privacy:browser`); otherwise the journeys run exactly
 * as before. It observes a test-owned browser profile, virtual authenticator, database and bucket.
 *
 *  - Storage WRITES are intercepted in the page (localStorage, sessionStorage, IndexedDB put/add,
 *    Cache.put, document.cookie), so a value written and deleted again is still seen.
 *  - Storage SNAPSHOTS are taken at named phases, with CryptoKey objects described, not skipped.
 *  - Every request the context makes (pages and their workers) is recorded with its body, and
 *    every API response with its body ONCE ITS REQUEST HAS FINISHED. A response whose request
 *    never finishes (an event stream cut off by Stop, by lock or by a navigation) has no complete
 *    body to read: it is listed as unobserved, never waited on.
 *  - The PRF results of the VIRTUAL authenticator are captured as canary values, and the signing
 *    key the application derives from them is re-derived here, so the checks know exactly which
 *    bytes must never be written, sent or logged. These values exist only in this process and in
 *    the temporary observation file, which the privacy check deletes after analysis.
 *
 * Not observed: writes made inside a worker (snapshots still see what persisted), memory, and
 * anything outside this machine (a real provider's or host's logs).
 */

const EVM_PATH = "m/44'/60'/0'/0/0";

/** How long one finished response may take to hand over its body. */
const BODY_READ_MS = 5_000;
/** How long one storage snapshot may take. `page.evaluate` has no timeout of its own. */
const SNAPSHOT_MS = 15_000;

/** `POST /api/assistant/runs`: a method and a path, with identifiers and the query removed. */
function routeLabel(method: string, url: string, origin: string): string {
  const path = url.startsWith(origin) ? url.slice(origin.length) : url;
  return `${method} ${(path.split(/[?#]/)[0] ?? '')
    .replace(/0x[0-9a-f]{40,64}/gi, '0x…')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<id>')}`.slice(0, 120);
}

/**
 * Preloaded into the journey's application server (NODE_OPTIONS=--require) while it is observed.
 * It records the destination (host and port) of every outbound socket the server process opens,
 * so the check can tell what the SERVER contacted: browser interception alone cannot. It records
 * no content and changes no behaviour. Written to the temporary observation directory at run time.
 */
const EGRESS_RECORDER = `
const fs = require('node:fs');
const net = require('node:net');

const file = process.env.PRIVACY_EGRESS_LOG;
if (file) {
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function connect(...args) {
    try {
      // Node normalises (options, callback) into a one-element array for internal callers.
      let options = args[0];
      if (Array.isArray(options)) options = options[0];
      let host = 'localhost';
      let port = '';
      if (options !== null && typeof options === 'object') {
        host = options.path ? \`unix:\${options.path}\` : options.host || 'localhost';
        port = options.port === undefined ? '' : String(options.port);
      } else if (typeof options === 'number' || /^\\d+$/.test(String(options))) {
        port = String(options);
        if (typeof args[1] === 'string') host = args[1];
      } else if (typeof options === 'string') {
        host = \`unix:\${options}\`;
      }
      fs.appendFileSync(file, \`\${host}:\${port}\\n\`);
    } catch {
      // Recording must never break the server.
    }
    return original.apply(this, args);
  };
}
`;

const INIT_SCRIPT = `
(() => {
  if (window.__privacySpyInstalled) return;
  window.__privacySpyInstalled = true;
  const hex = (view) => Array.from(new Uint8Array(view.buffer ? view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) : view), (b) => b.toString(16).padStart(2, '0')).join('');
  const describe = (value, depth) => {
    if (typeof CryptoKey !== 'undefined' && value instanceof CryptoKey) {
      return { __cryptoKey: true, type: value.type, extractable: value.extractable, algorithm: value.algorithm && value.algorithm.name, usages: Array.from(value.usages || []) };
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return { __bytesHex: hex(value) };
    if (Array.isArray(value)) return depth > 8 ? '[deep]' : value.map((item) => describe(item, depth + 1));
    if (value && typeof value === 'object') {
      if (depth > 8) return '[deep]';
      const out = {};
      for (const key of Object.keys(value)) out[key] = describe(value[key], depth + 1);
      return out;
    }
    return value;
  };
  window.__privacyDescribe = describe;
  const report = (kind, key, value) => {
    try { window.__privacyReport(JSON.stringify({ kind, key: String(key).slice(0, 300), value: String(value).slice(0, 400000) })); } catch (error) { /* the binding is not ready yet */ }
  };
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    report(this === window.sessionStorage ? 'sessionStorage' : 'localStorage', key, value);
    return setItem.apply(this, arguments);
  };
  const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (cookie && cookie.set) {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get() { return cookie.get.call(document); },
      set(value) { report('cookie', 'document.cookie', value); cookie.set.call(document, value); },
    });
  }
  for (const method of ['put', 'add']) {
    const original = IDBObjectStore.prototype[method];
    IDBObjectStore.prototype[method] = function (value, key) {
      let text = '';
      try { text = JSON.stringify(describe(value, 0)); } catch (error) { text = '[unserialisable]'; }
      report('indexedDB', this.transaction.db.name + '/' + this.name + (key === undefined ? '' : '/' + String(key)), text);
      return original.apply(this, arguments);
    };
  }
  if (typeof Cache !== 'undefined') {
    const put = Cache.prototype.put;
    Cache.prototype.put = function (request, response) {
      const url = typeof request === 'string' ? request : request.url;
      // The stored body is read from a clone, so the write itself is untouched.
      try { response.clone().text().then((text) => report('cache', url, text), () => report('cache', url, '')); } catch (error) { report('cache', url, ''); }
      return put.apply(this, arguments);
    };
  }
  // The virtual authenticator's PRF results: canary values for the checks, reported to the test
  // process only. The application receives the same, untouched result.
  if (typeof PublicKeyCredential !== 'undefined') {
    const results = PublicKeyCredential.prototype.getClientExtensionResults;
    PublicKeyCredential.prototype.getClientExtensionResults = function () {
      const value = results.apply(this, arguments);
      try {
        const prf = value && value.prf && value.prf.results;
        for (const name of ['first', 'second']) {
          if (prf && prf[name]) window.__privacyReport(JSON.stringify({ kind: '__prf', key: name, value: hex(prf[name]) }));
        }
      } catch (error) { /* nothing to capture */ }
      return value;
    };
  }
})();
`;

const SNAPSHOT = `
(async () => {
  const describe = window.__privacyDescribe || ((value) => value);
  const entries = (storage) => { const out = {}; for (let i = 0; i < storage.length; i += 1) { const key = storage.key(i); out[key] = storage.getItem(key); } return out; };
  const databases = [];
  const list = indexedDB.databases ? await indexedDB.databases() : [];
  for (const info of list) {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open(info.name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('IndexedDB open was blocked: ' + info.name)); });
    const stores = {};
    for (const name of Array.from(db.objectStoreNames)) {
      const tx = db.transaction(name, 'readonly');
      const store = tx.objectStore(name);
      const all = (request) => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const keys = await all(store.getAllKeys());
      const values = await all(store.getAll());
      stores[name] = keys.map((key, index) => ({ key: describe(key, 0), value: describe(values[index], 0) }));
    }
    db.close();
    databases.push({ name: info.name, version: info.version, stores });
  }
  const cacheNames = typeof caches === 'undefined' ? [] : await caches.keys();
  const cached = [];
  for (const name of cacheNames) { const cache = await caches.open(name); for (const request of await cache.keys()) cached.push(name + ' ' + request.url); }
  const workers = navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 0;
  return { localStorage: entries(localStorage), sessionStorage: entries(sessionStorage), documentCookie: document.cookie, indexedDB: JSON.stringify(databases), caches: cached, serviceWorkers: workers };
})()
`;

/** The server's stdout and stderr go to a file while a journey is observed. */
export interface PrivacyServerLog {
  readonly path: string;
  readonly stdio: ['ignore', number, number];
  /** Extra environment for the server: loads the egress recorder into it. */
  readonly env: Record<string, string>;
  /** Where the recorder lists every outbound destination the server opened. */
  readonly egressPath: string;
  close(): void;
}

/** Null unless PRIVACY_OBSERVE_DIR is set: the journey then keeps its usual `stdio: 'ignore'`. */
export function openPrivacyServerLog(journey: string): PrivacyServerLog | null {
  const base = process.env.PRIVACY_OBSERVE_DIR;
  if (base === undefined || base === '') return null;
  const directory = join(base, journey);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'server.log');
  const egressPath = join(directory, 'egress.log');
  writeFileSync(egressPath, '');
  const fd = openSync(path, 'a');
  const recorder = join(directory, 'egress-recorder.cjs');
  writeFileSync(recorder, EGRESS_RECORDER);
  return {
    path,
    stdio: ['ignore', fd, fd],
    env: {
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${recorder}`.trim(),
      PRIVACY_EGRESS_LOG: egressPath,
    },
    egressPath,
    close: () => closeSync(fd),
  };
}

export interface PrivacyObserver {
  /** Registers a value the journey planted (a title, a file name, document text...). */
  canary(canary: Canary): void;
  /** Names the current phase and snapshots every browser store. */
  phase(page: Page, name: string): Promise<void>;
  finish(extra: {
    readonly consentedDisclosure: boolean;
    readonly providerRequests: unknown;
    readonly pool: Pool;
    readonly objectStoreRoot: string | null;
    /** Every host:port the server is expected to contact (database, object store, provider). */
    readonly serverEgressAllowed: readonly string[];
    readonly unobserved?: readonly string[];
  }): Promise<void>;
}

/** Every row of every application table, as JSON text (byte columns appear as number arrays). */
export async function dumpDatabase(pool: Pool): Promise<string> {
  const tables = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  const out: Record<string, unknown[]> = {};
  for (const { table_name: table } of tables.rows) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) continue;
    out[table] = (await pool.query(`SELECT * FROM "${table}" LIMIT 5000`)).rows;
  }
  return JSON.stringify(out);
}

function readTree(root: string): { name: string; content: string }[] {
  const out: { name: string; content: string }[] = [];
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && statSync(path).size <= 8 * 1024 * 1024) {
        // latin1 keeps every byte, so an ASCII canary inside binary content is still found.
        out.push({ name: relative(root, path), content: readFileSync(path).toString('latin1') });
      }
    }
  };
  walk(root);
  return out;
}

export async function attachPrivacyObserver(
  context: BrowserContext,
  options: {
    readonly journey: string;
    readonly origin: string;
    readonly serverLog: PrivacyServerLog | null;
  },
): Promise<PrivacyObserver | null> {
  const base = process.env.PRIVACY_OBSERVE_DIR;
  if (base === undefined || base === '' || options.serverLog === null) return null;
  const directory = join(base, options.journey);
  mkdirSync(directory, { recursive: true });
  const serverLog = options.serverLog;

  let phase = 'start';
  const canaries: Canary[] = [];
  const storageWrites: Observations['storageWrites'] = [];
  const snapshots: Observations['snapshots'] = [];
  const requests: Observations['requests'] = [];
  const responses: Observations['responses'] = [];
  const consoleMessages: string[] = [];
  const pending: Promise<void>[] = [];
  /** API responses whose request has neither finished nor failed yet. */
  const inFlight = new Map<Request, Response>();
  /** Route and reason -> how many response bodies could not be read. Never a body. */
  const unreadResponses = new Map<string, number>();
  let prfCount = 0;

  await context.exposeBinding('__privacyReport', (_source, payload: string) => {
    const item = JSON.parse(payload) as { kind: string; key: string; value: string };
    if (item.kind === '__prf') {
      if (
        !/^[0-9a-f]{64}$/.test(item.value) ||
        canaries.some((canary) => canary.value === item.value)
      )
        return;
      prfCount += 1;
      canaries.push({
        id: `prf-output-${String(prfCount)}`,
        class: 'prf_output',
        kind: 'bytes',
        value: item.value,
      });
      // The application derives its signing key from a PRF output along this path.
      const seed = Uint8Array.from(item.value.match(/../g) ?? [], (pair) => parseInt(pair, 16));
      const key = HDKey.fromMasterSeed(seed).derive(EVM_PATH).privateKey;
      if (key !== null) {
        canaries.push({
          id: `signing-key-from-prf-${String(prfCount)}`,
          class: 'signing_key',
          kind: 'bytes',
          value: Buffer.from(key).toString('hex'),
        });
      }
      return;
    }
    storageWrites.push({
      kind: item.kind as Observations['storageWrites'][number]['kind'],
      key: item.key,
      value: item.value,
      phase,
    });
  });
  await context.addInitScript(INIT_SCRIPT);
  context.on('request', (request) => {
    if (request.url().startsWith('data:') || request.url().startsWith('blob:')) return;
    requests.push({
      method: request.method(),
      url: request.url(),
      body: (request.postDataBuffer() ?? Buffer.alloc(0)).toString('utf8').slice(0, 2_000_000),
    });
  });
  context.on('console', (message) => {
    consoleMessages.push(`[${message.type()}] ${message.text()}`.slice(0, 4000));
  });
  // Reading a body waits for the request to finish. An event stream that is cut off never
  // finishes, so a body is asked for only after `requestfinished`, and even then for a bounded
  // time. (Asking at `response` time and awaiting every read made the first observed run hang.)
  const unread = (response: Response, reason: string) => {
    const label = `${routeLabel(response.request().method(), response.url(), options.origin)}: ${reason}`;
    unreadResponses.set(label, (unreadResponses.get(label) ?? 0) + 1);
  };
  context.on('response', (response) => {
    if (response.url().includes('/api/')) inFlight.set(response.request(), response);
  });
  context.on('requestfinished', (request) => {
    const response = inFlight.get(request);
    if (response === undefined) return;
    inFlight.delete(request);
    pending.push(
      within(
        response.text().then(
          (body) => {
            responses.push({
              url: response.url(),
              status: response.status(),
              body: body.slice(0, 2_000_000),
            });
            return true;
          },
          () => false,
        ),
        BODY_READ_MS,
        false,
      ).then((read) => {
        if (!read) unread(response, 'the finished response gave no body');
      }),
    );
  });
  context.on('requestfailed', (request) => {
    const response = inFlight.get(request);
    if (response === undefined) return;
    inFlight.delete(request);
    unread(response, 'the request was cut off before its body was complete');
  });

  return {
    canary(canary) {
      if (!canaries.some((item) => item.id === canary.id)) canaries.push(canary);
    },
    async phase(page, name) {
      phase = name;
      const stores = await within(
        page.evaluate<Omit<Observations['snapshots'][number], 'phase' | 'cookies'>>(SNAPSHOT),
        SNAPSHOT_MS,
        null,
      );
      // A missing snapshot is a missing observation layer: the journey fails, it does not wait.
      if (stores === null) {
        throw new Error(
          `privacy snapshot "${name}" did not return within ${String(SNAPSHOT_MS / 1000)} s`,
        );
      }
      const cookies = (await context.cookies()).map(({ name: cookieName, value, httpOnly }) => ({
        name: cookieName,
        value,
        httpOnly,
      }));
      snapshots.push({ phase: name, ...stores, cookies });
    },
    async finish(extra) {
      // Every entry is already bounded by BODY_READ_MS, so this cannot wait for ever.
      await Promise.all(pending);
      for (const response of inFlight.values()) {
        unread(response, 'the request had not finished when the journey ended');
      }
      inFlight.clear();
      // The opaque backend session value: allowed in the HttpOnly cookie jar and nowhere else.
      for (const cookie of await context.cookies()) {
        if (cookie.httpOnly && cookie.value.length >= 16) {
          canaries.push({
            id: `session-cookie-${cookie.name}`,
            class: 'session_cookie',
            kind: 'text',
            value: cookie.value,
          });
        }
      }
      serverLog.close();
      const observations: Observations = {
        journey: options.journey,
        origin: options.origin,
        consentedDisclosure: extra.consentedDisclosure,
        canaries,
        storageWrites,
        snapshots,
        requests,
        responses,
        providerRequests: JSON.stringify(extra.providerRequests),
        serverLog: readFileSync(serverLog.path, 'utf8'),
        database: await dumpDatabase(extra.pool),
        objectStore: extra.objectStoreRoot === null ? [] : readTree(extra.objectStoreRoot),
        consoleMessages,
        serverEgress: [
          ...new Set(
            readFileSync(serverLog.egressPath, 'utf8')
              .split('\n')
              .filter((line) => line !== ''),
          ),
        ].sort(),
        serverEgressAllowed: [...extra.serverEgressAllowed],
        unobserved: [
          ...(extra.unobserved ?? []),
          ...[...unreadResponses]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(
              ([label, count]) =>
                `response body of ${label} (${String(count)} response${count === 1 ? '' : 's'})`,
            ),
        ],
      };
      writeFileSync(join(directory, 'observations.json'), JSON.stringify(observations));
    },
  };
}
