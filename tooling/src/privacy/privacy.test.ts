import { describe, expect, it } from 'vitest';
import { allowedDestinations, analyse, routeOf } from './analyse';
import { base64Cores, findCanaries, needles } from './canary';
import { CANARIES, ORIGIN, canary, cleanObservations } from './test-observations';

const rules = (raw: unknown) =>
  analyse(raw).violations.map(
    (violation) => `${violation.rule}:${violation.destination}:${violation.canaryId ?? '-'}`,
  );
const bytesOf = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));

describe('canary encodings', () => {
  it('finds a byte secret as hex, base64 at any alignment, base64url and a decimal array', () => {
    const prf = canary('prf');
    const raw = bytesOf(prf.value);
    const find = (text: string) => findCanaries(text, [prf]).map((hit) => hit.encoding);
    expect(find(`key=${prf.value.toUpperCase()}`)).toEqual(['hex']);
    expect(find(Buffer.from(raw).toString('base64'))).toContain('base64');
    for (const lead of [1, 2, 3, 4]) {
      const embedded = Buffer.concat([
        Buffer.alloc(lead, 7),
        Buffer.from(raw),
        Buffer.from('tail'),
      ]);
      expect(find(embedded.toString('base64')), `lead ${String(lead)}`).toContain('base64');
      expect(find(embedded.toString('base64url'))).toHaveLength(1);
    }
    expect(find(JSON.stringify(Array.from(raw)))).toEqual(['decimal-array']);
    expect(find('nothing here 000102')).toEqual([]);
    expect(base64Cores(raw)).toHaveLength(3);
  });
  it('finds text in plain, escaped, URL-encoded, hex and base64 forms, whatever its case', () => {
    const note = canary('note');
    const find = (text: string) => findCanaries(text, [note]).map((hit) => hit.encoding);
    expect(find(`x ${note.value.toUpperCase()} y`)).toContain('plain');
    expect(find(JSON.stringify({ reason: note.value }))).toEqual(['json-escaped']);
    expect(find(`/x?reason=${encodeURIComponent(note.value)}`)).toEqual(['url-encoded']);
    expect(find(Buffer.from(`prefix ${note.value}`).toString('base64'))).toContain('base64');
    expect(find(Buffer.from(note.value).toString('hex'))).toContain('utf8-hex');
    expect(needles(note).length).toBeGreaterThan(5);
  });
  it('matches an amount only as a whole value, not inside another number or identifier', () => {
    const amount = canary('amount');
    const hit = (text: string) => findCanaries(text, [amount]).length > 0;
    expect(hit('{"totalMinor":"2400000"}')).toBe(true);
    expect(hit('total=2400000;')).toBe(true);
    expect(hit('block 12400000')).toBe(false);
    expect(hit('24000001')).toBe(false);
    expect(hit('0x2400000a')).toBe(false);
  });
});

