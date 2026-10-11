import { describe, expect, it } from 'vitest';
import asset from '../../test-vectors/protocol-v1.json';
import original from '../../../../fixtures/protocol-v1/vectors.json';
import { bytesToHex, hexToBytes, utf8 } from '../v1/bytes';
import { canonicalizeJson, canonicalizeReviewPackage } from '../v1/canonicalize';
import { computeCommitment } from '../v1/commitment';
import { COMMITMENT_DOMAIN, PACKAGE_DOMAIN } from '../v1/constants';
import { artifactDigest, packageDigest } from '../v1/hashes';
import { parseStrictJson } from '../v1/parse-json';
import { parseCommitmentOpening, parseReceiptReference } from '../v1/parse';
import { verifyReviewPackage } from '../v1/verify';

/*
 * Runs every published case of packages/protocol/test-vectors/protocol-v1.json against the
 * implementation. It runs unchanged in Node and in real Chromium. Expected values are literals from
 * the independent generators; this file computes none of them and never writes the asset.
 */

type Encoded = { readonly encoding: 'utf8' | 'hex' | 'base64'; readonly value: string };
interface Expected {
  readonly outcome: 'ok' | 'error';
  readonly stage?: string;
  readonly code?: string;
  readonly canonicalUtf8Hex?: string;
  readonly digest?: string;
  readonly commitment?: string;
  readonly manifestIntegrity?: string;
  readonly artifactIntegrity?: string;
  readonly issues?: readonly { readonly code: string; readonly artifactId?: string }[];
}
interface VectorCase {
  readonly id: string;
  readonly stage: string;
  readonly operation: string;
  readonly input: Record<string, unknown>;
  readonly expected: Expected;
}

const cases = asset.cases as unknown as readonly VectorCase[];

function decode(input: Encoded): Uint8Array<ArrayBuffer> {
  if (input.encoding === 'utf8') return new TextEncoder().encode(input.value);
  if (input.encoding === 'hex') return hexToBytes(input.value);
  return Uint8Array.from(atob(input.value), (character) => character.charCodeAt(0));
}

/** Which stages an error code may legitimately belong to (see test-vectors/README.md). */
const STAGES_OF_CODE: Readonly<Record<string, readonly string[]>> = {
  INPUT_TOO_LARGE: ['strict-json'],
  INVALID_UTF8: ['strict-json'],
  BYTE_ORDER_MARK: ['strict-json'],
  INVALID_JSON: ['strict-json'],
  DUPLICATE_KEY: ['strict-json'],
  NESTING_TOO_DEEP: ['strict-json'],
  UNSAFE_NUMBER: ['strict-json'],
  LONE_SURROGATE: ['strict-json'],
  FORBIDDEN_KEY: ['strict-json'],
  UNSUPPORTED_VERSION: ['version'],
  SCHEMA_INVALID: ['version', 'schema'],
  UNKNOWN_FIELD: ['schema'],
  TOO_MANY_ARTIFACTS: ['schema'],
  ARTIFACT_TOO_LARGE: ['schema'],
  DUPLICATE_ARTIFACT_ID: ['cross-field'],
  SOURCE_ARTIFACT_REQUIRED: ['cross-field'],
  DECISION_LOG_ARTIFACT_INVALID: ['cross-field'],
  DUPLICATE_SCOPE_ID: ['cross-field'],
  UNRESOLVED_ARTIFACT_REFERENCE: ['cross-field'],
  SCOPE_INCOMPLETE: ['cross-field'],
  DECISION_LOG_REFERENCE_INVALID: ['cross-field'],
  SUPERSEDES_CONTEXT_MISMATCH: ['cross-field'],
  ARTIFACTS_TOO_LARGE: ['cross-field'],
};

function expectError(
  result: { readonly ok: boolean; readonly error?: { readonly code: string } },
  vector: VectorCase,
): void {
  expect(result.ok, vector.id).toBe(false);
  expect(result.error?.code, vector.id).toBe(vector.expected.code);
  // A rejection at the wrong stage is not a passing negative case.
  expect(STAGES_OF_CODE[vector.expected.code ?? ''], vector.id).toContain(vector.stage);
  expect(vector.expected.stage).toBe(vector.stage);
}

