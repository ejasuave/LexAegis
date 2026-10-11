import { z } from 'zod';
import { CANARY_CLASSES, findCanaries, type CanaryClass } from './canary';

/*
 * The destination-and-field disclosure matrix, and the analyser that applies it to what a journey
 * was observed to write, send, store and log.
 *
 * The matrix is deliberately narrow (it follows the consent and storage rules the application
 * already implements):
 *  - Selected, consent-bound case input may reach the analysis route and the model provider, and
 *    the corresponding result may return to the requesting browser. Only in a journey where the
 *    reviewer pressed Send, and only for what was selected.
 *  - An excerpt travels with its source reference (`lexaegis.source-ref.v1`), which names the
 *    SHA-256 of the source file and of its extraction. Under the same consent those digests may
 *    reach the analysis route and return in its result. They may not reach the model provider.
 *  - The opaque backend session value may live in the cookie jar. Nowhere else.
 *  - A user's action or sign-in signature may travel, transiently, on the authentication and chain
 *    routes. It may not be persisted or logged.
 *  - Everything else in a canary class goes nowhere in plaintext. Ciphertext is opaque, so an
 *    encrypted object holding a canary does not match.
 */

export const DESTINATIONS = [
  'browser.localStorage',
  'browser.sessionStorage',
  'browser.indexedDB',
  'browser.cache',
  'browser.cookie',
  'request.auth',
  'request.vault',
  'request.assistant',
  'request.chain',
  'request.history',
  'request.other',
  'request.outside',
  'request.url',
  'response.api',
  'browser.console',
  'provider.request',
  'server.log',
  'server.database',
  'server.objectStore',
  'server.egress',
] as const;
export type Destination = (typeof DESTINATIONS)[number];

const CONSENTED: ReadonlySet<Destination> = new Set([
  'request.assistant',
  'provider.request',
  'response.api',
]);

/** The digests inside a consented excerpt's source reference: the analysis route, not the provider. */
const SOURCE_REFERENCE: ReadonlySet<Destination> = new Set(['request.assistant', 'response.api']);

/** Where a canary of this class may appear in plaintext. Anything else is a violation. */
export function allowedDestinations(
  canaryClass: CanaryClass,
  journey: { readonly consentedDisclosure: boolean },
): ReadonlySet<Destination> {
  if (canaryClass === 'session_cookie') return new Set<Destination>(['browser.cookie']);
  if (
    (canaryClass === 'selected_text' || canaryClass === 'money_field') &&
    journey.consentedDisclosure
  ) {
    return CONSENTED;
  }
  if (canaryClass === 'artifact_hash' && journey.consentedDisclosure) return SOURCE_REFERENCE;
  return new Set<Destination>();
}

/** A 65-byte secp256k1 signature in hex: allowed to travel on two routes, never to rest. */
const SIGNATURE_SHAPED = /0x[0-9a-fA-F]{130}(?![0-9a-fA-F])/;
const SIGNATURE_ROUTES: ReadonlySet<Destination> = new Set(['request.auth', 'request.chain']);

const storageWriteSchema = z.strictObject({
  kind: z.enum(['localStorage', 'sessionStorage', 'indexedDB', 'cache', 'cookie']),
  key: z.string(),
  value: z.string(),
  phase: z.string(),
});
const snapshotSchema = z.strictObject({
  phase: z.string(),
  localStorage: z.record(z.string(), z.string()),
  sessionStorage: z.record(z.string(), z.string()),
  /** document.cookie as the page sees it (HttpOnly cookies are absent from it by design). */
  documentCookie: z.string(),
  cookies: z.array(z.looseObject({ name: z.string(), value: z.string(), httpOnly: z.boolean() })),
  /** JSON text of every IndexedDB database, store and record, with CryptoKey objects described. */
  indexedDB: z.string(),
  caches: z.array(z.string()),
  serviceWorkers: z.number(),
});
export const canarySchema = z.strictObject({
  id: z.string(),
  class: z.enum(CANARY_CLASSES),
  kind: z.enum(['text', 'bytes', 'token']),
  value: z.string(),
});

export const observationsSchema = z.strictObject({
  journey: z.string(),
  origin: z.string(),
  /** True only when the reviewer pressed Send on a disclosure preview during this journey. */
  consentedDisclosure: z.boolean(),
  canaries: z.array(canarySchema),
  storageWrites: z.array(storageWriteSchema),
  snapshots: z.array(snapshotSchema),
  requests: z.array(z.strictObject({ method: z.string(), url: z.string(), body: z.string() })),
  responses: z.array(z.strictObject({ url: z.string(), status: z.number(), body: z.string() })),
  providerRequests: z.string(),
  serverLog: z.string(),
  database: z.string(),
  objectStore: z.array(z.strictObject({ name: z.string(), content: z.string() })),
  /** Everything the page and its workers wrote to the browser console. */
  consoleMessages: z.array(z.string()),
  /** Every host:port the application server opened a socket to (egress recorder). */
  serverEgress: z.array(z.string()),
  serverEgressAllowed: z.array(z.string()),
  /** Layers this journey could not observe, stated by the journey itself. */
  unobserved: z.array(z.string()),
});
export type Observations = z.infer<typeof observationsSchema>;

