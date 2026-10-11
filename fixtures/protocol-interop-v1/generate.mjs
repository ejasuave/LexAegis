/**
 * Independent generator for the supplemental Proof of Review interoperability cases.
 *
 * INDEPENDENCE RULE: like fixtures/protocol-v1/generate.mjs, this file never imports
 * @lexaegis/protocol or anything under packages/ (ESLint enforces it). Canonical bytes come from
 * Node's crypto, the separately authored `json-canonicalize` library and the minimal serializer
 * below; the two must agree before a case is written. EXPECTED OUTCOMES (stages and error codes)
 * are literals authored here from the specification, never copied from a run of the code under
 * test, and this file is never re-run to make a failing implementation pass.
 *
 *   node fixtures/protocol-interop-v1/generate.mjs          write cases.json
 *   node fixtures/protocol-interop-v1/generate.mjs --check  fail if cases.json is not reproducible
 *
 * Everything is SYNTHETIC. Opening nonces in these cases are fixed test values and are never
 * production randomness. No case holds a signing key, a signature or a provider replay.
 */
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { canonicalize as libraryJcs } from 'json-canonicalize';

const here = dirname(fileURLToPath(import.meta.url));
const ORIGINAL = JSON.parse(readFileSync(join(here, '..', 'protocol-v1', 'vectors.json'), 'utf8'));
const GENERIC = ORIGINAL.cases.find((item) => item.id === 'generic');
const GENERIC_SOURCE = 'fixtures/protocol-v1/vectors.json#generic';

