import { describe, expect, it } from 'vitest';
import { OPENING_SCHEMA, PACKAGE_SCHEMA, REFERENCE_SCHEMA } from './constants';
import { parseCommitmentOpening, parseReceiptReference, parseReviewPackage } from './parse';
import {
  addressSchema,
  artifactByteLengthSchema,
  blindingNonceSchema,
  chainIdSchema,
  digestSchema,
  labelSchema,
  mediaTypeSchema,
  nonZeroAddressSchema,
  profileIdSchema,
  profileVersionSchema,
  timestampSchema,
  unsignedDecimalSchema,
  uuidSchema,
} from './primitives';
import { reviewPackageV1Schema, type ArtifactRefV1, type ReviewPackageV1 } from './schemas';
import { at, failureCode, getCase, manifestOf, openingOf } from './test-helpers';

const ok = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

const legal = getCase('legal');
const revised = getCase('legal-revised');

/** A fresh manifest, mutated by the callback, then parsed. */
function parsed(mutate: (manifest: ReviewPackageV1) => void, vector = legal) {
  const manifest = manifestOf(vector);
  mutate(manifest);
  return parseReviewPackage(manifest);
}

function artifact(index: number, overrides: Partial<ArtifactRefV1> = {}): ArtifactRefV1 {
  const suffix = String(index).padStart(12, '0');
  return {
    id: `d0000000-0000-4000-8000-${suffix}`,
    role: 'evidence',
    mediaType: 'text/plain',
    label: null,
    byteLength: '1',
    sha256: `0x${'ab'.repeat(32)}`,
    ...overrides,
  };
}

