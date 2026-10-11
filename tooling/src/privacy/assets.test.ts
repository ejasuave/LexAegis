import { describe, expect, it } from 'vitest';
import {
  classifyCandidate,
  keyShapedCandidates,
  scanBrowserAssets,
  scanServerAssets,
  type PublicSource,
} from './assets';
import type { Canary } from './canary';

const CURVE_ORDER = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';
const GENERATOR_X = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const UNKNOWN = '5d41402abc4b2a76b9719d911017c5925d41402abc4b2a76b9719d911017c592';
const sources: PublicSource[] = [
  { label: 'public dependency @noble/curves', text: `gx: 0x${GENERATOR_X}n` },
  {
    label: 'contracts/deployments/monad-testnet.json',
    text: '"genesishash": "0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9"',
  },
];
const canaries: Canary[] = [
  {
    id: 'storage-secret',
    class: 'storage_credential',
    kind: 'text',
    value: 'synthetic-storage-secret-77c0',
  },
];
const options = {
  serverEnvNames: ['DATABASE_URL', 'QWEN_API_KEY', 'S3_SECRET_ACCESS_KEY'],
  canaries,
  privateFixtureMarkers: ['Northwind Demo Ltd'],
  publicSources: sources,
};
const scan = (text: string) => scanBrowserAssets([{ name: 'static/chunks/app.js', text }], options);

describe('key-shaped values in browser assets', () => {
  it('finds 32-byte hex values, with or without 0x, and not parts of longer hex runs', () => {
    expect(keyShapedCandidates(`a=0x${GENERATOR_X};b="${UNKNOWN.toUpperCase()}"`)).toEqual(
      [UNKNOWN, GENERATOR_X].sort(),
    );
    expect(keyShapedCandidates(`0x${'ab'.repeat(65)}`)).toEqual([]);
    expect(keyShapedCandidates('no hex here')).toEqual([]);
  });
  it('classifies a candidate only against a named public source, or as plainly not key material', () => {
    expect(classifyCandidate(GENERATOR_X, sources)).toBe('public: public dependency @noble/curves');
    expect(
      classifyCandidate(
        '298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9',
        sources,
      ),
    ).toBe('public: contracts/deployments/monad-testnet.json');
    expect(classifyCandidate(CURVE_ORDER, [])).toBe('not_key_material: low-entropy pattern');
    expect(classifyCandidate('0'.repeat(63) + '1', [])).toBe(
      'not_key_material: decimal digits only',
    );
    expect(classifyCandidate(UNKNOWN, sources)).toBeNull();
  });
  it('reports an unclassified candidate instead of ignoring it, and never prints it whole', () => {
    const result = scan(`const k="${UNKNOWN}"; const g=0x${GENERATOR_X}n;`);
    expect(result.findings).toEqual([
      {
        file: 'static/chunks/app.js',
        rule: 'UNCLASSIFIED_KEY_SHAPED',
        detail: `${UNKNOWN.slice(0, 8)}… (64 hex digits)`,
      },
    ]);
    expect(result.classified).toEqual([
      {
        candidate: `${GENERATOR_X.slice(0, 8)}…`,
        reason: 'public: public dependency @noble/curves',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(UNKNOWN);
  });
});

describe('browser asset rules', () => {
  it('a clean bundle has no finding', () => {
    expect(
      scan('export const origin=process.env.NEXT_PUBLIC_APP_ORIGIN;fetch("/api/health")').findings,
    ).toEqual([]);
  });
  it('names of server-only configuration, a server-only module and a synthetic credential value are findings', () => {
    expect(
      scan('const u=process.env.DATABASE_URL').findings.map(
        (finding) => `${finding.rule}:${finding.detail}`,
      ),
    ).toEqual(['SERVER_ENV_NAME:DATABASE_URL']);
    // A longer public name that merely contains a server name is not that name.
    expect(scan('const u=process.env.NEXT_PUBLIC_DATABASE_URL_HINT').findings).toEqual([]);
    expect(scan('import "server-only";').findings.map((finding) => finding.rule)).toEqual([
      'SERVER_ONLY_MODULE',
    ]);
    expect(scan('var m="../src/server/env.ts"').findings.map((finding) => finding.rule)).toEqual([
      'SERVER_ONLY_MODULE',
    ]);
    const leaked = scan('const s="synthetic-storage-secret-77c0"');
    expect(leaked.findings.map((finding) => `${finding.rule}:${finding.detail}`)).toEqual([
      'CANARY_VALUE:storage_credential storage-secret (plain)',
    ]);
    expect(
      scan(
        `const b="${Buffer.from('prefix synthetic-storage-secret-77c0').toString('base64')}"`,
      ).findings.map((finding) => finding.rule),
    ).toEqual(['CANARY_VALUE']);
  });
  it('private fixture text and key material by shape are findings', () => {
    expect(
      scan('const demo="Employer: Northwind Demo Ltd"').findings.map((finding) => finding.rule),
    ).toEqual(['PRIVATE_FIXTURE']);
    expect(
      scan(['-----BEGIN', 'PRIVATE KEY-----'].join(' ')).findings.map((finding) => finding.detail),
    ).toEqual(['PEM private key']);
    expect(
      scan(`const t="${['sk', 'a'.repeat(30)].join('-')}"`).findings.map(
        (finding) => finding.detail,
      ),
    ).toEqual(['provider API key']);
    expect(
      scan(
        `const u="${['https://', 'user', ':', 'word', '@db.example.test/x'].join('')}"`,
      ).findings.map((finding) => finding.detail),
    ).toEqual(['credential in a URL']);
  });
});

describe('server bundle rule', () => {
  it('reading configuration by name is not a leak; a literal secret value is', () => {
    const files = [
      {
        name: 'server/chunks/env.js',
        text: 'const url=process.env.DATABASE_URL; const key=process.env.S3_SECRET_ACCESS_KEY;',
      },
    ];
    expect(scanServerAssets(files, canaries)).toEqual([]);
    const baked = [
      { name: 'server/chunks/env.js', text: 'const key="synthetic-storage-secret-77c0";' },
    ];
    expect(scanServerAssets(baked, canaries).map((finding) => finding.rule)).toEqual([
      'CANARY_VALUE',
    ]);
  });
});