describe('disclosure matrix', () => {
  it('allows selected input on the analysis route and at the provider only after consent', () => {
    expect([...allowedDestinations('selected_text', { consentedDisclosure: true })].sort()).toEqual(
      ['provider.request', 'request.assistant', 'response.api'],
    );
    expect(allowedDestinations('selected_text', { consentedDisclosure: false }).size).toBe(0);
    expect(
      allowedDestinations('money_field', { consentedDisclosure: true }).has('provider.request'),
    ).toBe(true);
    expect([...allowedDestinations('session_cookie', { consentedDisclosure: true })]).toEqual([
      'browser.cookie',
    ]);
    for (const never of [
      'unselected_text',
      'filename',
      'matter_title',
      'reviewer_note',
      'opening_nonce',
      'prf_output',
      'signing_key',
      'signing_session_secret',
      'vault_key',
      'provider_credential',
      'storage_credential',
      'database_credential',
    ] as const) {
      expect(allowedDestinations(never, { consentedDisclosure: true }).size, never).toBe(0);
    }
  });
  it('the digests in an excerpt source reference reach the analysis route only, and only after consent', () => {
    expect([...allowedDestinations('artifact_hash', { consentedDisclosure: true })].sort()).toEqual(
      ['request.assistant', 'response.api'],
    );
    expect(allowedDestinations('artifact_hash', { consentedDisclosure: false }).size).toBe(0);
    const digest = canary('artifact').value;
    const run = (over: Parameters<typeof cleanObservations>[0]) =>
      rules(
        cleanObservations({
          consentedDisclosure: true,
          requests: [
            {
              method: 'POST',
              url: `${ORIGIN}/api/assistant/runs`,
              body: JSON.stringify({ reference: { sourceSha256: `0x${digest}` } }),
            },
          ],
          ...over,
        }),
      );
    expect(run({})).toEqual([]);
    // Without a Send it is a disclosure; and it never belongs at the provider, in a log or at rest.
    expect(run({ consentedDisclosure: false })).toEqual([
      'CANARY_IN_FORBIDDEN_DESTINATION:request.assistant:artifact',
    ]);
    expect(run({ providerRequests: JSON.stringify([{ content: digest }]) })).toEqual([
      'CANARY_IN_FORBIDDEN_DESTINATION:provider.request:artifact',
    ]);
    expect(run({ serverLog: `source ${digest}\n` })).toEqual([
      'CANARY_IN_FORBIDDEN_DESTINATION:server.log:artifact',
    ]);
    expect(run({ database: JSON.stringify([{ source: digest }]) })).toEqual([
      'CANARY_IN_FORBIDDEN_DESTINATION:server.database:artifact',
    ]);
  });
  it('classifies requests by route and anything else as outside', () => {
    expect(routeOf(`${ORIGIN}/api/auth/challenge`, ORIGIN)).toBe('request.auth');
    expect(routeOf(`${ORIGIN}/api/vault/objects/1?x=1`, ORIGIN)).toBe('request.vault');
    expect(routeOf(`${ORIGIN}/api/assistant/runs`, ORIGIN)).toBe('request.assistant');
    expect(routeOf(`${ORIGIN}/api/chain/state/0x1`, ORIGIN)).toBe('request.chain');
    expect(routeOf(`${ORIGIN}/review`, ORIGIN)).toBe('request.other');
    expect(routeOf('https://collector.example.invalid/x', ORIGIN)).toBe('request.outside');
    expect(routeOf(`${ORIGIN}.evil.example/api/auth/x`, ORIGIN)).toBe('request.outside');
  });
});

