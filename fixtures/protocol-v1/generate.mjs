/**
 * Fixture-generation utility for the protocol v1 test vectors.
 *
 * INDEPENDENCE RULE: this file must never import @lexaegis/protocol or anything under
 * packages/. Expected values are produced here with Node's crypto module, a separately authored
 * RFC 8785 library (json-canonicalize) and a minimal serializer written below; the two must
 * agree before anything is written. The domain strings are literals copied from the
 * specification, not from the implementation's constants.
 *
 *   node fixtures/protocol-v1/generate.mjs          write vectors.json
 *   node fixtures/protocol-v1/generate.mjs --check  fail if vectors.json is not reproducible
 *
 * Everything here is SYNTHETIC: test-only addresses, documents, decisions and FIXED blinding
 * nonces. Nothing describes a real lawyer approval, a Qwen run or an on-chain receipt.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { canonicalize as libraryJcs } from 'json-canonicalize';

const PACKAGE_DOMAIN = 'lexaegis:review-package:v1';
const COMMITMENT_DOMAIN = 'lexaegis:review-commitment:v1';

const CHAIN_ID = '31337';
const REGISTRY = `0x${'11'.repeat(20)}`;
const REVIEWER = `0x${'22'.repeat(20)}`;

const sha256 = (...parts) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};
const hex = (buffer) => `0x${Buffer.from(buffer).toString('hex')}`;
const text = (value) => Buffer.from(value, 'utf8');
const sequence = (start) => Buffer.from(Array.from({ length: 32 }, (_, index) => start + index));
const uuid = (group, index) => `${group}0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

/** Minimal RFC 8785 serializer for the subset manifests use: null, strings, arrays, objects. */
function minimalJcs(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(minimalJcs).join(',')}]`;
  if (typeof value === 'object') {
    // Array.prototype.sort without a comparator orders by UTF-16 code unit, as JCS requires.
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${minimalJcs(value[key])}`);
    return `{${members.join(',')}}`;
  }
  throw new Error('value outside the manifest subset');
}

function canonicalBytes(manifest) {
  const own = minimalJcs(manifest);
  const library = libraryJcs(manifest);
  if (own !== library) throw new Error('independent canonicalizers disagree');
  return Buffer.from(own, 'utf8');
}

function artifact(id, role, mediaType, label, bytes) {
  return { ref: { id, role, mediaType, label }, bytes };
}

function buildCase({ id, description, packageId, profile, supersedes, artifacts, nonce }) {
  const manifest = {
    schema: 'lexaegis.review-package.v1',
    packageId,
    preparedAt: '2026-01-01T00:00:00.000Z',
    profile,
    context: { chainId: CHAIN_ID, registryAddress: REGISTRY, reviewerAddress: REVIEWER },
    supersedes,
    artifacts: artifacts.map(({ ref, bytes }) => ({
      ...ref,
      byteLength: String(bytes.length),
      sha256: hex(sha256(bytes)),
    })),
    approval: {
      intent: 'approve-review-package',
      scopeArtifactIds: artifacts.map(({ ref }) => ref.id),
      decisionLogArtifactId: artifacts.find(({ ref }) => ref.role === 'decision-log').ref.id,
    },
  };
  const canonical = canonicalBytes(manifest);
  const packageDigest = sha256(text(PACKAGE_DOMAIN), Buffer.from([0x00]), canonical);
  const commitment = sha256(text(COMMITMENT_DOMAIN), Buffer.from([0x00]), nonce, packageDigest);
  const reference = {
    schema: 'lexaegis.receipt-ref.v1',
    chainId: CHAIN_ID,
    registryAddress: REGISTRY,
    reviewerAddress: REVIEWER,
    commitment: hex(commitment),
  };
  return {
    id,
    description,
    artifacts: artifacts.map(({ ref, bytes }) => ({
      id: ref.id,
      bytesBase64: bytes.toString('base64'),
    })),
    opening: { schema: 'lexaegis.opening.v1', manifest, blindingNonce: hex(nonce) },
    expected: {
      canonicalManifestUtf8Hex: hex(canonical),
      artifactDigests: Object.fromEntries(
        artifacts.map(({ ref, bytes }) => [ref.id, hex(sha256(bytes))]),
      ),
      packageDigest: hex(packageDigest),
      commitment: hex(commitment),
      reference,
    },
  };
}

const json = (value) => text(`${JSON.stringify(value)}\n`);

// --- Case 1: generic, non-legal package ----------------------------------------------------
const generic = buildCase({
  id: 'generic',
  description: 'SYNTHETIC generic review package with a non-ASCII label and CRLF bytes.',
  packageId: uuid('a', 1),
  profile: { id: 'example.generic-review', version: '1' },
  supersedes: null,
  nonce: sequence(0x00),
  artifacts: [
    artifact(
      uuid('a', 11),
      'source',
      'text/plain',
      'SYNTHETIC source — café ☕ 😀',
      text('SYNTHETIC TEST DOCUMENT\r\nNot a real review. Line endings are part of the bytes.\n'),
    ),
    artifact(
      uuid('a', 12),
      'decision-log',
      'application/json',
      null,
      // Deliberately irregular whitespace: structured artifacts are hashed as stored, not reserialized.
      text('{ "synthetic" : true,\n  "decision":"test-only" }\n'),
    ),
  ],
});

