import { describe, expect, it } from 'vitest';
import { artifactMap, getCase, openingOf } from '../v1/test-helpers';
import { verifyReviewPackage } from '../v1/verify';
import { fromBase64Url, toBase64Url } from './base64url';
import { PORTABLE_LIMITS, REVIEW_EXPORT_SCHEMA } from './constants';
import { decodeReviewExport, type PortableResult } from './review-export';

/*
 * Runs unchanged in Node.js and in real Chromium. The envelopes are assembled here from the
 * literal Chapter 2 vector inputs; expected digests and commitments are never recomputed by the
 * code under test.
 */

const text = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function envelopeOf(id: 'generic' | 'legal') {
  const vector = getCase(id);
  const artifacts = artifactMap(vector);
  return {
    vector,
    envelope: {
      schema: REVIEW_EXPORT_SCHEMA,
      receiptReference: vector.expected.reference,
      opening: openingOf(vector),
      artifacts: vector.opening.manifest.artifacts.map((artifact) => ({
        artifactId: artifact.id,
        bytes: toBase64Url(artifacts.get(artifact.id) ?? new Uint8Array()),
      })),
    },
  };
}

const codeOf = (result: PortableResult<unknown>) => (result.ok ? 'OK' : result.error.code);

describe('portable base64url', () => {
  it('round-trips and rejects noncanonical text', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253]);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(fromBase64Url('A')).toBeNull();
    expect(fromBase64Url('+/+/')).toBeNull();
    // "QQ" is canonical for one byte (0x41); "QR" sets nonzero trailing bits.
    const trailing = fromBase64Url('QR');
    expect(trailing === null ? null : toBase64Url(trailing)).not.toBe('QR');
  });
});

