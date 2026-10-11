import { createHash } from 'node:crypto';
import type { Canary } from './canary';

/*
 * Negative controls for the disclosure-boundary checks. Each fault is ONE small change to the
 * module that owns a boundary (the account hint store, the assistant route, the request builder),
 * applied to a DISPOSABLE COPY of the source by tooling/scripts/privacy-negative-controls.ts and
 * never to the working tree. The owning check must then fail for that boundary and that canary;
 * with the fault removed it must pass again.
 *
 * Every marker is synthetic and derived here from a label. Nothing in this file is a key, and no
 * fault is compiled into a shipped entry point: `pnpm exclusion:check` covers that.
 */

/** A deterministic 32-byte synthetic marker, as lowercase hex. It is not a key to anything. */
const bytesMarker = (label: string): string =>
  createHash('sha256').update(`lexaegis negative control: ${label}`).digest('hex');

export const FAULT_CANARIES = {
  serverSecret: {
    id: 'fault-server-secret',
    class: 'provider_credential',
    kind: 'text',
    value: 'negative-control-server-secret-3b1f9c',
  },
  signingKey: {
    id: 'fault-signing-key',
    class: 'signing_key',
    kind: 'bytes',
    value: bytesMarker('signing key'),
  },
  prfOutput: {
    id: 'fault-prf-output',
    class: 'prf_output',
    kind: 'bytes',
    value: bytesMarker('PRF output'),
  },
  vaultKey: {
    id: 'fault-vault-key',
    class: 'vault_key',
    kind: 'bytes',
    value: bytesMarker('vault key'),
  },
  sessionSecret: {
    id: 'fault-signing-session-secret',
    class: 'signing_session_secret',
    kind: 'text',
    value: 'negative-control-signing-session-secret-8d24e7',
  },
  cachedSecret: {
    id: 'fault-cached-secret',
    class: 'signing_session_secret',
    kind: 'text',
    value: 'negative-control-cached-session-secret-51c0aa',
  },
  transientSecret: {
    id: 'fault-transient-secret',
    class: 'prf_output',
    kind: 'bytes',
    value: bytesMarker('written then deleted'),
  },
  documentText: {
    id: 'fault-document-text',
    class: 'unselected_text',
    kind: 'text',
    value: 'NEGATIVE-CONTROL clause that was never selected 6a0d',
  },
  filename: {
    id: 'fault-filename',
    class: 'filename',
    kind: 'text',
    value: 'negative-control-file-4e7b.pdf',
  },
  amount: { id: 'fault-amount', class: 'money_field', kind: 'token', value: '918273645' },
  logSecret: {
    id: 'fault-log-secret',
    class: 'provider_credential',
    kind: 'text',
    value: 'negative-control-logged-credential-c95d02',
  },
  browserLeak: {
    id: 'fault-browser-leak',
    class: 'unselected_text',
    kind: 'text',
    value: 'NEGATIVE-CONTROL unselected text sent by the browser 1f8e',
  },
  serverLeak: {
    id: 'fault-server-leak',
    class: 'unselected_text',
    kind: 'text',
    value: 'NEGATIVE-CONTROL unselected text sent by the server 77b3',
  },
  extraField: {
    id: 'fault-unselected-extra',
    class: 'unselected_text',
    kind: 'text',
    value: 'NEGATIVE-CONTROL unselected text inside a consented request 2c9a',
  },
} as const satisfies Record<string, Canary>;

export const ALL_FAULT_CANARIES: Canary[] = Object.values(FAULT_CANARIES);

export interface FaultContext {
  /** A loopback receiver owned by the control run. It is not on the application's allowlist. */
  readonly receiverUrl: string;
}

export interface Fault {
  readonly id: string;
  /** The boundary the fault crosses, in the words of the disclosure matrix. */
  readonly boundary: string;
  /** What a developer would have done wrong. */
  readonly mistake: string;
  /** Repository-relative path of the module that owns the boundary. */
  readonly file: string;
  /** Text that occurs exactly once in that module. */
  readonly find: string;
  /** What replaces it (it always keeps the original behaviour and adds the fault). */
  readonly replace: (context: FaultContext) => string;
  /** The detector that must report it. Each pattern must match at least one failure line. */
  readonly expect: readonly RegExp[];
  /** Failure lines that must NOT appear (for example: a deleted value in a later snapshot). */
  readonly forbid?: readonly RegExp[];
  /** How many requests the loopback receiver must have seen: the fault's own traffic stays local. */
  readonly receiver?: 'none' | 'at_least_one';
}

