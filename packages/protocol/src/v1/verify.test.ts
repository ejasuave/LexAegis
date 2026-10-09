import { describe, expect, it } from 'vitest';
import { describeArtifact } from './hashes';
import { prepareReviewPackage } from './prepare';
import type { CommitmentOpeningV1, ReviewPackageV1 } from './schemas';
import {
  artifactMap,
  at,
  encodeUtf8,
  expectOk,
  failureCode,
  getCase,
  manifestOf,
  openingOf,
} from './test-helpers';
import {
  packageVerificationV1Schema,
  verifyManifestOpening,
  verifyReviewPackage,
  type PackageVerificationV1,
} from './verify';

const legal = getCase('legal');
const revised = getCase('legal-revised');
const reference = legal.expected.reference;
const other = `0x${'33'.repeat(20)}`;

const codes = (result: PackageVerificationV1) => result.issues.map((issue) => issue.code);

async function manifestCheck(opening: unknown, expected: unknown = reference) {
  return expectOk(await verifyManifestOpening(opening, expected));
}

/** Tampers with the manifest inside the original opening and verifies against the original reference. */
async function tampered(mutate: (manifest: ReviewPackageV1) => void, vector = legal) {
  const opening = openingOf(vector);
  mutate(opening.manifest);
  return manifestCheck(opening, vector.expected.reference);
}

describe('manifest-only verification', () => {
  it('never claims artifact, chain or signer verification', async () => {
    const result = await manifestCheck(legal.opening);
    expect(result).toEqual({
      manifestIntegrity: 'match',
      artifactIntegrity: 'unknown',
      chainStatus: 'unknown',
      signerAcceptance: 'unknown',
      issues: [],
    });
  });

  it('has no generic valid flag, and the result schema is closed', async () => {
    const result = await manifestCheck(legal.opening);
    expect(Object.keys(result)).not.toContain('valid');
    expect(packageVerificationV1Schema.safeParse(result).success).toBe(true);
    expect(packageVerificationV1Schema.safeParse({ ...result, valid: true }).success).toBe(false);
    expect(
      packageVerificationV1Schema.safeParse({ ...result, chainStatus: 'active' }).success,
    ).toBe(false);
    expect(
      packageVerificationV1Schema.safeParse({ ...result, signerAcceptance: 'accepted' }).success,
    ).toBe(false);
  });

  it('a wrong nonce is a mismatch; a missing or malformed nonce is a typed failure', async () => {
    const wrong = { ...openingOf(legal), blindingNonce: `0x${'00'.repeat(32)}` };
    const result = await manifestCheck(wrong);
    expect(result.manifestIntegrity).toBe('mismatch');
    expect(codes(result)).toEqual(['COMMITMENT_MISMATCH']);

    const { blindingNonce: _nonce, ...missing } = openingOf(legal);
    expect(failureCode(await verifyManifestOpening(missing, reference))).toBe('SCHEMA_INVALID');
    expect(
      failureCode(
        await verifyManifestOpening(
          { ...openingOf(legal), blindingNonce: legal.opening.blindingNonce.toUpperCase() },
          reference,
        ),
      ),
    ).toBe('SCHEMA_INVALID');
  });

  it('requires the caller’s expected reference and never trusts the opening’s own claims', async () => {
    expect(failureCode(await verifyManifestOpening(legal.opening, undefined))).toBe(
      'UNSUPPORTED_VALUE',
    );
    expect(failureCode(await verifyManifestOpening(legal.opening, null))).toBe('SCHEMA_INVALID');
    expect(
      failureCode(await verifyManifestOpening(legal.opening, { ...reference, commitment: 'nope' })),
    ).toBe('SCHEMA_INVALID');
    // A different, internally consistent package does not verify against this reference.
    const result = await manifestCheck(getCase('generic').opening);
    expect(result.manifestIntegrity).toBe('mismatch');
  });

  it.each([
    ['chain', { chainId: '1' }],
    ['registry', { registryAddress: other }],
    ['reviewer', { reviewerAddress: other }],
  ])(
    'a wrong expected %s is a context mismatch even though the commitment still matches',
    async (_label, change) => {
      const result = await manifestCheck(legal.opening, { ...reference, ...change });
      expect(result.manifestIntegrity).toBe('mismatch');
      expect(codes(result)).toEqual(['CONTEXT_MISMATCH']);
    },
  );

  it.each<[string, (manifest: ReviewPackageV1) => void]>([
    ['context chain', (m) => (m.context.chainId = '1')],
    ['context registry', (m) => (m.context.registryAddress = other)],
    ['context reviewer', (m) => (m.context.reviewerAddress = other)],
    ['profile id', (m) => (m.profile.id = 'example.other')],
    ['profile version', (m) => (m.profile.version = '2')],
    ['package id', (m) => (m.packageId = 'f0000000-0000-4000-8000-000000000001')],
    ['prepared time', (m) => (m.preparedAt = '2026-01-01T00:00:00.001Z')],
    ['source document digest', (m) => (at(m.artifacts, 0).sha256 = `0x${'11'.repeat(32)}`)],
    ['analysis (findings) digest', (m) => (at(m.artifacts, 2).sha256 = `0x${'11'.repeat(32)}`)],
    ['rule-pack digest', (m) => (at(m.artifacts, 4).sha256 = `0x${'11'.repeat(32)}`)],
    [
      'agent-config (model configuration) digest',
      (m) => (at(m.artifacts, 6).sha256 = `0x${'11'.repeat(32)}`),
    ],
    ['decision-log digest', (m) => (at(m.artifacts, 7).sha256 = `0x${'11'.repeat(32)}`)],
    ['label', (m) => (at(m.artifacts, 0).label = 'SYNTHETIC settlement agreement v1 ')],
    ['label removed', (m) => (at(m.artifacts, 0).label = null)],
    ['media type', (m) => (at(m.artifacts, 0).mediaType = 'application/octet-stream')],
    ['artifact order', (m) => m.artifacts.reverse()],
    ['scope order', (m) => m.approval.scopeArtifactIds.reverse()],
  ])('changing the %s invalidates the original opening', async (_label, mutate) => {
    const result = await tampered(mutate);
    expect(result.manifestIntegrity).toBe('mismatch');
    expect(codes(result)).toContain('COMMITMENT_MISMATCH');
  });

  it('changing or adding a predecessor invalidates the original opening', async () => {
    const added = await tampered(
      (m) => (m.supersedes = structuredClone(revised.opening.manifest.supersedes)),
    );
    expect(added.manifestIntegrity).toBe('mismatch');
    const changed = await tampered((m) => {
      if (m.supersedes) m.supersedes.commitment = `0x${'11'.repeat(32)}`;
    }, revised);
    expect(changed.manifestIntegrity).toBe('mismatch');
    const removed = await tampered((m) => (m.supersedes = null), revised);
    expect(removed.manifestIntegrity).toBe('mismatch');
  });

  it('rejects unsupported versions and malformed openings as typed failures', async () => {
    expect(
      failureCode(
        await verifyManifestOpening(
          { ...openingOf(legal), schema: 'lexaegis.opening.v2' },
          reference,
        ),
      ),
    ).toBe('UNSUPPORTED_VERSION');
    expect(
      failureCode(await verifyManifestOpening('{"schema":"lexaegis.opening.v1",}', reference)),
    ).toBe('INVALID_JSON');
    expect(failureCode(await verifyManifestOpening(encodeUtf8('{"a":1,"a":2}'), reference))).toBe(
      'DUPLICATE_KEY',
    );
    expect(
      failureCode(await verifyManifestOpening({ ...openingOf(legal), extra: true }, reference)),
    ).toBe('UNKNOWN_FIELD');
  });
});

