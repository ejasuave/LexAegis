import { describe, expect, it, vi } from 'vitest';
import { bytesToHex } from './bytes';
import { canonicalizeReviewPackage } from './canonicalize';
import { computeCommitment } from './commitment';
import { COMMITMENT_DOMAIN, PACKAGE_DOMAIN } from './constants';
import { artifactDigest, describeArtifact, packageDigest } from './hashes';
import { prepareReviewPackage } from './prepare';
import { artifactMap, decodeBase64, encodeUtf8, expectOk, getCase, vectors } from './test-helpers';
import { verifyManifestOpening, verifyReviewPackage } from './verify';

/*
 * Shared interoperability vectors. This file runs unchanged in Node.js and in real Chromium
 * (pnpm test:protocol:browser), each using its own Web Crypto implementation. Expected values
 * are literals produced independently by fixtures/protocol-v1/generate.mjs.
 */

describe('known-answer SHA-256 (FIPS 180-4 examples)', () => {
  it('hashes the empty message and "abc"', async () => {
    expect(await artifactDigest(new Uint8Array(0))).toBe(
      '0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await artifactDigest(encodeUtf8('abc'))).toBe(
      '0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('protocol v1 vectors', () => {
  it('uses the domain strings the independent generator used', () => {
    expect(PACKAGE_DOMAIN).toBe(vectors.domains.package);
    expect(COMMITMENT_DOMAIN).toBe(vectors.domains.commitment);
    expect(vectors.cases.map((item) => item.id)).toEqual(['generic', 'legal', 'legal-revised']);
  });

  describe.each(vectors.cases.map((item) => [item.id, item] as const))('%s', (_id, vector) => {
    const { opening, expected } = vector;

    it('reproduces the literal canonical UTF-8 bytes', () => {
      const canonical = canonicalizeReviewPackage(opening.manifest);
      expect(bytesToHex(canonical)).toBe(expected.canonicalManifestUtf8Hex);
      expect(canonical[0]).toBe(0x7b); // "{": no byte-order mark
    });

    it('reproduces every artifact digest from the original bytes', async () => {
      for (const item of vector.artifacts) {
        const bytes = decodeBase64(item.bytesBase64);
        expect(await artifactDigest(bytes)).toBe(expected.artifactDigests[item.id]);
        const reference = opening.manifest.artifacts.find((artifact) => artifact.id === item.id);
        expect(reference).toBeDefined();
        if (reference === undefined) continue;
        // byteLength and sha256 are computed from bytes and equal the committed reference.
        expect(
          await describeArtifact(
            {
              id: reference.id,
              role: reference.role,
              mediaType: reference.mediaType,
              label: reference.label,
            },
            bytes,
          ),
        ).toEqual(reference);
      }
    });

    it('reproduces the package digest and commitment', async () => {
      const digest = await packageDigest(canonicalizeReviewPackage(opening.manifest));
      expect(digest).toBe(expected.packageDigest);
      expect(await computeCommitment(opening.blindingNonce, digest)).toBe(expected.commitment);
      expect(expected.reference.commitment).toBe(expected.commitment);
    });

    it('verifies the opening and the full package against the literal public reference', async () => {
      expect(expectOk(await verifyManifestOpening(opening, expected.reference))).toEqual({
        manifestIntegrity: 'match',
        artifactIntegrity: 'unknown',
        chainStatus: 'unknown',
        signerAcceptance: 'unknown',
        issues: [],
      });
      expect(
        expectOk(await verifyReviewPackage(opening, artifactMap(vector), expected.reference)),
      ).toEqual({
        manifestIntegrity: 'match',
        artifactIntegrity: 'match',
        chainStatus: 'unknown',
        signerAcceptance: 'unknown',
        issues: [],
      });
    });

    it('accepts the same package as raw JSON text and bytes', async () => {
      const text = JSON.stringify(opening, null, 2);
      expect(
        expectOk(await verifyManifestOpening(text, expected.reference)).manifestIntegrity,
      ).toBe('match');
      expect(
        expectOk(await verifyManifestOpening(encodeUtf8(text), JSON.stringify(expected.reference)))
          .manifestIntegrity,
      ).toBe('match');
    });

    it('prepares a fresh snapshot with the same digest and a self-consistent commitment', async () => {
      const prepared = expectOk(await prepareReviewPackage(opening.manifest, artifactMap(vector)));
      expect(prepared.packageDigest).toBe(expected.packageDigest);
      expect(bytesToHex(prepared.canonicalManifestBytes())).toBe(expected.canonicalManifestUtf8Hex);
      expect(prepared.opening.manifest).toEqual(opening.manifest);
      expect(await computeCommitment(prepared.opening.blindingNonce, prepared.packageDigest)).toBe(
        prepared.reference.commitment,
      );
      // A fresh random nonce, not the fixed test nonce.
      expect(prepared.opening.blindingNonce).not.toBe(opening.blindingNonce);
      expect(prepared.reference.commitment).not.toBe(expected.commitment);
      expect(
        expectOk(
          await verifyReviewPackage(prepared.opening, prepared.artifacts(), prepared.reference),
        ),
      ).toMatchObject({ manifestIntegrity: 'match', artifactIntegrity: 'match' });
    });
  });

  it('the revised package declares the legal package as its predecessor', () => {
    expect(getCase('legal-revised').opening.manifest.supersedes).toEqual(
      getCase('legal').expected.reference,
    );
    expect(getCase('legal').opening.manifest.supersedes).toBeNull();
  });
});

describe('runtime', () => {
  it('uses the platform Web Crypto implementation, not a mock or polyfill', () => {
    const { subtle } = globalThis.crypto;
    expect(subtle).toBeInstanceOf(SubtleCrypto);
    const digest: unknown = Reflect.get(subtle, 'digest');
    expect(typeof digest).toBe('function');
    expect(vi.isMockFunction(digest)).toBe(false);
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      // In the browser harness this must be a real Chromium page with a native digest.
      expect(navigator.userAgent).toMatch(/Chrome\/\d+/);
      expect(Function.prototype.toString.call(digest)).toContain('[native code]');
      expect(typeof process).toBe('undefined');
    }
  });
});