const HINT_FILE = 'apps/web/src/features/account/derivation-profile.ts';
const HINT_WRITE =
  '    storage.setItem(HINT_KEY, JSON.stringify(publicAccountProfileSchema.parse(profile)));';
const afterHintWrite = (statement: string) => (): string => `${HINT_WRITE}\n    ${statement}`;

const RUN_ROUTE = 'apps/web/src/app/api/assistant/runs/route.ts';
const RUN_STARTED = "  logRun('assistant.run.started', requestId);";

/** Opens a throwaway database and stores one value: `value` is a JavaScript expression. */
const indexedDbPut = (value: string): string =>
  [
    '{',
    "      const open = indexedDB.open('lexaegis-negative-control', 1);",
    "      open.onupgradeneeded = () => open.result.createObjectStore('kept');",
    '      open.onsuccess = () => {',
    `        void Promise.resolve(${value}).then((kept) => {`,
    "          const tx = open.result.transaction('kept', 'readwrite');",
    "          tx.objectStore('kept').put(kept, 'value');",
    '          tx.oncomplete = () => open.result.close();',
    '        });',
    '      };',
    '    }',
  ].join('\n');

const bytesExpression = (hex: string): string =>
  `new Uint8Array([${(hex.match(/../g) ?? []).map((pair) => String(parseInt(pair, 16))).join(', ')}])`;

const canaryIn = (destination: string, canary: Canary): RegExp =>
  new RegExp(
    `^CANARY_IN_FORBIDDEN_DESTINATION hud ${destination.replace('.', '\\.')} ${canary.class} ${canary.id} @ `,
  );