describe('full-package verification', () => {
  const firstId = at(legal.artifacts, 0).id;

  async function full(
    artifacts: Iterable<readonly [string, Uint8Array]>,
    opening: CommitmentOpeningV1 = legal.opening,
  ) {
    return expectOk(await verifyReviewPackage(opening, artifacts, reference));
  }

  it('detects altered bytes in any artifact and names only its opaque ID', async () => {
    for (const index of [0, 2, 4, 6, 7]) {
      const target = at(legal.artifacts, index).id;
      const artifacts = artifactMap(legal);
      const bytes = artifacts.get(target);
      expect(bytes).toBeDefined();
      if (bytes === undefined) continue;
      bytes[0] = (at([...bytes], 0) + 1) % 256;
      const result = await full(artifacts);
      expect(result.manifestIntegrity).toBe('match');
      expect(result.artifactIntegrity).toBe('mismatch');
      expect(result.issues).toEqual([{ code: 'ARTIFACT_DIGEST_MISMATCH', artifactId: target }]);
    }
  });

  it('detects a changed length without hashing', async () => {
    const artifacts = artifactMap(legal);
    artifacts.set(firstId, new Uint8Array(3));
    const result = await full(artifacts);
    expect(result.artifactIntegrity).toBe('mismatch');
    expect(result.issues).toEqual([{ code: 'ARTIFACT_LENGTH_MISMATCH', artifactId: firstId }]);
  });

  it('treats missing files as unknown, not as a mismatch and not as a match', async () => {
    const artifacts = artifactMap(legal);
    artifacts.delete(firstId);
    const result = await full(artifacts);
    expect(result.manifestIntegrity).toBe('match');
    expect(result.artifactIntegrity).toBe('unknown');
    expect(result.issues).toEqual([{ code: 'ARTIFACT_MISSING', artifactId: firstId }]);

    const none = await full(new Map());
    expect(none.artifactIntegrity).toBe('unknown');
    expect(none.issues).toHaveLength(legal.artifacts.length);
  });

  it('rejects uncommitted extra files instead of treating them as approved evidence', async () => {
    const artifacts = artifactMap(legal);
    artifacts.set('e0000000-0000-4000-8000-000000000099', new Uint8Array([1]));
    const result = await full(artifacts);
    expect(result.artifactIntegrity).toBe('mismatch');
    expect(result.issues).toEqual([
      { code: 'ARTIFACT_NOT_IN_MANIFEST', artifactId: 'e0000000-0000-4000-8000-000000000099' },
    ]);
    const named = artifactMap(legal);
    named.set('appendix.pdf', new Uint8Array([1]));
    expect((await full(named)).issues).toEqual([{ code: 'ARTIFACT_NOT_IN_MANIFEST' }]);
  });

  it('a mismatch outranks a missing file', async () => {
    const artifacts = artifactMap(legal);
    artifacts.delete(firstId);
    const second = at(legal.artifacts, 1).id;
    artifacts.set(second, new Uint8Array(1));
    const result = await full(artifacts);
    expect(result.artifactIntegrity).toBe('mismatch');
    expect(codes(result).sort()).toEqual(['ARTIFACT_LENGTH_MISMATCH', 'ARTIFACT_MISSING']);
  });

  it('does not evaluate files when the manifest does not open the expected commitment', async () => {
    // Files and manifest rewritten together: internally consistent, but not the committed package.
    const artifacts = artifactMap(legal);
    const replacement = encodeUtf8('SYNTHETIC replacement document');
    artifacts.set(firstId, replacement);
    const manifest = manifestOf(legal);
    const original = at(manifest.artifacts, 0);
    manifest.artifacts[0] = await describeArtifact(
      {
        id: original.id,
        role: original.role,
        mediaType: original.mediaType,
        label: original.label,
      },
      replacement,
    );
    const result = await full(artifacts, { ...openingOf(legal), manifest });
    expect(result.manifestIntegrity).toBe('mismatch');
    expect(result.artifactIntegrity).toBe('unknown');
    expect(codes(result)).toEqual(['COMMITMENT_MISMATCH', 'ARTIFACTS_NOT_EVALUATED']);
  });

  it('a wholly re-prepared package verifies only against its own new reference', async () => {
    const artifacts = artifactMap(legal);
    const fresh = expectOk(await prepareReviewPackage(legal.opening.manifest, artifacts));
    expect((await full(fresh.artifacts(), fresh.opening)).manifestIntegrity).toBe('mismatch');
    const own = expectOk(
      await verifyReviewPackage(fresh.opening, fresh.artifacts(), fresh.reference),
    );
    expect(own).toMatchObject({ manifestIntegrity: 'match', artifactIntegrity: 'match' });
  });

  it('redacted bytes do not verify as the original artifact', async () => {
    const artifacts = artifactMap(legal);
    const bytes = artifacts.get(firstId);
    expect(bytes).toBeDefined();
    if (bytes === undefined) return;
    artifacts.set(firstId, bytes.slice().fill(0x58, 8, 40)); // same length, content blanked
    expect((await full(artifacts)).artifactIntegrity).toBe('mismatch');
  });

  it('returns typed failures for malformed artifact input', async () => {
    const entries = [...artifactMap(legal)];
    expect(
      failureCode(
        await verifyReviewPackage(legal.opening, [...entries, at(entries, 0)], reference),
      ),
    ).toBe('ARTIFACT_DUPLICATE');
    const bad = new Map<string, unknown>(entries);
    bad.set(firstId, 'not bytes');
    expect(
      failureCode(
        await verifyReviewPackage(legal.opening, bad as Map<string, Uint8Array>, reference),
      ),
    ).toBe('ARTIFACT_INPUT_INVALID');
  });

  it('is unaffected by mutation of supplied bytes after the call', async () => {
    const artifacts = artifactMap(legal);
    const pending = verifyReviewPackage(legal.opening, artifacts, reference);
    for (const bytes of artifacts.values()) bytes.fill(0);
    expect(expectOk(await pending)).toMatchObject({
      manifestIntegrity: 'match',
      artifactIntegrity: 'match',
    });
  });
});
