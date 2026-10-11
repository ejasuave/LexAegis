/** UNIT-TEST FIXTURE ONLY: a clean observation set with synthetic canaries. */
import type { Canary } from './canary';
import type { Observations } from './analyse';

export const ORIGIN = 'http://localhost:3999';
const hex = (byte: string) => byte.repeat(32);

export const CANARIES: Canary[] = [
  {
    id: 'doc-selected',
    class: 'selected_text',
    kind: 'text',
    value: 'Total settlement payment CANARY-SEL',
  },
  {
    id: 'doc-unselected',
    class: 'unselected_text',
    kind: 'text',
    value: 'Northwind CANARY-UNSEL Ltd',
  },
  { id: 'file', class: 'filename', kind: 'text', value: 'canary-file-7f3a.pdf' },
  { id: 'title', class: 'matter_title', kind: 'text', value: 'SENTINEL-matter-5e72' },
  {
    id: 'note',
    class: 'reviewer_note',
    kind: 'text',
    value: 'The client was told about the "gap".',
  },
  { id: 'amount', class: 'money_field', kind: 'token', value: '2400000' },
  { id: 'nonce', class: 'opening_nonce', kind: 'bytes', value: hex('a1') },
  { id: 'artifact', class: 'artifact_hash', kind: 'bytes', value: hex('b2') },
  {
    id: 'prf',
    class: 'prf_output',
    kind: 'bytes',
    value: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  },
  { id: 'key', class: 'signing_key', kind: 'bytes', value: hex('c3') },
  {
    id: 'vault',
    class: 'vault_key',
    kind: 'bytes',
    value: 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f',
  },
  { id: 'session', class: 'session_cookie', kind: 'text', value: 'sess-CANARY-9d41c7' },
  {
    id: 'provider',
    class: 'provider_credential',
    kind: 'text',
    value: 'synthetic-provider-credential-51ab',
  },
  {
    id: 'storage',
    class: 'storage_credential',
    kind: 'text',
    value: 'synthetic-storage-secret-77c0',
  },
  {
    id: 'database',
    class: 'database_credential',
    kind: 'text',
    value: 'synthetic-database-password-0e9f',
  },
];
export const canary = (id: string): Canary => {
  const found = CANARIES.find((item) => item.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};

export function cleanObservations(over: Partial<Observations> = {}): Observations {
  return {
    journey: 'unit',
    origin: ORIGIN,
    consentedDisclosure: false,
    canaries: CANARIES,
    storageWrites: [
      {
        kind: 'localStorage',
        key: 'lexaegis.account-profile',
        value: '{"address":"0x11"}',
        phase: 'unlock',
      },
    ],
    snapshots: [
      {
        phase: 'end',
        localStorage: { 'lexaegis.account-profile': '{"address":"0x11"}' },
        sessionStorage: {},
        documentCookie: '',
        cookies: [{ name: '__Host-session', value: 'sess-CANARY-9d41c7', httpOnly: true }],
        indexedDB: '[]',
        caches: [],
        serviceWorkers: 0,
      },
    ],
    requests: [
      {
        method: 'POST',
        url: `${ORIGIN}/api/auth/verify`,
        body: `{"signature":"0x${'ab'.repeat(65)}"}`,
      },
      { method: 'PUT', url: `${ORIGIN}/api/vault/objects/1`, body: '{"ciphertext":"b3BhcXVl"}' },
    ],
    responses: [{ url: `${ORIGIN}/api/vault/head`, status: 200, body: '{"revision":"1"}' }],
    providerRequests: '[]',
    serverLog: 'event=vault.put code=OK\n',
    database: '[{"id":1,"ciphertext":"b3BhcXVl"}]',
    objectStore: [{ name: 'objects/1', content: 'opaque-bytes' }],
    consoleMessages: ['[log] ready'],
    serverEgress: ['127.0.0.1:5432', '127.0.0.1:9000'],
    serverEgressAllowed: ['127.0.0.1:5432', '127.0.0.1:9000', '127.0.0.1:9100'],
    unobserved: [],
    ...over,
  };
}