async function run(vector: VectorCase): Promise<void> {
  const input = vector.input;
  switch (vector.operation) {
    case 'canonicalize-json': {
      const value = parseStrictJson(decode(input as Encoded));
      expect(bytesToHex(canonicalizeJson(value)), vector.id).toBe(vector.expected.canonicalUtf8Hex);
      return;
    }
    case 'canonical-manifest': {
      const opening = parseCommitmentOpening(decode(input as Encoded));
      expect(opening.ok, vector.id).toBe(true);
      if (!opening.ok) return;
      expect(bytesToHex(canonicalizeReviewPackage(opening.data.manifest)), vector.id).toBe(
        vector.expected.canonicalUtf8Hex,
      );
      return;
    }
    case 'artifact-digest':
      expect(await artifactDigest(decode(input as Encoded)), vector.id).toBe(
        vector.expected.digest,
      );
      return;
    case 'package-digest':
      expect(await packageDigest(decode(input as Encoded)), vector.id).toBe(vector.expected.digest);
      return;
    case 'commitment': {
      const { blindingNonce, packageDigest: digest } = input as {
        blindingNonce: string;
        packageDigest: string;
      };
      expect(await computeCommitment(blindingNonce, digest), vector.id).toBe(
        vector.expected.commitment,
      );
      return;
    }
    case 'parse-opening': {
      const result = parseCommitmentOpening(decode(input as unknown as Encoded));
      if (vector.expected.outcome === 'ok') expect(result.ok, vector.id).toBe(true);
      else expectError(result, vector);
      return;
    }
    case 'parse-reference': {
      const result = parseReceiptReference(decode(input as unknown as Encoded));
      if (vector.expected.outcome === 'ok') expect(result.ok, vector.id).toBe(true);
      else expectError(result, vector);
      return;
    }
    case 'verify-package': {
      const verification = input as {
        opening: Encoded;
        artifacts: (Encoded & { id: string })[];
        expectedReference: Encoded;
      };
      const supplied = new Map(verification.artifacts.map((item) => [item.id, decode(item)]));
      const result = await verifyReviewPackage(
        decode(verification.opening),
        supplied,
        decode(verification.expectedReference),
      );
      if (vector.expected.outcome === 'error') {
        expectError(result, vector);
        return;
      }
      expect(result.ok, vector.id).toBe(true);
      if (!result.ok) return;
      expect(result.data.manifestIntegrity, vector.id).toBe(vector.expected.manifestIntegrity);
      expect(result.data.artifactIntegrity, vector.id).toBe(vector.expected.artifactIntegrity);
      expect(result.data.issues, vector.id).toEqual(vector.expected.issues);
      // Offline verification can never establish a chain or signer result.
      expect(result.data.chainStatus).toBe('unknown');
      expect(result.data.signerAcceptance).toBe('unknown');
      return;
    }
    default:
      throw new Error(`unsupported operation ${vector.operation} in ${vector.id}`);
  }
}

describe('published protocol v1 test vectors', () => {
  it('names the same domain separators as the implementation', () => {
    expect(asset.domains.package).toBe(PACKAGE_DOMAIN);
    expect(asset.domains.commitment).toBe(COMMITMENT_DOMAIN);
  });

  it('carries the original Chapter 2 goldens unchanged', () => {
    // Compared with the file the independent generator wrote, not with anything computed here.
    expect(asset.goldens).toEqual(original.cases);
    expect(asset.goldens.map((item) => item.id)).toEqual(['generic', 'legal', 'legal-revised']);
  });

  it('covers every documented operation, stage and the required negative categories', () => {
    expect(new Set(cases.map((item) => item.operation))).toEqual(
      new Set([
        'canonicalize-json',
        'canonical-manifest',
        'artifact-digest',
        'package-digest',
        'commitment',
        'parse-opening',
        'parse-reference',
        'verify-package',
      ]),
    );
    expect(new Set(cases.map((item) => item.stage))).toEqual(
      new Set([
        'canonicalization',
        'digest',
        'commitment',
        'strict-json',
        'version',
        'schema',
        'cross-field',
        'verification',
      ]),
    );
    const ids = new Set(cases.map((item) => item.id));
    expect(ids.size).toBe(cases.length);
    for (const required of [
      'neg-duplicate-key',
      'neg-duplicate-key-escaped',
      'neg-invalid-utf8',
      'neg-bom-bytes',
      'neg-number-unsafe-integer',
      'neg-version-opening',
      'neg-unknown-field-top',
      'neg-digest-uppercase',
      'neg-nonce-short',
      'neg-too-many-artifacts',
      'neg-cross-scope-incomplete',
      'verify-wrong-commitment',
      'canon-non-bmp-order',
      'canon-unicode-composed',
      'canon-unicode-decomposed',
    ]) {
      expect(ids.has(required), required).toBe(true);
    }
  });

  it('keeps case metadata out of protocol envelopes', () => {
    for (const vector of cases) {
      if (vector.operation === 'parse-opening' || vector.operation === 'parse-reference') {
        const text = new TextDecoder().decode(decode(vector.input as unknown as Encoded));
        for (const metadata of ['"stage"', '"operation"', '"expected"']) {
          expect(text.includes(metadata), `${vector.id} ${metadata}`).toBe(false);
        }
      }
    }
  });

  it('wrong input is accepted by no case: every case id is unique and every error names a stage', () => {
    for (const vector of cases.filter((item) => item.expected.outcome === 'error')) {
      expect(vector.expected.code, vector.id).toBeTruthy();
      expect(vector.expected.stage, vector.id).toBe(vector.stage);
    }
  });

  describe.each(cases.map((item) => [item.id, item] as const))('%s', (_id, vector) => {
    it('matches its literal expectation', async () => {
      await run(vector);
    });
  });

  it('has a lexical-only helper for utf8 that rejects lone surrogates instead of replacing them', () => {
    expect(() => utf8('\ud800')).toThrow();
  });
});