describe('v1 wire primitives', () => {
  it('UUID: lowercase version 4 only', () => {
    expect(ok(uuidSchema, 'a0000000-0000-4000-8000-000000000001')).toBe(true);
    expect(ok(uuidSchema, 'A0000000-0000-4000-8000-000000000001')).toBe(false);
    expect(ok(uuidSchema, 'a0000000-0000-1000-8000-000000000001')).toBe(false); // version 1
    expect(ok(uuidSchema, 'a0000000-0000-4000-c000-000000000001')).toBe(false); // bad variant
    expect(ok(uuidSchema, 'a000000000004000800000000000000001')).toBe(false);
  });

  it('address, digest and nonce: lowercase, exact length, 0x-prefixed', () => {
    expect(ok(addressSchema, `0x${'ab'.repeat(20)}`)).toBe(true);
    expect(ok(addressSchema, `0x${'AB'.repeat(20)}`)).toBe(false);
    expect(ok(addressSchema, `0x${'ab'.repeat(19)}`)).toBe(false);
    expect(ok(addressSchema, 'ab'.repeat(20))).toBe(false);
    expect(ok(addressSchema, `0x${'00'.repeat(20)}`)).toBe(true);
    expect(ok(nonZeroAddressSchema, `0x${'00'.repeat(20)}`)).toBe(false);
    for (const schema of [digestSchema, blindingNonceSchema]) {
      expect(ok(schema, `0x${'cd'.repeat(32)}`)).toBe(true);
      expect(ok(schema, `0x${'CD'.repeat(32)}`)).toBe(false);
      expect(ok(schema, `0x${'cd'.repeat(31)}`)).toBe(false);
      expect(ok(schema, `0x${'cd'.repeat(33)}`)).toBe(false);
      expect(ok(schema, `0x${'zz'.repeat(32)}`)).toBe(false);
    }
  });

  it('unsigned decimal and chain ID: canonical, bounded by uint256', () => {
    for (const bad of ['01', '+1', '-1', ' 1', '1 ', '1e3', '1.0', '', '0x10']) {
      expect(ok(unsignedDecimalSchema, bad)).toBe(false);
    }
    expect(ok(unsignedDecimalSchema, '0')).toBe(true);
    const max = (2n ** 256n - 1n).toString();
    expect(ok(chainIdSchema, '10143')).toBe(true);
    expect(ok(chainIdSchema, max)).toBe(true);
    expect(ok(chainIdSchema, (2n ** 256n).toString())).toBe(false);
    expect(ok(chainIdSchema, '0')).toBe(false);
    expect(ok(chainIdSchema, 10143)).toBe(false);
  });

  it('timestamp: valid UTC with exactly millisecond precision', () => {
    expect(ok(timestampSchema, '2026-10-08T17:00:00.000Z')).toBe(true);
    expect(ok(timestampSchema, '2028-02-29T23:59:59.999Z')).toBe(true);
    for (const bad of [
      '2026-10-08T17:00:00Z',
      '2026-10-08T17:00:00.00Z',
      '2026-10-08T17:00:00.0000Z',
      '2026-10-08T17:00:00.000+01:00',
      '2026-10-08t17:00:00.000z',
      '2026-10-08 17:00:00.000Z',
      '2026-02-30T00:00:00.000Z',
      '2027-02-29T00:00:00.000Z',
      '2026-13-01T00:00:00.000Z',
      '2026-10-08T24:00:00.000Z',
      '2026-10-08T23:60:00.000Z',
      '2026-10-08T23:59:60.000Z',
    ]) {
      expect(ok(timestampSchema, bad)).toBe(false);
    }
  });

  it('profile, media type, label and byte length', () => {
    expect(ok(profileIdSchema, 'lexaegis.employment-settlement.ew')).toBe(true);
    expect(ok(profileIdSchema, 'Example.Profile')).toBe(false);
    expect(ok(profileIdSchema, 'a'.repeat(81))).toBe(false);
    expect(ok(profileIdSchema, '')).toBe(false);
    expect(ok(profileVersionSchema, '1')).toBe(true);
    expect(ok(profileVersionSchema, '0')).toBe(false);
    expect(ok(profileVersionSchema, '01')).toBe(false);

    expect(ok(mediaTypeSchema, 'application/pdf')).toBe(true);
    expect(ok(mediaTypeSchema, 'application/vnd.example+json')).toBe(true);
    expect(ok(mediaTypeSchema, 'Application/PDF')).toBe(false);
    expect(ok(mediaTypeSchema, 'text/plain; charset=utf-8')).toBe(false);
    expect(ok(mediaTypeSchema, 'pdf')).toBe(false);
    expect(ok(mediaTypeSchema, `a/${'b'.repeat(126)}`)).toBe(false);

    // The limit counts Unicode code points, so 256 astral characters (512 UTF-16 units) fit.
    expect(ok(labelSchema, '😀'.repeat(256))).toBe(true);
    expect(ok(labelSchema, '😀'.repeat(257))).toBe(false);
    expect(ok(labelSchema, 'a'.repeat(257))).toBe(false);
    expect(ok(labelSchema, '')).toBe(true);
    expect(ok(labelSchema, '\ud800')).toBe(false);

    expect(ok(artifactByteLengthSchema, '10485760')).toBe(true);
    expect(ok(artifactByteLengthSchema, '10485761')).toBe(false);
    expect(ok(artifactByteLengthSchema, '0')).toBe(true);
    expect(ok(artifactByteLengthSchema, '010')).toBe(false);
  });
});