export const FAULTS: readonly Fault[] = [
  {
    id: 'A1-server-secret-in-browser-module',
    boundary: 'built browser assets',
    mistake: 'a server-only configuration name and its value are written into a client module',
    file: HINT_FILE,
    find: "export const PROFILE_ID = 'lexaegis.evm.bip32-prf.v1';",
    replace: () =>
      [
        "export const PROFILE_ID = 'lexaegis.evm.bip32-prf.v1';",
        `(globalThis as unknown as Record<string, unknown>).negativeControl = 'QWEN_API_KEY=${FAULT_CANARIES.serverSecret.value}';`,
      ].join('\n'),
    expect: [
      /^SERVER_ENV_NAME web client assets \(\.next-hud-check\/static\) .*: QWEN_API_KEY$/,
      /^CANARY_VALUE web client assets \(\.next-hud-check\/static\) .*: provider_credential fault-server-secret /,
    ],
  },
  {
    id: 'S1-signing-key-in-localStorage',
    boundary: 'browser persistence: localStorage',
    mistake: 'a signing key is cached next to the public account hint',
    file: HINT_FILE,
    find: HINT_WRITE,
    replace: afterHintWrite(
      `storage.setItem('lexaegis.negative-control', '${FAULT_CANARIES.signingKey.value}');`,
    ),
    expect: [canaryIn('browser.localStorage', FAULT_CANARIES.signingKey)],
  },
  {
    id: 'S2-prf-output-in-sessionStorage',
    boundary: 'browser persistence: sessionStorage',
    mistake: 'a PRF output is kept for the tab session',
    file: HINT_FILE,
    find: HINT_WRITE,
    replace: afterHintWrite(
      `globalThis.sessionStorage.setItem('lexaegis.negative-control', '${FAULT_CANARIES.prfOutput.value}');`,
    ),
    expect: [canaryIn('browser.sessionStorage', FAULT_CANARIES.prfOutput)],
  },
  {
    id: 'S3-vault-key-bytes-in-IndexedDB',
    boundary: 'browser persistence: IndexedDB',
    mistake: 'unwrapped vault key bytes are stored in IndexedDB',
    file: HINT_FILE,
    find: HINT_WRITE,
    replace: afterHintWrite(indexedDbPut(bytesExpression(FAULT_CANARIES.vaultKey.value))),
    expect: [canaryIn('browser.indexedDB', FAULT_CANARIES.vaultKey)],
  },
  {
    id: 'S4-session-secret-in-a-script-cookie',
    boundary: 'browser persistence: cookies',
    mistake: 'a signing-session secret is written to a cookie by page script',
    file: HINT_FILE,
    find: HINT_WRITE,
    replace: afterHintWrite(
      `document.cookie = 'negative_control=${FAULT_CANARIES.sessionSecret.value}; path=/; SameSite=Strict';`,
    ),
    expect: [canaryIn('browser.cookie', FAULT_CANARIES.sessionSecret)],
  },
  {
    id: 'S5-secret-in-the-Cache-API',
    boundary: 'browser persistence: Cache storage',
    mistake: 'a response holding a session secret is put into Cache storage',
    file: HINT_FILE,
    find: HINT_WRITE,
    replace: afterHintWrite(
      `void caches.open('lexaegis-negative-control').then((cache) => cache.put('/negative-control', new Response('${FAULT_CANARIES.cachedSecret.value}')));`,
    ),
    expect: [
      /^CACHE_OR_SERVICE_WORKER_USED hud browser\.cache /,
      canaryIn('browser.cache', FAULT_CANARIES.cachedSecret),
    ],
  },
  {
    id: 'S6-secret-written-then-deleted',
    boundary: 'browser persistence: a transient write',
    mistake: 'a PRF output is written to localStorage and removed again at once',
    file: HINT_FILE,
    find: HINT_WRITE,
    replace: afterHintWrite(
      [
        `storage.setItem('lexaegis.negative-control.tmp', '${FAULT_CANARIES.transientSecret.value}');`,
        "    storage.removeItem('lexaegis.negative-control.tmp');",
      ].join('\n'),
    ),
    expect: [
      /^CANARY_IN_FORBIDDEN_DESTINATION hud browser\.localStorage prf_output fault-transient-secret @ localStorage write /,
    ],
    // No snapshot can see it: only the intercepted write does. That is the point of this control.
    forbid: [/fault-transient-secret @ localStorage "[^"]*" at /],
  },
  {
    id: 'S7-CryptoKey-in-IndexedDB',
    boundary: 'browser persistence: a stored CryptoKey',
    mistake: 'a non-extractable CryptoKey is stored in IndexedDB',
    file: HINT_FILE,
    find: HINT_WRITE,
    replace: afterHintWrite(
      indexedDbPut(
        "crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])",
      ),
    ),
    expect: [/^CRYPTOKEY_PERSISTED hud browser\.indexedDB /],
  },
  {
    id: 'L1-document-text-through-the-logger',
    boundary: 'server log: the application logger',
    mistake: 'document text and a file name are passed to the logger as a code',
    file: RUN_ROUTE,
    find: RUN_STARTED,
    replace: () =>
      `${RUN_STARTED}\n  logRun('negative.control', requestId, '${FAULT_CANARIES.documentText.value} in ${FAULT_CANARIES.filename.value}');`,
    expect: [
      canaryIn('server.log', FAULT_CANARIES.documentText),
      canaryIn('server.log', FAULT_CANARIES.filename),
    ],
  },
  {
    id: 'L2-amount-and-secret-on-the-error-path',
    boundary: 'server log: the error path',
    mistake: 'an error carrying an amount and a credential is printed with its stack',
    file: RUN_ROUTE,
    find: RUN_STARTED,
    replace: () =>
      [
        RUN_STARTED,
        '  try {',
        `    throw new Error('negative control: amount ${FAULT_CANARIES.amount.value} with ${FAULT_CANARIES.logSecret.value}');`,
        '  } catch (error) {',
        '    console.error(error);',
        '  }',
      ].join('\n'),
    expect: [
      canaryIn('server.log', FAULT_CANARIES.amount),
      canaryIn('server.log', FAULT_CANARIES.logSecret),
    ],
  },
  {
    id: 'N1-browser-sends-to-a-forbidden-receiver',
    boundary: 'browser network: a destination outside the origin, with no consent given',
    mistake: 'client code posts unselected text to another host',
    file: HINT_FILE,
    find: HINT_WRITE,
    replace: (context) =>
      afterHintWrite(
        `void fetch('${context.receiverUrl}', { method: 'POST', body: '${FAULT_CANARIES.browserLeak.value}' }).catch(() => undefined);`,
      )(),
    // The policy stops the request in the browser (it is then a blocked attempt); were the policy
    // ever to allow it, the request itself would be reported instead. Either is a detection.
    expect: [/^(?:BROWSER_REQUEST_BLOCKED_BY_POLICY|REQUEST_OUTSIDE_ORIGIN) hud request\.outside /],
    receiver: 'none',
  },
  {
    id: 'N2-server-sends-to-a-forbidden-receiver',
    boundary: 'server network: a destination outside its allowlist, with no consent given',
    mistake: 'a route posts unselected text to another host',
    file: 'apps/web/src/app/api/auth/me/route.ts',
    find: [
      'export const GET = handleRoute(async (requestId, request) =>',
      '  replyResponse(',
      "    await getAuthService().service.me(request.headers.get('cookie'), requestId),",
      '    requestId,',
      '  ),',
      ');',
    ].join('\n'),
    replace: (context) =>
      [
        'export const GET = handleRoute(async (requestId, request) => {',
        `  void fetch('${context.receiverUrl}', { method: 'POST', body: '${FAULT_CANARIES.serverLeak.value}' }).catch(() => undefined);`,
        '  return replyResponse(',
        "    await getAuthService().service.me(request.headers.get('cookie'), requestId),",
        '    requestId,',
        '  );',
        '});',
      ].join('\n'),
    expect: [/^SERVER_EGRESS_NOT_ALLOWED hud server\.egress - - @ server opened a socket to /],
    receiver: 'at_least_one',
  },
  {
    id: 'N3-consented-request-with-an-extra-unselected-field',
    boundary: 'analysis request: content beyond what was selected, inside a consented request',
    mistake: 'the request builder adds text that the reviewer never selected',
    file: 'apps/web/src/features/assistant/selected-context.ts',
    find: '      history: [...input.history],',
    replace: () =>
      `      history: [...input.history, { role: 'user' as const, text: '${FAULT_CANARIES.extraField.value}' }],`,
    expect: [canaryIn('request.assistant', FAULT_CANARIES.extraField)],
  },
];