export interface Violation {
  readonly rule:
    | 'CANARY_IN_FORBIDDEN_DESTINATION'
    | 'CRYPTOKEY_PERSISTED'
    | 'SIGNATURE_AT_REST_OR_OFF_ROUTE'
    | 'REQUEST_OUTSIDE_ORIGIN'
    | 'SESSION_COOKIE_READABLE_BY_SCRIPT'
    | 'BROWSER_REQUEST_BLOCKED_BY_POLICY'
    | 'SERVER_EGRESS_NOT_ALLOWED'
    | 'CACHE_OR_SERVICE_WORKER_USED';
  readonly destination: Destination;
  readonly canaryClass: CanaryClass | null;
  readonly canaryId: string | null;
  readonly encoding: string | null;
  /** A key, route or phase. Never a value. */
  readonly where: string;
}

export interface Analysis {
  readonly violations: Violation[];
  /** How many items each layer contributed. A layer with zero items was not observed. */
  readonly coverage: Record<string, number>;
  readonly emptyLayers: string[];
  readonly allowedHits: { destination: Destination; canaryClass: CanaryClass; count: number }[];
}

export function routeOf(url: string, origin: string): Destination {
  if (!url.startsWith(`${origin}/`) && url !== origin) return 'request.outside';
  const path = url.slice(origin.length).split(/[?#]/)[0] ?? '';
  if (path.startsWith('/api/auth/')) return 'request.auth';
  if (path.startsWith('/api/vault/')) return 'request.vault';
  if (path.startsWith('/api/assistant/')) return 'request.assistant';
  if (path.startsWith('/api/chain/')) return 'request.chain';
  if (path.startsWith('/api/history/')) return 'request.history';
  return 'request.other';
}
const pathOnly = (url: string, origin: string): string =>
  url.startsWith(origin)
    ? (url.slice(origin.length).split(/[?#]/)[0] ?? '')
    : url.split('/').slice(0, 3).join('/');

export function analyse(raw: unknown): Analysis {
  const observed = observationsSchema.parse(raw);
  const violations: Violation[] = [];
  const allowed = new Map<string, number>();
  const journey = { consentedDisclosure: observed.consentedDisclosure };

  const scan = (
    destination: Destination,
    text: string,
    where: string,
    canaries = observed.canaries,
  ) => {
    if (text === '') return;
    for (const hit of findCanaries(text, canaries)) {
      if (allowedDestinations(hit.class, journey).has(destination)) {
        const key = `${destination}|${hit.class}`;
        allowed.set(key, (allowed.get(key) ?? 0) + 1);
        continue;
      }
      violations.push({
        rule: 'CANARY_IN_FORBIDDEN_DESTINATION',
        destination,
        canaryClass: hit.class,
        canaryId: hit.id,
        encoding: hit.encoding,
        where,
      });
    }
    if (SIGNATURE_SHAPED.test(text) && !SIGNATURE_ROUTES.has(destination)) {
      violations.push({
        rule: 'SIGNATURE_AT_REST_OR_OFF_ROUTE',
        destination,
        canaryClass: null,
        canaryId: null,
        encoding: 'hex-65-bytes',
        where,
      });
    }
  };
  const cryptoKey = (destination: Destination, text: string, where: string) => {
    if (text.includes('"__cryptoKey":true')) {
      violations.push({
        rule: 'CRYPTOKEY_PERSISTED',
        destination,
        canaryClass: null,
        canaryId: null,
        encoding: null,
        where,
      });
    }
  };
  const storeOf = (kind: string): Destination =>
    kind === 'localStorage'
      ? 'browser.localStorage'
      : kind === 'sessionStorage'
        ? 'browser.sessionStorage'
        : kind === 'indexedDB'
          ? 'browser.indexedDB'
          : kind === 'cache'
            ? 'browser.cache'
            : 'browser.cookie';

  // ---- Browser persistence: every intercepted write (a write-then-delete is still a write)...
  for (const write of observed.storageWrites) {
    const destination = storeOf(write.kind);
    const where = `${write.kind} write "${write.key.slice(0, 80)}" during ${write.phase}`;
    scan(destination, `${write.key}\n${write.value}`, where);
    cryptoKey(destination, write.value, where);
    if (write.kind === 'cache') {
      violations.push({
        rule: 'CACHE_OR_SERVICE_WORKER_USED',
        destination,
        canaryClass: null,
        canaryId: null,
        encoding: null,
        where,
      });
    }
  }
  // ...and every snapshot.
  const sessionCanaries = observed.canaries.filter((canary) => canary.class === 'session_cookie');
  for (const snapshot of observed.snapshots) {
    const at = `at ${snapshot.phase}`;
    for (const [key, value] of Object.entries(snapshot.localStorage)) {
      scan('browser.localStorage', `${key}\n${value}`, `localStorage "${key.slice(0, 80)}" ${at}`);
    }
    for (const [key, value] of Object.entries(snapshot.sessionStorage)) {
      scan(
        'browser.sessionStorage',
        `${key}\n${value}`,
        `sessionStorage "${key.slice(0, 80)}" ${at}`,
      );
    }
    scan('browser.indexedDB', snapshot.indexedDB, `IndexedDB ${at}`);
    cryptoKey('browser.indexedDB', snapshot.indexedDB, `IndexedDB ${at}`);
    for (const cookie of snapshot.cookies) {
      scan('browser.cookie', `${cookie.name}=${cookie.value}`, `cookie "${cookie.name}" ${at}`);
    }
    // The session value belongs in an HttpOnly cookie: page script must not be able to read it.
    if (findCanaries(snapshot.documentCookie, sessionCanaries).length > 0) {
      violations.push({
        rule: 'SESSION_COOKIE_READABLE_BY_SCRIPT',
        destination: 'browser.cookie',
        canaryClass: 'session_cookie',
        canaryId: sessionCanaries[0]?.id ?? null,
        encoding: null,
        where: `document.cookie ${at}`,
      });
    }
    scan(
      'browser.cookie',
      snapshot.documentCookie,
      `document.cookie ${at}`,
      observed.canaries.filter((canary) => canary.class !== 'session_cookie'),
    );
    if (snapshot.caches.length > 0 || snapshot.serviceWorkers > 0) {
      violations.push({
        rule: 'CACHE_OR_SERVICE_WORKER_USED',
        destination: 'browser.cache',
        canaryClass: null,
        canaryId: null,
        encoding: null,
        where: `caches or service workers ${at}`,
      });
    }
  }

  // ---- Browser network: destination by route, plus every URL on its own.
  for (const request of observed.requests) {
    const destination = routeOf(request.url, observed.origin);
    const where = `${request.method} ${pathOnly(request.url, observed.origin)}`;
    if (destination === 'request.outside') {
      violations.push({
        rule: 'REQUEST_OUTSIDE_ORIGIN',
        destination,
        canaryClass: null,
        canaryId: null,
        encoding: null,
        where,
      });
    }
    scan(destination, request.body, `${where} body`);
    // A URL reaches history, referrers and access logs: nothing private belongs in one, on any route.
    let decoded = request.url;
    try {
      decoded = decodeURIComponent(request.url);
    } catch {
      // Keep the raw URL.
    }
    scan('request.url', `${request.url}\n${decoded}`, `${where} URL`);
  }
  for (const response of observed.responses) {
    scan('response.api', response.body, `response of ${pathOnly(response.url, observed.origin)}`);
  }

  // ---- The browser console is a log too. A blocked request shows that code TRIED to reach out.
  for (const [index, message] of observed.consoleMessages.entries()) {
    scan('browser.console', message, `browser console message ${String(index + 1)}`);
    if (/Content Security Policy|Refused to (?:connect|load|send|frame|create)/i.test(message)) {
      violations.push({
        rule: 'BROWSER_REQUEST_BLOCKED_BY_POLICY',
        destination: 'request.outside',
        canaryClass: null,
        canaryId: null,
        encoding: null,
        where: `browser console message ${String(index + 1)}: ${(/(?:https?|wss?):\/\/[a-z0-9.:[\]-]+/i.exec(message)?.[0] ?? 'a destination outside the policy').slice(0, 80)}`,
      });
    }
  }

  // ---- What the SERVER contacted. Only the journey's own database, object store and provider.
  const egressAllowed = new Set(observed.serverEgressAllowed);
  for (const destination of observed.serverEgress) {
    if (!egressAllowed.has(destination)) {
      violations.push({
        rule: 'SERVER_EGRESS_NOT_ALLOWED',
        destination: 'server.egress',
        canaryClass: null,
        canaryId: null,
        encoding: null,
        where: `server opened a socket to ${destination.slice(0, 80)}`,
      });
    }
  }

  // ---- Server side: what reached the model provider, the log, the database and the object store.
  scan('provider.request', observed.providerRequests, 'requests received by the provider');
  scan('server.log', observed.serverLog, 'application and server log');
  scan('server.database', observed.database, 'database rows');
  for (const object of observed.objectStore) {
    scan('server.objectStore', object.content, `stored object ${object.name.slice(0, 60)}`);
  }

  const coverage = {
    canaries: observed.canaries.length,
    storageWrites: observed.storageWrites.length,
    snapshots: observed.snapshots.length,
    requests: observed.requests.length,
    responses: observed.responses.length,
    providerRequestBytes: observed.providerRequests.length,
    serverLogBytes: observed.serverLog.length,
    databaseBytes: observed.database.length,
    storedObjects: observed.objectStore.length,
    consoleMessages: observed.consoleMessages.length,
    serverEgressDestinations: observed.serverEgress.length,
  };
  return {
    violations,
    coverage,
    emptyLayers: Object.entries(coverage)
      .filter(([, count]) => count === 0)
      .map(([layer]) => layer),
    allowedHits: [...allowed].map(([key, count]) => {
      const [destination, canaryClass] = key.split('|') as [Destination, CanaryClass];
      return { destination, canaryClass, count };
    }),
  };
}