describe('analysis', () => {
  it('a clean journey has no violation: ciphertext, the HttpOnly session cookie and a sign-in signature are permitted', () => {
    const result = analyse(cleanObservations());
    expect(result.violations).toEqual([]);
    expect(result.emptyLayers).toEqual([]);
    expect(result.allowedHits).toEqual([
      { destination: 'browser.cookie', canaryClass: 'session_cookie', count: 1 },
    ]);
  });
  it('a consented run may carry the selected excerpt to the route and the provider, and nothing unselected', () => {
    const selected = canary('doc-selected').value;
    const consented = cleanObservations({
      consentedDisclosure: true,
      requests: [
        {
          method: 'POST',
          url: `${ORIGIN}/api/assistant/runs`,
          body: JSON.stringify({ excerpt: selected }),
        },
      ],
      providerRequests: JSON.stringify([{ messages: [{ content: selected }] }]),
    });
    expect(rules(consented)).toEqual([]);
    // The same bytes without consent are a disclosure.
    expect(rules({ ...consented, consentedDisclosure: false })).toEqual([
      'CANARY_IN_FORBIDDEN_DESTINATION:request.assistant:doc-selected',
      'CANARY_IN_FORBIDDEN_DESTINATION:provider.request:doc-selected',
    ]);
    // Consent does not widen: an extra unselected field in the same request is still a violation.
    const widened = {
      ...consented,
      requests: [
        {
          method: 'POST',
          url: `${ORIGIN}/api/assistant/runs`,
          body: JSON.stringify({ excerpt: selected, context: canary('doc-unselected').value }),
        },
      ],
    };
    expect(rules(widened)).toEqual([
      'CANARY_IN_FORBIDDEN_DESTINATION:request.assistant:doc-unselected',
    ]);
    // Nor does it reach other routes or storage.
    const elsewhere = {
      ...consented,
      requests: [{ method: 'PUT', url: `${ORIGIN}/api/vault/objects/1`, body: selected }],
    };
    expect(rules(elsewhere)).toEqual([
      'CANARY_IN_FORBIDDEN_DESTINATION:request.vault:doc-selected',
    ]);
  });
  it('reports each secret class in each browser store, including a write that was deleted afterwards', () => {
    for (const kind of ['localStorage', 'sessionStorage', 'indexedDB'] as const) {
      for (const id of ['prf', 'key', 'vault', 'session', 'nonce', 'title']) {
        const value =
          canary(id).kind === 'bytes'
            ? Buffer.from(bytesOf(canary(id).value)).toString('base64')
            : canary(id).value;
        // Present only in the intercepted write: every snapshot is clean (write-then-delete).
        const observed = cleanObservations({
          storageWrites: [
            { kind, key: 'tmp', value: JSON.stringify({ v: value }), phase: 'approval' },
          ],
        });
        const found = analyse(observed).violations;
        expect(
          found.map((violation) => violation.canaryId),
          `${kind} ${id}`,
        ).toEqual([id]);
        expect(found[0]?.where).toContain('during approval');
        expect(JSON.stringify(found)).not.toContain(value);
      }
    }
  });
  it('a CryptoKey in IndexedDB is a violation even when it is non-extractable', () => {
    const stored = JSON.stringify({
      key: { __cryptoKey: true, extractable: false, type: 'secret', algorithm: 'AES-GCM' },
    });
    expect(
      rules(
        cleanObservations({
          storageWrites: [{ kind: 'indexedDB', key: 'keys/vault', value: stored, phase: 'unlock' }],
        }),
      ),
    ).toEqual(['CRYPTOKEY_PERSISTED:browser.indexedDB:-']);
    const snapshot = cleanObservations();
    snapshot.snapshots[0] = {
      ...snapshot.snapshots[0],
      indexedDB: stored,
    } as (typeof snapshot.snapshots)[number];
    expect(rules(snapshot)).toEqual(['CRYPTOKEY_PERSISTED:browser.indexedDB:-']);
  });
  it('a session value outside the cookie jar, or readable by script, is a violation', () => {
    const session = canary('session').value;
    expect(
      rules(
        cleanObservations({
          storageWrites: [{ kind: 'localStorage', key: 's', value: session, phase: 'x' }],
        }),
      ),
    ).toEqual(['CANARY_IN_FORBIDDEN_DESTINATION:browser.localStorage:session']);
    const readable = cleanObservations();
    readable.snapshots[0] = {
      ...readable.snapshots[0],
      documentCookie: `session=${session}`,
    } as (typeof readable.snapshots)[number];
    expect(rules(readable)).toEqual(['SESSION_COOKIE_READABLE_BY_SCRIPT:browser.cookie:session']);
    expect(
      rules(
        cleanObservations({
          requests: [{ method: 'GET', url: `${ORIGIN}/api/history/status?s=${session}`, body: '' }],
        }),
      ),
    ).toEqual(['CANARY_IN_FORBIDDEN_DESTINATION:request.url:session']);
  });
  it('document text, file names, amounts and secrets in the log, database, object store or provider are violations', () => {
    expect(
      rules(cleanObservations({ serverLog: `error reading ${canary('file').value}` })),
    ).toEqual(['CANARY_IN_FORBIDDEN_DESTINATION:server.log:file']);
    expect(rules(cleanObservations({ serverLog: 'payment {"totalMinor":"2400000"}' }))).toEqual([
      'CANARY_IN_FORBIDDEN_DESTINATION:server.log:amount',
    ]);
    expect(rules(cleanObservations({ serverLog: `connect ${canary('database').value}` }))).toEqual([
      'CANARY_IN_FORBIDDEN_DESTINATION:server.log:database',
    ]);
    expect(
      rules(cleanObservations({ database: JSON.stringify([{ title: canary('title').value }]) })),
    ).toEqual(['CANARY_IN_FORBIDDEN_DESTINATION:server.database:title']);
    expect(
      rules(
        cleanObservations({
          objectStore: [{ name: 'o', content: `plain ${canary('doc-unselected').value}` }],
        }),
      ),
    ).toEqual(['CANARY_IN_FORBIDDEN_DESTINATION:server.objectStore:doc-unselected']);
    expect(rules(cleanObservations({ providerRequests: canary('doc-unselected').value }))).toEqual([
      'CANARY_IN_FORBIDDEN_DESTINATION:provider.request:doc-unselected',
    ]);
    expect(
      rules(
        cleanObservations({
          responses: [{ url: `${ORIGIN}/api/health`, status: 200, body: canary('storage').value }],
        }),
      ),
    ).toEqual(['CANARY_IN_FORBIDDEN_DESTINATION:response.api:storage']);
  });
  it('a signature may travel on the sign-in and chain routes, and nowhere else or at rest', () => {
    const signature = `0x${'cd'.repeat(65)}`;
    expect(
      rules(
        cleanObservations({
          requests: [{ method: 'POST', url: `${ORIGIN}/api/chain/operations`, body: signature }],
        }),
      ),
    ).toEqual([]);
    expect(
      rules(
        cleanObservations({
          requests: [{ method: 'POST', url: `${ORIGIN}/api/vault/objects/1`, body: signature }],
        }),
      ),
    ).toEqual(['SIGNATURE_AT_REST_OR_OFF_ROUTE:request.vault:-']);
    expect(rules(cleanObservations({ serverLog: `sig=${signature}` }))).toEqual([
      'SIGNATURE_AT_REST_OR_OFF_ROUTE:server.log:-',
    ]);
    expect(
      rules(
        cleanObservations({
          storageWrites: [
            { kind: 'sessionStorage', key: 'pending', value: signature, phase: 'approval' },
          ],
        }),
      ),
    ).toEqual(['SIGNATURE_AT_REST_OR_OFF_ROUTE:browser.sessionStorage:-']);
    // A 32-byte hash is not a signature.
    expect(rules(cleanObservations({ serverLog: `commitment=0x${'cd'.repeat(32)}` }))).toEqual([]);
  });
  it('a request outside the origin, a cache write and a service worker are violations', () => {
    expect(
      rules(
        cleanObservations({
          requests: [{ method: 'POST', url: 'https://collector.example.invalid/c', body: 'x' }],
        }),
      ),
    ).toEqual(['REQUEST_OUTSIDE_ORIGIN:request.outside:-']);
    expect(
      rules(
        cleanObservations({
          storageWrites: [{ kind: 'cache', key: '/review', value: '', phase: 'x' }],
        }),
      ),
    ).toEqual(['CACHE_OR_SERVICE_WORKER_USED:browser.cache:-']);
    const worker = cleanObservations();
    worker.snapshots[0] = {
      ...worker.snapshots[0],
      serviceWorkers: 1,
    } as (typeof worker.snapshots)[number];
    expect(rules(worker)).toEqual(['CACHE_OR_SERVICE_WORKER_USED:browser.cache:-']);
  });
  it('a server connection to anything but its own database, object store and provider is a violation', () => {
    expect(
      rules(cleanObservations({ serverEgress: ['127.0.0.1:5432', '127.0.0.1:4777'] })),
    ).toEqual(['SERVER_EGRESS_NOT_ALLOWED:server.egress:-']);
    expect(
      analyse(cleanObservations({ serverEgress: ['collector.example.invalid:443'] })).violations[0]
        ?.where,
    ).toBe('server opened a socket to collector.example.invalid:443');
    expect(rules(cleanObservations({ serverEgress: [] }))).toEqual([]);
  });
  it('a browser request blocked by the policy, and private text in the console, are violations', () => {
    const blocked =
      "[error] Refused to connect to 'http://127.0.0.1:4777/collect' because it violates the following Content Security Policy directive: \"connect-src 'self'\".";
    const found = analyse(cleanObservations({ consoleMessages: [blocked] })).violations;
    expect(found.map((violation) => violation.rule)).toEqual(['BROWSER_REQUEST_BLOCKED_BY_POLICY']);
    expect(found[0]?.where).toContain('http://127.0.0.1:4777');
    expect(
      rules(
        cleanObservations({
          consoleMessages: [`[error] could not import ${canary('file').value}`],
        }),
      ),
    ).toEqual(['CANARY_IN_FORBIDDEN_DESTINATION:browser.console:file']);
  });
  it('names a layer that contributed nothing instead of counting it as clean', () => {
    const result = analyse(
      cleanObservations({ serverLog: '', providerRequests: '', objectStore: [] }),
    );
    expect(result.emptyLayers).toEqual(['providerRequestBytes', 'serverLogBytes', 'storedObjects']);
    expect(() => analyse({ journey: 'x' })).toThrow();
    expect(CANARIES.length).toBe(15);
  });
});