describe('ReviewPackageV1', () => {
  it('accepts the fixtures and returns deep-frozen data', () => {
    for (const vector of [getCase('generic'), legal, revised]) {
      const result = parseReviewPackage(vector.opening.manifest);
      expect(failureCode(result)).toBe('OK');
      if (result.ok) {
        expect(Object.isFrozen(result.data)).toBe(true);
        expect(Object.isFrozen(result.data.artifacts)).toBe(true);
        expect(Object.isFrozen(at(result.data.artifacts, 0))).toBe(true);
      }
    }
  });

  it('never lowercases, trims or defaults an imported value', () => {
    expect(failureCode(parsed((m) => (m.packageId = m.packageId.toUpperCase())))).toBe(
      'SCHEMA_INVALID',
    );
    expect(failureCode(parsed((m) => (m.context.reviewerAddress = `0x${'AA'.repeat(20)}`)))).toBe(
      'SCHEMA_INVALID',
    );
    expect(failureCode(parsed((m) => (m.context.chainId = ' 31337')))).toBe('SCHEMA_INVALID');
    expect(failureCode(parsed((m) => (at(m.artifacts, 0).sha256 += ' ')))).toBe('SCHEMA_INVALID');
    const { label: _label, ...withoutLabel } = at(manifestOf(legal).artifacts, 0);
    const missingLabel = { ...manifestOf(legal), artifacts: [withoutLabel] };
    expect(failureCode(parseReviewPackage(missingLabel))).toBe('SCHEMA_INVALID');
    const { supersedes: _supersedes, ...withoutSupersedes } = manifestOf(legal);
    expect(failureCode(parseReviewPackage(withoutSupersedes))).toBe('SCHEMA_INVALID');
  });

  it('rejects the zero address for registry and reviewer', () => {
    const zero = `0x${'00'.repeat(20)}`;
    expect(failureCode(parsed((m) => (m.context.registryAddress = zero)))).toBe('SCHEMA_INVALID');
    expect(failureCode(parsed((m) => (m.context.reviewerAddress = zero)))).toBe('SCHEMA_INVALID');
  });

  it('rejects unknown fields at every level, including fields that must never be in a package', () => {
    const variants: unknown[] = [
      { ...manifestOf(legal), storageUrl: 'https://example.invalid/x' },
      { ...manifestOf(legal), signature: '0x00' },
      { ...manifestOf(legal), transactionHash: `0x${'ab'.repeat(32)}` },
      { ...manifestOf(legal), status: 'active' },
      { ...manifestOf(legal), context: { ...manifestOf(legal).context, encryptionKey: 'k' } },
      { ...manifestOf(legal), profile: { ...manifestOf(legal).profile, name: 'x' } },
      { ...manifestOf(legal), approval: { ...manifestOf(legal).approval, approved: true } },
      {
        ...manifestOf(legal),
        artifacts: manifestOf(legal).artifacts.map((item) => ({
          ...item,
          url: 'https://x.invalid',
        })),
      },
    ];
    for (const variant of variants) {
      expect(failureCode(parseReviewPackage(variant))).toBe('UNKNOWN_FIELD');
    }
  });

  it('rejects unsupported versions instead of reading them as v1', () => {
    expect(
      failureCode(
        parseReviewPackage({ ...manifestOf(legal), schema: 'lexaegis.review-package.v2' }),
      ),
    ).toBe('UNSUPPORTED_VERSION');
    expect(
      failureCode(parseReviewPackage({ ...manifestOf(legal), schema: REFERENCE_SCHEMA })),
    ).toBe('UNSUPPORTED_VERSION');
    expect(failureCode(parseReviewPackage({ ...manifestOf(legal), schema: 1 }))).toBe(
      'SCHEMA_INVALID',
    );
    const { schema: _schema, ...unversioned } = manifestOf(legal);
    expect(failureCode(parseReviewPackage(unversioned))).toBe('SCHEMA_INVALID');
    const nested = manifestOf(revised);
    expect(
      failureCode(
        parseReviewPackage({
          ...nested,
          supersedes: { ...nested.supersedes, schema: 'lexaegis.receipt-ref.v9' },
        }),
      ),
    ).toBe('UNSUPPORTED_VERSION');
    expect(failureCode(parseReviewPackage([]))).toBe('SCHEMA_INVALID');
    expect(failureCode(parseReviewPackage(null))).toBe('SCHEMA_INVALID');
  });

  it('requires unique artifact IDs', () => {
    expect(failureCode(parsed((m) => (at(m.artifacts, 1).id = at(m.artifacts, 0).id)))).toBe(
      'DUPLICATE_ARTIFACT_ID',
    );
  });

  it('requires at least one source and exactly one decision log', () => {
    expect(failureCode(parsed((m) => (at(m.artifacts, 0).role = 'evidence')))).toBe(
      'SOURCE_ARTIFACT_REQUIRED',
    );
    expect(failureCode(parsed((m) => (at(m.artifacts, 7).role = 'evidence')))).toBe(
      'DECISION_LOG_ARTIFACT_INVALID',
    );
    expect(failureCode(parsed((m) => (at(m.artifacts, 2).role = 'decision-log')))).toBe(
      'DECISION_LOG_ARTIFACT_INVALID',
    );
    expect(failureCode(parsed((m) => (at(m.artifacts, 3).role = 'ruling' as 'source')))).toBe(
      'SCHEMA_INVALID',
    );
  });

  it('requires the scope to cover every artifact exactly once', () => {
    expect(failureCode(parsed((m) => m.approval.scopeArtifactIds.pop()))).toBe('SCOPE_INCOMPLETE');
    expect(failureCode(parsed((m) => (m.approval.scopeArtifactIds = [])))).toBe('SCOPE_INCOMPLETE');
    expect(
      failureCode(
        parsed((m) => m.approval.scopeArtifactIds.push(at(m.approval.scopeArtifactIds, 0))),
      ),
    ).toBe('DUPLICATE_SCOPE_ID');
    expect(
      failureCode(
        parsed((m) => (m.approval.scopeArtifactIds[0] = 'e0000000-0000-4000-8000-000000000099')),
      ),
    ).toBe('UNRESOLVED_ARTIFACT_REFERENCE');
    // Any permutation is acceptable (the order itself is committed data).
    expect(failureCode(parsed((m) => m.approval.scopeArtifactIds.reverse()))).toBe('OK');
  });

  it('requires decisionLogArtifactId to resolve to the decision-log artifact', () => {
    expect(
      failureCode(
        parsed((m) => (m.approval.decisionLogArtifactId = 'e0000000-0000-4000-8000-000000000099')),
      ),
    ).toBe('UNRESOLVED_ARTIFACT_REFERENCE');
    expect(
      failureCode(parsed((m) => (m.approval.decisionLogArtifactId = at(m.artifacts, 0).id))),
    ).toBe('DECISION_LOG_REFERENCE_INVALID');
    expect(
      failureCode(parsed((m) => (m.approval.intent = 'approve' as typeof m.approval.intent))),
    ).toBe('SCHEMA_INVALID');
  });

  it('requires a declared predecessor to share chain, registry and reviewer', () => {
    const other = `0x${'33'.repeat(20)}`;
    const withSupersedes = (change: (m: ReviewPackageV1) => void) =>
      failureCode(parsed(change, revised));
    expect(withSupersedes(() => undefined)).toBe('OK');
    expect(withSupersedes((m) => m.supersedes && (m.supersedes.chainId = '1'))).toBe(
      'SUPERSEDES_CONTEXT_MISMATCH',
    );
    expect(withSupersedes((m) => m.supersedes && (m.supersedes.registryAddress = other))).toBe(
      'SUPERSEDES_CONTEXT_MISMATCH',
    );
    expect(withSupersedes((m) => m.supersedes && (m.supersedes.reviewerAddress = other))).toBe(
      'SUPERSEDES_CONTEXT_MISMATCH',
    );
  });

  it('enforces the artifact count and size limits from declared metadata', () => {
    const many = (count: number): ReviewPackageV1 => {
      const artifacts = [
        artifact(1, { role: 'source' }),
        artifact(2, { role: 'decision-log' }),
        ...Array.from({ length: count - 2 }, (_, index) => artifact(index + 3)),
      ];
      return {
        ...manifestOf(legal),
        artifacts,
        approval: {
          intent: 'approve-review-package',
          scopeArtifactIds: artifacts.map((item) => item.id),
          decisionLogArtifactId: at(artifacts, 1).id,
        },
      };
    };
    expect(failureCode(parseReviewPackage(many(128)))).toBe('OK');
    expect(failureCode(parseReviewPackage(many(129)))).toBe('TOO_MANY_ARTIFACTS');

    expect(failureCode(parsed((m) => (at(m.artifacts, 0).byteLength = '10485761')))).toBe(
      'ARTIFACT_TOO_LARGE',
    );
    // Four artifacts of exactly 10 MiB exceed the 32 MiB combined limit; three do not.
    const sized = (count: number) =>
      parsed((m) => m.artifacts.slice(0, count).forEach((item) => (item.byteLength = '10485760')));
    expect(failureCode(sized(3))).toBe('OK');
    expect(failureCode(sized(4))).toBe('ARTIFACTS_TOO_LARGE');
  });

  it('reports a malformed field as a schema error without running cross-field rules on it', () => {
    const result = parsed((m) => (at(m.artifacts, 0).byteLength = 'not-a-number'));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toEqual({
      code: 'SCHEMA_INVALID',
      path: 'artifacts.0.byteLength',
    });
  });

  it('exposes the same rules through the Zod schema itself', () => {
    const manifest = manifestOf(legal);
    expect(reviewPackageV1Schema.safeParse(manifest).success).toBe(true);
    manifest.approval.scopeArtifactIds.pop();
    expect(reviewPackageV1Schema.safeParse(manifest).success).toBe(false);
  });

  it('error details carry field paths only, never values', () => {
    const result = parsed((m) => (at(m.artifacts, 0).label = `SECRET-LABEL-${'x'.repeat(300)}`));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SECRET-LABEL');
    expect(!result.ok && result.error.path).toBe('artifacts.0.label');
  });
});

