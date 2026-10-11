import { describe, expect, it } from 'vitest';
import asset from '../../test-vectors/protocol-v1.json';
import original from '../../../../fixtures/protocol-v1/vectors.json';
import { utf8 } from '../v1/bytes';
import { COMMITMENT_DOMAIN, PACKAGE_DOMAIN } from '../v1/constants';
import { STAGES_OF_CODE, decode, outcomeOf, type Encoded, type VectorCase } from './run-case';

/*
 * Runs every published case of packages/protocol/test-vectors/protocol-v1.json against the
 * implementation. It runs unchanged in Node and in real Chromium. Expected values are literals from
 * the independent generators; this file computes none of them and never writes the asset.
 */

const cases = asset.cases as unknown as readonly VectorCase[];

/** Compares what the implementation produced with the case's literal expectation. */
async function check(vector: VectorCase): Promise<void> {
  const actual = await outcomeOf(vector);
  const { stage, ...expected } = vector.expected;
  if (expected.outcome === 'error') {
    expect(actual.outcome, vector.id).toBe('error');
    expect(actual.code, vector.id).toBe(expected.code);
    // A rejection at the wrong stage is not a passing negative case.
    expect(STAGES_OF_CODE[expected.code ?? ''], vector.id).toContain(vector.stage);
    expect(stage).toBe(vector.stage);
    return;
  }
  expect(actual, vector.id).toEqual(expected);
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
      await check(vector);
    });
  });

  it('has a lexical-only helper for utf8 that rejects lone surrogates instead of replacing them', () => {
    expect(() => utf8('\ud800')).toThrow();
  });
});