/** Applies one fault to the text of its owning module, or says why it cannot. */
export function applyFault(
  fault: Fault,
  source: string,
  context: FaultContext,
): { ok: true; text: string } | { ok: false; reason: 'ANCHOR_MISSING' | 'ANCHOR_AMBIGUOUS' } {
  const occurrences = source.split(fault.find).length - 1;
  if (occurrences === 0) return { ok: false, reason: 'ANCHOR_MISSING' };
  if (occurrences > 1) return { ok: false, reason: 'ANCHOR_AMBIGUOUS' };
  return { ok: true, text: source.replace(fault.find, () => fault.replace(context)) };
}

export interface FaultVerdict {
  readonly detected: boolean;
  /** The failure lines that satisfied an expectation. They name IDs and classes, never values. */
  readonly matched: string[];
  readonly missing: string[];
  readonly forbidden: string[];
}

/** Decides whether the owning check reported THIS fault at THIS boundary. */
export function judgeFault(fault: Fault, failures: readonly string[]): FaultVerdict {
  const matched: string[] = [];
  const missing: string[] = [];
  for (const pattern of fault.expect) {
    const line = failures.find((failure) => pattern.test(failure));
    if (line === undefined) missing.push(pattern.source);
    else if (!matched.includes(line)) matched.push(line);
  }
  const forbidden = failures.filter((failure) =>
    (fault.forbid ?? []).some((pattern) => pattern.test(failure)),
  );
  return {
    detected: missing.length === 0 && forbidden.length === 0,
    matched,
    missing,
    forbidden,
  };
}