const hex = (buffer) => `0x${Buffer.from(buffer).toString('hex')}`;
const text = (value) => Buffer.from(value, 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));
const uuid = (n) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Minimal RFC 8785 serializer for the subset used here: null, booleans, safe integers, strings, arrays, objects. */
function minimalJcs(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0))
      throw new Error('integer subset only');
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(minimalJcs).join(',')}]`;
  if (typeof value === 'object') {
    // Array.prototype.sort with no comparator orders by UTF-16 code unit, as JCS requires.
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${minimalJcs(value[key])}`)
      .join(',')}}`;
  }
  throw new Error('outside the subset');
}

function canonicalHex(inputText) {
  const parsed = JSON.parse(inputText);
  const own = minimalJcs(parsed);
  const library = libraryJcs(parsed);
  if (own !== library) throw new Error(`independent canonicalizers disagree for ${inputText}`);
  return hex(text(own));
}

const cases = [];
const add = (entry) => cases.push(entry);
const raw = (value) => ({ encoding: 'utf8', value });
const rawHex = (buffer) => ({ encoding: 'hex', value: hex(buffer) });

// ---- Canonicalization properties (supplemental, because closed manifests cannot exercise sorting) ----
function canonCase(id, description, inputText, property) {
  add({
    id,
    stage: 'canonicalization',
    operation: 'canonicalize-json',
    description,
    property,
    source: { kind: 'supplemental', generator: 'fixtures/protocol-interop-v1/generate.mjs' },
    input: raw(inputText),
    expected: { outcome: 'ok', canonicalUtf8Hex: canonicalHex(inputText) },
  });
}
canonCase(
  'canon-order-a',
  'Object members are sorted; whitespace is dropped.',
  '{ "b" : 2,\n "a" : 1 }',
  'member-order',
);
canonCase(
  'canon-order-b',
  'The same object in another order and spacing gives the same bytes.',
  '{"a":1,"b":2}',
  'member-order',
);
canonCase(
  'canon-order-nested',
  'Sorting is recursive.',
  '{"z":{"b":[1,{"y":1,"x":2}],"a":null},"a":true}',
  'member-order',
);
canonCase(
  'canon-prefix-keys',
  'A key that is a prefix sorts first.',
  '{"aa":1,"a":2,"":3,"A":4}',
  'member-order',
);
canonCase('canon-array-order-1', 'Array order is significant (1).', '[3,1,2]', 'array-order');
canonCase(
  'canon-array-order-2',
  'Array order is significant (2): different bytes from the previous case.',
  '[1,2,3]',
  'array-order',
);
canonCase(
  'canon-unicode-composed',
  'Composed U+00E9 is preserved, not normalized.',
  '{"k":"é"}',
  'no-normalization',
);
canonCase(
  'canon-unicode-decomposed',
  'Decomposed e + U+0301 is preserved and differs from the composed form.',
  '{"k":"é"}',
  'no-normalization',
);
canonCase(
  'canon-escape-equivalence',
  'An escaped character and its literal give the same bytes.',
  '{"k":"\\u00e9\\u0041"}',
  'no-normalization',
);
canonCase(
  'canon-non-bmp-order',
  'U+1F600 (surrogates D83D DE00) sorts BEFORE U+FF5E by UTF-16 code unit, unlike code-point order.',
  '{"～":1,"😀":2}',
  'utf16-order',
);
canonCase(
  'canon-non-bmp-after-bmp-low',
  'U+1F600 sorts AFTER U+D7FF (code unit D7FF < D83D).',
  '{"😀":1,"퟿":2}',
  'utf16-order',
);
canonCase(
  'canon-control-escapes',
  'Control characters use the short escapes or lowercase \\u00xx; U+007F and U+2028 are not escaped.',
  '{"k":"a\\u0001\\b\\t\\n\\f\\r\\"\\\\\\u007f\\u2028z"}',
  'string-escapes',
);
canonCase(
  'canon-integers',
  'Safe integers keep their decimal form.',
  '[0,-1,9007199254740991,-9007199254740991]',
  'integers',
);
canonCase(
  'canon-empty-and-literals',
  'Empty containers and literals.',
  '{"e":{},"a":[],"n":null,"t":true,"f":false}',
  'literals',
);

// ---- Positive cases from the original independently generated vectors -------------------------
for (const item of ORIGINAL.cases) {
  const source = { kind: 'original', fixture: 'fixtures/protocol-v1/vectors.json', case: item.id };
  const openingText = JSON.stringify(item.opening);
  for (const artifact of item.artifacts) {
    add({
      id: `${item.id}-artifact-digest-${artifact.id.slice(-2)}`,
      stage: 'digest',
      operation: 'artifact-digest',
      description: `SHA-256 of the exact original bytes of artifact ${artifact.id}.`,
      source,
      input: { encoding: 'base64', value: artifact.bytesBase64 },
      expected: { outcome: 'ok', digest: item.expected.artifactDigests[artifact.id] },
    });
  }
  add({
    id: `${item.id}-canonical-manifest`,
    stage: 'canonicalization',
    operation: 'canonical-manifest',
    description: 'Canonical UTF-8 bytes of the manifest inside the opening.',
    source,
    input: raw(JSON.stringify(item.opening, null, 2)),
    expected: { outcome: 'ok', canonicalUtf8Hex: item.expected.canonicalManifestUtf8Hex },
  });
  add({
    id: `${item.id}-package-digest`,
    stage: 'digest',
    operation: 'package-digest',
    description: 'SHA-256(domain || 0x00 || canonical bytes).',
    source,
    input: { encoding: 'hex', value: item.expected.canonicalManifestUtf8Hex },
    expected: { outcome: 'ok', digest: item.expected.packageDigest },
  });
  add({
    id: `${item.id}-commitment`,
    stage: 'commitment',
    operation: 'commitment',
    description:
      'SHA-256(domain || 0x00 || nonce || package digest), with a fixed test-only nonce.',
    source,
    input: {
      blindingNonce: item.opening.blindingNonce,
      packageDigest: item.expected.packageDigest,
    },
    expected: { outcome: 'ok', commitment: item.expected.commitment },
  });
  add({
    id: `${item.id}-verify-full`,
    stage: 'verification',
    operation: 'verify-package',
    description: 'Full-package verification against the literal public reference.',
    source,
    input: {
      opening: raw(openingText),
      artifacts: item.artifacts.map((a) => ({
        id: a.id,
        encoding: 'base64',
        value: a.bytesBase64,
      })),
      expectedReference: raw(JSON.stringify(item.expected.reference)),
    },
    expected: { outcome: 'ok', manifestIntegrity: 'match', artifactIntegrity: 'match', issues: [] },
  });
}

// Imported text need not be in canonical order: presentation variants verify identically.
{
  const reordered = (value) => {
    if (Array.isArray(value)) return value.map(reordered);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .reverse()
          .map((key) => [key, reordered(value[key])]),
      );
    return value;
  };
  const variants = [
    ['pretty-original-order', JSON.stringify(GENERIC.opening, null, 4)],
    ['minified-reverse-key-order', JSON.stringify(reordered(GENERIC.opening))],
    ['crlf-whitespace', JSON.stringify(GENERIC.opening, null, 2).replaceAll('\n', '\r\n')],
  ];
  for (const [name, openingText] of variants) {
    add({
      id: `generic-import-${name}`,
      stage: 'verification',
      operation: 'verify-package',
      description:
        'Valid import text may differ in whitespace and property order: the result is identical.',
      source: { kind: 'original', fixture: 'fixtures/protocol-v1/vectors.json', case: 'generic' },
      input: {
        opening: raw(openingText),
        artifacts: GENERIC.artifacts.map((a) => ({
          id: a.id,
          encoding: 'base64',
          value: a.bytesBase64,
        })),
        expectedReference: raw(JSON.stringify(GENERIC.expected.reference)),
      },
      expected: {
        outcome: 'ok',
        manifestIntegrity: 'match',
        artifactIntegrity: 'match',
        issues: [],
      },
    });
  }
}

// ---- Negative cases: raw text and bytes survive storage exactly --------------------------------
const GENERIC_TEXT = JSON.stringify(GENERIC.opening);
const negParse = (id, stage, code, input, description, extra = {}) =>
  add({
    id,
    stage,
    operation: 'parse-opening',
    description,
    source: { kind: 'supplemental', base: GENERIC_SOURCE },
    input,
    expected: { outcome: 'error', stage, code, ...extra },
  });
const mutated = (change) => {
  const value = clone(GENERIC.opening);
  change(value);
  return raw(JSON.stringify(value));
};
const replaceOnce = (needle, replacement) => {
  if (!GENERIC_TEXT.includes(needle)) throw new Error(`needle not found: ${needle}`);
  return raw(GENERIC_TEXT.replace(needle, replacement));
};

// strict JSON
negParse(
  'neg-duplicate-key',
  'strict-json',
  'DUPLICATE_KEY',
  raw(`{"schema":"lexaegis.opening.v1","schema":"lexaegis.opening.v1"}`),
  'A literal duplicate member name.',
);
negParse(
  'neg-duplicate-key-escaped',
  'strict-json',
  'DUPLICATE_KEY',
  raw(`{"schema":"lexaegis.opening.v1","\\u0073chema":"lexaegis.opening.v1"}`),
  'Member names equal only after escape decoding.',
);
negParse(
  'neg-duplicate-key-nested',
  'strict-json',
  'DUPLICATE_KEY',
  replaceOnce(
    '"profile":{"id":"example.generic-review","version":"1"}',
    '"profile":{"id":"example.generic-review","id":"x","version":"1"}',
  ),
  'A duplicate inside a nested object.',
);
negParse(
  'neg-invalid-utf8',
  'strict-json',
  'INVALID_UTF8',
  rawHex(Buffer.concat([text('{"schema":"'), Buffer.from([0xc3, 0x28]), text('"}')])),
  'Malformed UTF-8 (a truncated two-byte sequence).',
);
negParse(
  'neg-bom-bytes',
  'strict-json',
  'BYTE_ORDER_MARK',
  rawHex(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), text(GENERIC_TEXT)])),
  'A UTF-8 byte-order mark is rejected, not removed.',
);
negParse(
  'neg-trailing-comma',
  'strict-json',
  'INVALID_JSON',
  raw('{"schema":"lexaegis.opening.v1",}'),
  'A trailing comma.',
);
negParse('neg-comment', 'strict-json', 'INVALID_JSON', raw(`/* c */${GENERIC_TEXT}`), 'A comment.');
negParse(
  'neg-trailing-content',
  'strict-json',
  'INVALID_JSON',
  raw(`${GENERIC_TEXT} {}`),
  'Content after the value.',
);
negParse('neg-empty-input', 'strict-json', 'INVALID_JSON', raw(''), 'Empty input.');
negParse(
  'neg-number-fraction',
  'strict-json',
  'UNSAFE_NUMBER',
  raw('{"schema":1.5}'),
  'A fractional number.',
);
negParse(
  'neg-number-exponent',
  'strict-json',
  'UNSAFE_NUMBER',
  raw('{"schema":1e2}'),
  'An exponent literal.',
);
negParse(
  'neg-number-negative-zero',
  'strict-json',
  'UNSAFE_NUMBER',
  raw('{"schema":-0}'),
  'Lexical negative zero.',
);
negParse(
  'neg-number-unsafe-integer',
  'strict-json',
  'UNSAFE_NUMBER',
  raw('{"schema":9007199254740993}'),
  'An integer beyond the safe range.',
);
negParse(
  'neg-lone-surrogate-escape',
  'strict-json',
  'LONE_SURROGATE',
  raw('{"schema":"\\ud800"}'),
  'A lone high surrogate written as an escape.',
);
negParse(
  'neg-lone-surrogate-key',
  'strict-json',
  'LONE_SURROGATE',
  raw('{"\\udc00":1}'),
  'A lone low surrogate in a member name.',
);
negParse(
  'neg-forbidden-key',
  'strict-json',
  'FORBIDDEN_KEY',
  raw('{"__proto__":{}}'),
  'A prototype-manipulation member name.',
);
negParse(
  'neg-nesting-too-deep',
  'strict-json',
  'NESTING_TOO_DEEP',
  raw(`${'['.repeat(33)}${']'.repeat(33)}`),
  'Nesting of 33 containers (the limit is 32).',
);

// version dispatch
negParse(
  'neg-version-opening',
  'version',
  'UNSUPPORTED_VERSION',
  mutated((v) => (v.schema = 'lexaegis.opening.v2')),
  'Unsupported opening version.',
);
negParse(
  'neg-version-manifest',
  'version',
  'UNSUPPORTED_VERSION',
  mutated((v) => (v.manifest.schema = 'lexaegis.review-package.v2')),
  'Unsupported manifest version.',
);
negParse(
  'neg-version-missing',
  'version',
  'SCHEMA_INVALID',
  mutated((v) => delete v.schema),
  'No schema member at all.',
);
negParse(
  'neg-version-not-string',
  'version',
  'SCHEMA_INVALID',
  mutated((v) => (v.schema = 1)),
  'A non-string schema member.',
);

// schema
negParse(
  'neg-unknown-field-top',
  'schema',
  'UNKNOWN_FIELD',
  mutated((v) => (v.extra = 'x')),
  'An unknown field at the top level.',
);
negParse(
  'neg-unknown-field-nested',
  'schema',
  'UNKNOWN_FIELD',
  mutated((v) => (v.manifest.context.rpcUrl = 'https://example.invalid')),
  'An unknown field inside context.',
);
negParse(
  'neg-unknown-field-artifact',
  'schema',
  'UNKNOWN_FIELD',
  mutated((v) => (v.manifest.artifacts[0].url = 'https://example.invalid/a')),
  'A URL smuggled into an artifact.',
);
negParse(
  'neg-digest-uppercase',
  'schema',
  'SCHEMA_INVALID',
  mutated(
    (v) =>
      (v.manifest.artifacts[0].sha256 = v.manifest.artifacts[0].sha256
        .toUpperCase()
        .replace('0X', '0x')),
  ),
  'Uppercase hexadecimal.',
);
negParse(
  'neg-digest-short',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.manifest.artifacts[0].sha256 = v.manifest.artifacts[0].sha256.slice(0, -2))),
  'A 31-byte digest.',
);
negParse(
  'neg-digest-no-prefix',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.manifest.artifacts[0].sha256 = v.manifest.artifacts[0].sha256.slice(2))),
  'A digest without 0x.',
);
negParse(
  'neg-nonce-short',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.blindingNonce = v.blindingNonce.slice(0, -2))),
  'A 31-byte blinding nonce.',
);
negParse(
  'neg-nonce-uppercase',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.blindingNonce = `0x${v.blindingNonce.slice(2).toUpperCase()}`)),
  'An uppercase blinding nonce.',
);
negParse(
  'neg-nonce-not-hex',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.blindingNonce = `0x${'zz'.repeat(32)}`)),
  'A nonce that is not hexadecimal.',
);
negParse(
  'neg-address-checksum-case',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.manifest.context.reviewerAddress = `0x${'aB'.repeat(20)}`)),
  'A mixed-case address.',
);
negParse(
  'neg-address-zero',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.manifest.context.reviewerAddress = `0x${'00'.repeat(20)}`)),
  'The zero reviewer address.',
);
negParse(
  'neg-chain-id-zero',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.manifest.context.chainId = '0')),
  'Chain ID zero.',
);
negParse(
  'neg-chain-id-number',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.manifest.context.chainId = 31337)),
  'A chain ID written as a JSON number.',
);
negParse(
  'neg-chain-id-leading-zero',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.manifest.context.chainId = '031337')),
  'A chain ID with a leading zero.',
);
negParse(
  'neg-byte-length-leading-zero',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.manifest.artifacts[0].byteLength = '080')),
  'A non-canonical decimal byte length.',
);
negParse(
  'neg-byte-length-number',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.manifest.artifacts[0].byteLength = 80)),
  'A byte length that is a safe JSON integer: accepted by the JSON stage, rejected here.',
);
negParse(
  'neg-byte-length-too-large',
  'schema',
  'ARTIFACT_TOO_LARGE',
  mutated((v) => (v.manifest.artifacts[0].byteLength = '10485761')),
  'One byte over the per-artifact limit.',
);
negParse(
  'neg-timestamp-no-millis',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.manifest.preparedAt = '2026-01-01T00:00:00Z')),
  'A timestamp without milliseconds.',
);
negParse(
  'neg-timestamp-impossible-date',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.manifest.preparedAt = '2026-02-30T00:00:00.000Z')),
  'An impossible calendar date.',
);
negParse(
  'neg-uuid-version',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.manifest.packageId = 'a0000000-0000-1000-8000-000000000001')),
  'A non-v4 UUID.',
);
negParse(
  'neg-media-type-uppercase',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.manifest.artifacts[0].mediaType = 'Text/Plain')),
  'An uppercase media type.',
);
negParse(
  'neg-media-type-parameter',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.manifest.artifacts[0].mediaType = 'text/plain; charset=utf-8')),
  'A media type with parameters.',
);
negParse(
  'neg-label-too-long',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.manifest.artifacts[0].label = 'x'.repeat(257))),
  'A 257-code-point label.',
);
negParse(
  'neg-profile-id-uppercase',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.manifest.profile.id = 'Example.Generic')),
  'An uppercase profile identifier.',
);
negParse(
  'neg-role-unknown',
  'schema',
  'SCHEMA_INVALID',
  mutated((v) => (v.manifest.artifacts[0].role = 'summary')),
  'An unknown artifact role.',
);
negParse(
  'neg-too-many-artifacts',
  'schema',
  'TOO_MANY_ARTIFACTS',
  mutated((v) => {
    const one = v.manifest.artifacts[0];
    v.manifest.artifacts = Array.from({ length: 129 }, (_, i) => ({ ...one, id: uuid(i + 1) }));
  }),
  '129 artifacts (the limit is 128).',
);
negParse(
  'neg-supersedes-wrong-schema',
  'version',
  'UNSUPPORTED_VERSION',
  mutated((v) => {
    v.manifest.supersedes = { ...GENERIC.expected.reference, schema: 'lexaegis.receipt-ref.v2' };
  }),
  'A predecessor reference with an unsupported version.',
);

// cross-field rules
const crossCase = (id, code, change, description) =>
  negParse(id, 'cross-field', code, mutated(change), description);
crossCase(
  'neg-cross-duplicate-artifact-id',
  'DUPLICATE_ARTIFACT_ID',
  (v) => {
    v.manifest.artifacts[1].id = v.manifest.artifacts[0].id;
  },
  'Two artifacts share an ID.',
);
crossCase(
  'neg-cross-no-source',
  'SOURCE_ARTIFACT_REQUIRED',
  (v) => {
    v.manifest.artifacts[0].role = 'evidence';
  },
  'No artifact has role source.',
);
crossCase(
  'neg-cross-two-decision-logs',
  'DECISION_LOG_ARTIFACT_INVALID',
  (v) => {
    v.manifest.artifacts.push({ ...v.manifest.artifacts[1], id: uuid(60) });
    v.manifest.approval.scopeArtifactIds.push(uuid(60));
  },
  'A source and two decision-log artifacts.',
);
crossCase(
  'neg-cross-duplicate-scope',
  'DUPLICATE_SCOPE_ID',
  (v) => {
    v.manifest.approval.scopeArtifactIds[1] = v.manifest.approval.scopeArtifactIds[0];
  },
  'A scope ID listed twice.',
);
crossCase(
  'neg-cross-unresolved-scope',
  'UNRESOLVED_ARTIFACT_REFERENCE',
  (v) => {
    v.manifest.approval.scopeArtifactIds[1] = uuid(99);
  },
  'A scope ID that names no artifact.',
);
crossCase(
  'neg-cross-scope-incomplete',
  'SCOPE_INCOMPLETE',
  (v) => {
    v.manifest.approval.scopeArtifactIds.pop();
  },
  'An artifact missing from the approval scope.',
);
crossCase(
  'neg-cross-decision-log-unresolved',
  'UNRESOLVED_ARTIFACT_REFERENCE',
  (v) => {
    v.manifest.approval.decisionLogArtifactId = uuid(98);
  },
  'A decision-log ID that names no artifact.',
);
crossCase(
  'neg-cross-decision-log-wrong-role',
  'DECISION_LOG_REFERENCE_INVALID',
  (v) => {
    v.manifest.approval.decisionLogArtifactId = v.manifest.artifacts[0].id;
  },
  'A decision-log ID that names a source.',
);
crossCase(
  'neg-cross-total-too-large',
  'ARTIFACTS_TOO_LARGE',
  (v) => {
    const [source, log] = v.manifest.artifacts;
    const extra = [1, 2, 3, 4].map((n) => ({
      ...source,
      id: uuid(n),
      role: 'evidence',
      byteLength: '10485760',
    }));
    v.manifest.artifacts = [source, log, ...extra];
    v.manifest.approval.scopeArtifactIds = v.manifest.artifacts.map((a) => a.id);
  },
  'Declared lengths exceeding the 32 MiB total.',
);
crossCase(
  'neg-cross-supersedes-other-chain',
  'SUPERSEDES_CONTEXT_MISMATCH',
  (v) => {
    v.manifest.supersedes = { ...GENERIC.expected.reference, chainId: '1' };
  },
  'A predecessor on another chain.',
);
crossCase(
  'neg-cross-supersedes-other-reviewer',
  'SUPERSEDES_CONTEXT_MISMATCH',
  (v) => {
    v.manifest.supersedes = {
      ...GENERIC.expected.reference,
      reviewerAddress: `0x${'33'.repeat(20)}`,
    };
  },
  'A predecessor under another reviewer.',
);

// reference parsing
const negReference = (id, stage, code, input, description) =>
  add({
    id,
    stage,
    operation: 'parse-reference',
    description,
    source: { kind: 'supplemental', base: GENERIC_SOURCE },
    input,
    expected: { outcome: 'error', stage, code },
  });
const refWith = (change) => {
  const value = clone(GENERIC.expected.reference);
  change(value);
  return raw(JSON.stringify(value));
};
negReference(
  'neg-reference-unknown-field',
  'schema',
  'UNKNOWN_FIELD',
  refWith((r) => (r.label = 'x')),
  'A private label on a public reference.',
);
negReference(
  'neg-reference-version',
  'version',
  'UNSUPPORTED_VERSION',
  refWith((r) => (r.schema = 'lexaegis.receipt-ref.v2')),
  'An unsupported reference version.',
);
negReference(
  'neg-reference-commitment-short',
  'schema',
  'SCHEMA_INVALID',
  refWith((r) => (r.commitment = r.commitment.slice(0, -2))),
  'A 31-byte commitment.',
);
negReference(
  'neg-reference-registry-zero',
  'schema',
  'SCHEMA_INVALID',
  refWith((r) => (r.registryAddress = `0x${'00'.repeat(20)}`)),
  'The zero registry address.',
);
negReference(
  'neg-reference-duplicate-key',
  'strict-json',
  'DUPLICATE_KEY',
  raw(JSON.stringify(GENERIC.expected.reference).replace('"chainId"', '"chainId":"1","chainId"')),
  'A duplicate chainId.',
);

// ---- Verification negatives: independent expected outcomes --------------------------------------
const artifacts = GENERIC.artifacts.map((a) => ({
  id: a.id,
  encoding: 'base64',
  value: a.bytesBase64,
}));
const [firstArtifact] = GENERIC.artifacts;
const verify = (
  id,
  description,
  {
    opening = GENERIC_TEXT,
    supplied = artifacts,
    reference = GENERIC.expected.reference,
    expected,
  },
) =>
  add({
    id,
    // A rejected expected reference fails at the stage that rejects it, before verification runs.
    stage: expected.outcome === 'error' ? expected.stage : 'verification',
    operation: 'verify-package',
    description,
    source: { kind: 'supplemental', base: GENERIC_SOURCE },
    input: {
      opening: raw(opening),
      artifacts: supplied,
      expectedReference: raw(JSON.stringify(reference)),
    },
    expected,
  });
const flipByte = (base64) => {
  const buffer = Buffer.from(base64, 'base64');
  buffer[0] ^= 0x01;
  return buffer.toString('base64');
};
verify(
  'verify-wrong-commitment',
  'The expected reference names another commitment: manifest mismatch, artifacts not evaluated.',
  {
    reference: { ...GENERIC.expected.reference, commitment: `0x${'ab'.repeat(32)}` },
    expected: {
      outcome: 'ok',
      manifestIntegrity: 'mismatch',
      artifactIntegrity: 'unknown',
      issues: [{ code: 'COMMITMENT_MISMATCH' }, { code: 'ARTIFACTS_NOT_EVALUATED' }],
    },
  },
);
verify('verify-wrong-chain', 'The expected reference is for another chain.', {
  reference: { ...GENERIC.expected.reference, chainId: '1' },
  expected: {
    outcome: 'ok',
    manifestIntegrity: 'mismatch',
    artifactIntegrity: 'unknown',
    issues: [{ code: 'CONTEXT_MISMATCH' }, { code: 'ARTIFACTS_NOT_EVALUATED' }],
  },
});
verify('verify-wrong-registry', 'The expected reference is for another registry.', {
  reference: { ...GENERIC.expected.reference, registryAddress: `0x${'44'.repeat(20)}` },
  expected: {
    outcome: 'ok',
    manifestIntegrity: 'mismatch',
    artifactIntegrity: 'unknown',
    issues: [{ code: 'CONTEXT_MISMATCH' }, { code: 'ARTIFACTS_NOT_EVALUATED' }],
  },
});
verify('verify-changed-nonce', 'A different blinding nonce does not open the commitment.', {
  opening: JSON.stringify({ ...GENERIC.opening, blindingNonce: `0x${'11'.repeat(32)}` }),
  expected: {
    outcome: 'ok',
    manifestIntegrity: 'mismatch',
    artifactIntegrity: 'unknown',
    issues: [{ code: 'COMMITMENT_MISMATCH' }, { code: 'ARTIFACTS_NOT_EVALUATED' }],
  },
});
verify('verify-changed-metadata', 'A changed label changes the committed package.', {
  opening: JSON.stringify(Object.assign(clone(GENERIC.opening), {}), (key, value) =>
    key === 'label' && value === null ? 'x' : value,
  ),
  expected: {
    outcome: 'ok',
    manifestIntegrity: 'mismatch',
    artifactIntegrity: 'unknown',
    issues: [{ code: 'COMMITMENT_MISMATCH' }, { code: 'ARTIFACTS_NOT_EVALUATED' }],
  },
});
verify('verify-altered-artifact-byte', 'One flipped bit in an artifact with the same length.', {
  supplied: [{ ...artifacts[0], value: flipByte(artifacts[0].value) }, artifacts[1]],
  expected: {
    outcome: 'ok',
    manifestIntegrity: 'match',
    artifactIntegrity: 'mismatch',
    issues: [{ code: 'ARTIFACT_DIGEST_MISMATCH', artifactId: firstArtifact.id }],
  },
});
verify('verify-truncated-artifact', 'An artifact one byte shorter than declared.', {
  supplied: [
    {
      ...artifacts[0],
      value: Buffer.from(artifacts[0].value, 'base64').subarray(1).toString('base64'),
    },
    artifacts[1],
  ],
  expected: {
    outcome: 'ok',
    manifestIntegrity: 'match',
    artifactIntegrity: 'mismatch',
    issues: [{ code: 'ARTIFACT_LENGTH_MISMATCH', artifactId: firstArtifact.id }],
  },
});
verify(
  'verify-missing-artifact',
  'A committed artifact is not supplied: integrity is unknown, not a mismatch.',
  {
    supplied: [artifacts[0]],
    expected: {
      outcome: 'ok',
      manifestIntegrity: 'match',
      artifactIntegrity: 'unknown',
      issues: [{ code: 'ARTIFACT_MISSING', artifactId: GENERIC.artifacts[1].id }],
    },
  },
);
verify('verify-extra-artifact', 'A file the manifest never committed.', {
  supplied: [
    ...artifacts,
    { id: uuid(50), encoding: 'base64', value: Buffer.from('extra').toString('base64') },
  ],
  expected: {
    outcome: 'ok',
    manifestIntegrity: 'match',
    artifactIntegrity: 'mismatch',
    issues: [{ code: 'ARTIFACT_NOT_IN_MANIFEST', artifactId: uuid(50) }],
  },
});
verify(
  'verify-crlf-normalized-artifact',
  'Line endings are part of the bytes: LF-normalized text does not verify.',
  {
    supplied: [
      {
        ...artifacts[0],
        value: Buffer.from(
          Buffer.from(artifacts[0].value, 'base64').toString('utf8').replaceAll('\r\n', '\n'),
        ).toString('base64'),
      },
      artifacts[1],
    ],
    expected: {
      outcome: 'ok',
      manifestIntegrity: 'match',
      artifactIntegrity: 'mismatch',
      issues: [{ code: 'ARTIFACT_LENGTH_MISMATCH', artifactId: firstArtifact.id }],
    },
  },
);
verify(
  'verify-reserialized-structured-artifact',
  'A structured artifact re-serialized with different whitespace no longer matches its digest.',
  {
    supplied: [
      artifacts[0],
      {
        ...artifacts[1],
        value: Buffer.from(
          JSON.stringify(JSON.parse(Buffer.from(artifacts[1].value, 'base64').toString('utf8'))),
        ).toString('base64'),
      },
    ],
    expected: {
      outcome: 'ok',
      manifestIntegrity: 'match',
      artifactIntegrity: 'mismatch',
      issues: [{ code: 'ARTIFACT_LENGTH_MISMATCH', artifactId: GENERIC.artifacts[1].id }],
    },
  },
);
verify(
  'verify-malformed-reference',
  'The expected reference is not a valid reference: a typed failure, not a mismatch.',
  {
    reference: { ...GENERIC.expected.reference, commitment: '0x12' },
    expected: { outcome: 'error', stage: 'schema', code: 'SCHEMA_INVALID' },
  },
);

// Revised package: the declared predecessor must be exactly the earlier reference.
{
  const revised = ORIGINAL.cases.find((item) => item.id === 'legal-revised');
  const legal = ORIGINAL.cases.find((item) => item.id === 'legal');
  add({
    id: 'verify-revised-keeps-predecessor-context',
    stage: 'verification',
    operation: 'verify-package',
    description:
      'A replacement verifies as its own package; its declared predecessor does not change its result.',
    source: {
      kind: 'original',
      fixture: 'fixtures/protocol-v1/vectors.json',
      case: 'legal-revised',
    },
    input: {
      opening: raw(JSON.stringify(revised.opening)),
      artifacts: revised.artifacts.map((a) => ({
        id: a.id,
        encoding: 'base64',
        value: a.bytesBase64,
      })),
      expectedReference: raw(JSON.stringify(revised.expected.reference)),
    },
    expected: { outcome: 'ok', manifestIntegrity: 'match', artifactIntegrity: 'match', issues: [] },
  });
  add({
    id: 'verify-revised-against-predecessor-reference',
    stage: 'verification',
    operation: 'verify-package',
    description:
      'The replacement is not the predecessor: checking it against the earlier reference is a mismatch.',
    source: { kind: 'supplemental', base: 'fixtures/protocol-v1/vectors.json#legal-revised' },
    input: {
      opening: raw(JSON.stringify(revised.opening)),
      artifacts: revised.artifacts.map((a) => ({
        id: a.id,
        encoding: 'base64',
        value: a.bytesBase64,
      })),
      expectedReference: raw(JSON.stringify(legal.expected.reference)),
    },
    expected: {
      outcome: 'ok',
      manifestIntegrity: 'mismatch',
      artifactIntegrity: 'unknown',
      issues: [{ code: 'COMMITMENT_MISMATCH' }, { code: 'ARTIFACTS_NOT_EVALUATED' }],
    },
  });
}

const output = {
  $comment:
    'SYNTHETIC supplemental interoperability cases. Generated by fixtures/protocol-interop-v1/generate.mjs, independently of the implementation. Expected outcomes are authored literals. Opening nonces are FIXED test values and must never be used in production. Do not edit by hand.',
  format: 'lexaegis.protocol-interop-v1.cases/1',
  cases,
};

const path = join(here, 'cases.json');
const body = `${JSON.stringify(output, null, 2)}\n`;
function readOrNull(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
if (process.argv.includes('--check')) {
  if (readOrNull(path) !== body) {
    console.error('fixtures/protocol-interop-v1/cases.json is not reproducible from generate.mjs');
    process.exit(1);
  }
  console.log('fixtures/protocol-interop-v1/cases.json is reproducible');
} else {
  writeFileSync(path, body);
  console.log(`wrote ${cases.length} cases to fixtures/protocol-interop-v1/cases.json`);
}