describe('ReceiptReferenceV1 and CommitmentOpeningV1', () => {
  it('accepts a reference with exactly five fields and nothing else', () => {
    const { reference } = legal.expected;
    expect(failureCode(parseReceiptReference(reference))).toBe('OK');
    expect(Object.keys(reference).sort()).toEqual([
      'chainId',
      'commitment',
      'registryAddress',
      'reviewerAddress',
      'schema',
    ]);
    for (const extra of ['signature', 'status', 'blockTimestamp', 'transactionHash', 'id']) {
      expect(failureCode(parseReceiptReference({ ...reference, [extra]: 'x' }))).toBe(
        'UNKNOWN_FIELD',
      );
    }
    expect(failureCode(parseReceiptReference({ ...reference, schema: PACKAGE_SCHEMA }))).toBe(
      'UNSUPPORTED_VERSION',
    );
    expect(
      failureCode(
        parseReceiptReference({ ...reference, commitment: reference.commitment.toUpperCase() }),
      ),
    ).toBe('SCHEMA_INVALID');
    const { commitment: _commitment, ...withoutCommitment } = reference;
    expect(failureCode(parseReceiptReference(withoutCommitment))).toBe('SCHEMA_INVALID');
  });

  it('requires an opening to carry a valid manifest and a 32-byte nonce', () => {
    expect(failureCode(parseCommitmentOpening(openingOf(legal)))).toBe('OK');
    const { blindingNonce: _nonce, ...withoutNonce } = openingOf(legal);
    expect(failureCode(parseCommitmentOpening(withoutNonce))).toBe('SCHEMA_INVALID');
    expect(
      failureCode(parseCommitmentOpening({ ...openingOf(legal), blindingNonce: '0x1234' })),
    ).toBe('SCHEMA_INVALID');
    expect(
      failureCode(parseCommitmentOpening({ ...openingOf(legal), schema: 'lexaegis.opening.v2' })),
    ).toBe('UNSUPPORTED_VERSION');
    expect(
      failureCode(
        parseCommitmentOpening({
          ...openingOf(legal),
          manifest: { ...manifestOf(legal), schema: 'lexaegis.review-package.v2' },
        }),
      ),
    ).toBe('UNSUPPORTED_VERSION');
    expect(
      failureCode(
        parseCommitmentOpening({
          ...openingOf(legal),
          packageDigest: legal.expected.packageDigest,
        }),
      ),
    ).toBe('UNKNOWN_FIELD');
    expect(openingOf(legal).schema).toBe(OPENING_SCHEMA);
    // Structural manifest rules apply inside an opening too.
    const broken = openingOf(legal);
    broken.manifest.approval.scopeArtifactIds.pop();
    expect(failureCode(parseCommitmentOpening(broken))).toBe('SCOPE_INCOMPLETE');
  });
});