describe('decodeReviewExport', () => {
  it('preserves the exact original bytes, in manifest order, and verifies against the literal reference', async () => {
    for (const id of ['generic', 'legal'] as const) {
      const { vector, envelope } = envelopeOf(id);
      const decoded = decodeReviewExport(text(envelope));
      expect(codeOf(decoded)).toBe('OK');
      if (!decoded.ok) continue;
      expect([...decoded.data.artifacts.keys()]).toEqual(
        vector.opening.manifest.artifacts.map((artifact) => artifact.id),
      );
      for (const [artifactId, bytes] of artifactMap(vector)) {
        expect(decoded.data.artifacts.get(artifactId)).toEqual(bytes);
      }
      expect(decoded.data.declaredReference).toEqual(vector.expected.reference);
      const verification = await verifyReviewPackage(
        decoded.data.opening,
        decoded.data.artifacts,
        vector.expected.reference,
      );
      expect(verification.ok && verification.data.artifactIntegrity).toBe('match');
    }
  });

  it('does not repair or normalise: a changed artifact decodes but is not the committed one', async () => {
    const { vector, envelope } = envelopeOf('generic');
    const first = envelope.artifacts[0];
    if (first === undefined) throw new Error('no artifact');
    const bytes = fromBase64Url(first.bytes) ?? new Uint8Array();
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    first.bytes = toBase64Url(bytes);
    const decoded = decodeReviewExport(text(envelope));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const verification = await verifyReviewPackage(
      decoded.data.opening,
      decoded.data.artifacts,
      vector.expected.reference,
    );
    expect(verification.ok && verification.data.artifactIntegrity).toBe('mismatch');
  });

  it('rejects non-byte input, an empty file and arbitrary text', () => {
    expect(codeOf(decodeReviewExport('{}'))).toBe('INPUT_MALFORMED');
    expect(codeOf(decodeReviewExport(new Uint8Array()))).toBe('INPUT_MALFORMED');
    expect(codeOf(decodeReviewExport(new TextEncoder().encode('hello')))).toBe('INPUT_MALFORMED');
  });

  it('rejects input over 48 MiB before parsing it', () => {
    const big = new Uint8Array(PORTABLE_LIMITS.maxEncodedBytes + 1);
    expect(codeOf(decodeReviewExport(big))).toBe('INPUT_TOO_LARGE');
  });

  describe('strict JSON', () => {
    const base = JSON.stringify(envelopeOf('generic').envelope);
    const cause = (bytes: Uint8Array) => {
      const result = decodeReviewExport(bytes);
      return result.ok ? 'OK' : (result.error.cause ?? result.error.code);
    };

    it('rejects a byte-order mark, malformed UTF-8 and trailing content', () => {
      const raw = new TextEncoder().encode(base);
      expect(cause(Uint8Array.from([0xef, 0xbb, 0xbf, ...raw]))).toBe('BYTE_ORDER_MARK');
      expect(cause(Uint8Array.from([...raw.slice(0, 10), 0xff, ...raw.slice(10)]))).toBe(
        'INVALID_UTF8',
      );
      expect(cause(new TextEncoder().encode(`${base} {}`))).toBe('INVALID_JSON');
      expect(cause(new TextEncoder().encode(`${base}x`))).toBe('INVALID_JSON');
    });

    it('rejects duplicate keys and keys equal after escape decoding', () => {
      const duplicate = base.replace(
        `"schema":"${REVIEW_EXPORT_SCHEMA}"`,
        (match) => `${match},${match}`,
      );
      expect(cause(new TextEncoder().encode(duplicate))).toBe('DUPLICATE_KEY');
      const escaped = base.replace(
        `"schema":"${REVIEW_EXPORT_SCHEMA}"`,
        (match) => `${match},"sch\\u0065ma":"x"`,
      );
      expect(cause(new TextEncoder().encode(escaped))).toBe('DUPLICATE_KEY');
    });

    it('rejects unsafe numbers, prototype keys and excessive nesting', () => {
      expect(cause(new TextEncoder().encode(base.replace(/\}$/, ',"n":1.5}')))).toBe(
        'UNSAFE_NUMBER',
      );
      expect(cause(new TextEncoder().encode(base.replace(/\}$/, ',"n":9007199254740993}')))).toBe(
        'UNSAFE_NUMBER',
      );
      expect(cause(new TextEncoder().encode(base.replace(/\}$/, ',"__proto__":{}}')))).toBe(
        'FORBIDDEN_KEY',
      );
      const deep = `${'['.repeat(40)}${']'.repeat(40)}`;
      expect(cause(new TextEncoder().encode(deep))).toBe('NESTING_TOO_DEEP');
    });
  });

  describe('format and version', () => {
    it('names an encrypted backup and a context export specifically', () => {
      expect(
        codeOf(decodeReviewExport(text({ schema: 'lexaegis.encrypted-review-export.v1', x: 1 }))),
      ).toBe('WRONG_FORMAT_ENCRYPTED_BACKUP');
      expect(
        codeOf(decodeReviewExport(text({ schema: 'lexaegis.matter-context-export.v1' }))),
      ).toBe('WRONG_FORMAT_CONTEXT_EXPORT');
    });

    it('rejects unsupported versions and unrecognised files', () => {
      expect(codeOf(decodeReviewExport(text({ schema: 'lexaegis.review-export.v2' })))).toBe(
        'UNSUPPORTED_VERSION',
      );
      expect(codeOf(decodeReviewExport(text({ schema: 'other.thing' })))).toBe(
        'UNRECOGNISED_FORMAT',
      );
      expect(codeOf(decodeReviewExport(text({})))).toBe('UNRECOGNISED_FORMAT');
      expect(codeOf(decodeReviewExport(text([])))).toBe('UNRECOGNISED_FORMAT');
    });

    it('rejects unknown fields at every level instead of stripping them', () => {
      const top = envelopeOf('generic').envelope;
      expect(codeOf(decodeReviewExport(text({ ...top, status: 'active' })))).toBe('UNKNOWN_FIELD');
      expect(codeOf(decodeReviewExport(text({ ...top, signature: '0x00' })))).toBe('UNKNOWN_FIELD');
      expect(
        codeOf(
          decodeReviewExport(
            text({ ...top, artifacts: top.artifacts.map((entry) => ({ ...entry, url: 'x' })) }),
          ),
        ),
      ).toBe('UNKNOWN_FIELD');
    });
  });

  describe('artifact coverage', () => {
    it('rejects a missing, extra, duplicate or reordered artifact entry', () => {
      const { envelope } = envelopeOf('legal');
      const [a, b, ...rest] = envelope.artifacts;
      if (a === undefined || b === undefined) throw new Error('need two artifacts');
      const cases = {
        missing: [a, ...rest],
        extra: [...envelope.artifacts, { artifactId: crypto.randomUUID(), bytes: '' }],
        duplicate: [a, a, ...rest],
        reordered: [b, a, ...rest],
        none: [],
      };
      for (const [name, artifacts] of Object.entries(cases)) {
        expect(codeOf(decodeReviewExport(text({ ...envelope, artifacts }))), name).toBe(
          'ARTIFACT_SET_MISMATCH',
        );
      }
    });

    it('rejects padded, non-alphabet and noncanonical artifact text', () => {
      for (const bytes of ['QQ==', 'QQ+/', 'Q', 'QR', 'AA AA']) {
        const { envelope } = envelopeOf('generic');
        const first = envelope.artifacts[0];
        if (first === undefined) throw new Error('no artifact');
        first.bytes = bytes;
        const result = decodeReviewExport(text(envelope));
        expect(result.ok, bytes).toBe(false);
      }
    });

    it('bounds an oversized artifact string before decoding it', () => {
      const { envelope } = envelopeOf('generic');
      const first = envelope.artifacts[0];
      if (first === undefined) throw new Error('no artifact');
      first.bytes = 'A'.repeat(Math.ceil((PORTABLE_LIMITS.maxArtifactBytes * 4) / 3) + 8);
      expect(codeOf(decodeReviewExport(text(envelope)))).toBe('ARTIFACT_TOO_LARGE');
    });

    it('rejects more than 128 artifacts', () => {
      const { envelope } = envelopeOf('generic');
      const artifacts = Array.from({ length: PORTABLE_LIMITS.maxArtifacts + 1 }, () => ({
        artifactId: crypto.randomUUID(),
        bytes: '',
      }));
      expect(codeOf(decodeReviewExport(text({ ...envelope, artifacts })))).not.toBe('OK');
    });
  });

  it('does not raise the manifest or opening limit for a larger outer bundle', () => {
    const { envelope } = envelopeOf('generic');
    const opening = structuredClone(envelope.opening);
    // A label that pushes the opening past 1 MiB (labels are also capped, so this fails as invalid).
    const [first] = opening.manifest.artifacts;
    if (first === undefined) throw new Error('no artifact');
    first.label = 'x'.repeat(PORTABLE_LIMITS.maxStructuredBytes);
    const result = decodeReviewExport(text({ ...envelope, opening }));
    expect(result.ok).toBe(false);
  });
});