// --- Case 2: structurally complete legal reference package -----------------------------------
const pdfLike = Buffer.concat([
  text('%PDF-1.4\n% SYNTHETIC FIXTURE - not a real PDF or agreement\n'),
  Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
]);
const rulePack = json({ synthetic: true, rulePack: 'fixture-only', status: 'demo_draft' });
const checklist = json({ synthetic: true, missingEvidence: ['adviser-certificate'] });
const agentConfig = json({ synthetic: true, modelExecution: 'none' });
const analysis = json({
  synthetic: true,
  findings: ['payment schedule differs from stated total'],
});

const legal = buildCase({
  id: 'legal',
  description: 'SYNTHETIC package structurally complete for lexaegis.employment-settlement.ew v1.',
  packageId: uuid('b', 1),
  profile: { id: 'lexaegis.employment-settlement.ew', version: '1' },
  supersedes: null,
  nonce: sequence(0x20),
  artifacts: [
    artifact(
      uuid('b', 11),
      'source',
      'application/pdf',
      'SYNTHETIC settlement agreement v1',
      pdfLike,
    ),
    artifact(
      uuid('b', 12),
      'extracted-text',
      'text/plain',
      null,
      text('SYNTHETIC: Total £24,000. Instalments £10,000 and £12,000.\n'),
    ),
    artifact(uuid('b', 13), 'analysis', 'application/json', null, analysis),
    artifact(
      uuid('b', 14),
      'calculation',
      'application/json',
      null,
      json({ statedTotal: '2400000', comparableSum: '2200000', difference: '200000' }),
    ),
    artifact(uuid('b', 15), 'rule-pack', 'application/json', null, rulePack),
    artifact(uuid('b', 16), 'checklist', 'application/json', null, checklist),
    artifact(uuid('b', 17), 'agent-config', 'application/json', null, agentConfig),
    artifact(
      uuid('b', 18),
      'decision-log',
      'application/json',
      null,
      json({ synthetic: true, decision: 'accepted unresolved concern (test-only)' }),
    ),
  ],
});

// --- Case 3: revised document, declaring case 2 as its predecessor ---------------------------
const revised = buildCase({
  id: 'legal-revised',
  description:
    'SYNTHETIC revision with changed source bytes that declares "legal" as its predecessor.',
  packageId: uuid('c', 1),
  profile: { id: 'lexaegis.employment-settlement.ew', version: '1' },
  supersedes: legal.expected.reference,
  nonce: sequence(0x40),
  artifacts: [
    artifact(
      uuid('c', 11),
      'source',
      'application/pdf',
      'SYNTHETIC settlement agreement v2',
      Buffer.concat([pdfLike, text('\n% SYNTHETIC revision: second instalment corrected\n')]),
    ),
    artifact(
      uuid('c', 12),
      'extracted-text',
      'text/plain',
      null,
      text('SYNTHETIC: Total £24,000. Instalments £10,000 and £14,000.\n'),
    ),
    artifact(uuid('b', 13), 'analysis', 'application/json', null, analysis),
    artifact(
      uuid('c', 14),
      'calculation',
      'application/json',
      null,
      json({ statedTotal: '2400000', comparableSum: '2400000', difference: '0' }),
    ),
    artifact(uuid('b', 15), 'rule-pack', 'application/json', null, rulePack),
    artifact(uuid('b', 16), 'checklist', 'application/json', null, checklist),
    artifact(uuid('b', 17), 'agent-config', 'application/json', null, agentConfig),
    artifact(
      uuid('c', 18),
      'decision-log',
      'application/json',
      null,
      json({ synthetic: true, decision: 'approved corrected version (test-only)' }),
    ),
  ],
});

const vectors = {
  $comment:
    'SYNTHETIC protocol v1 test vectors. Generated by fixtures/protocol-v1/generate.mjs, independently of the implementation. Blinding nonces are FIXED for testing and must never be used in production. Do not edit by hand.',
  format: 'lexaegis.protocol-v1.test-vectors/1',
  domains: { package: PACKAGE_DOMAIN, commitment: COMMITMENT_DOMAIN },
  cases: [generic, legal, revised],
};

const path = join(dirname(fileURLToPath(import.meta.url)), 'vectors.json');
const output = `${JSON.stringify(vectors, null, 2)}\n`;

function readOrNull(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

if (process.argv.includes('--check')) {
  if (readOrNull(path) !== output) {
    console.error('fixtures/protocol-v1/vectors.json is not reproducible from generate.mjs');
    process.exit(1);
  }
  console.log('fixtures/protocol-v1/vectors.json is reproducible');
} else {
  writeFileSync(path, output);
  console.log(`wrote ${vectors.cases.length} cases to fixtures/protocol-v1/vectors.json`);
}
