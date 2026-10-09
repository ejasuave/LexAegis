import { describe, expect, it } from 'vitest';
import { bytesToHex } from './bytes';
import { canonicalizeJson, canonicalizeReviewPackage } from './canonicalize';
import { ProtocolError } from './errors';
import { packageDigest } from './hashes';
import { at, getCase, manifestOf } from './test-helpers';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function thrownCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof ProtocolError ? error.code : 'OTHER';
  }
  return 'NONE';
}

describe('RFC 8785 canonicalization', () => {
  it('orders properties by UTF-16 code unit (RFC 8785 section 3.2.3 example)', () => {
    const input = {
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\ud83d\ude00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    };
    // Literal member order from the RFC: the emoji (D83D DE00) sorts before U+FB33. The text is
    // compared directly because parsing it back would let the engine reorder integer-like keys.
    expect(decode(canonicalizeJson(input))).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control",' +
        '"\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign",' +
        '"\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it('emits minimal escapes, sorts recursively and keeps array order', () => {
    expect(
      decode(canonicalizeJson({ b: [3, 1, 2], a: { z: null, y: true }, 'c\n': '"\u2028\u007f' })),
    ).toBe('{"a":{"y":true,"z":null},"b":[3,1,2],"c\\n":"\\"\u2028\u007f"}');
  });

  it('rejects values outside the protocol subset instead of serializing them', () => {
    expect(thrownCode(() => canonicalizeJson({ a: 1.5 }))).toBe('UNSAFE_NUMBER');
    expect(thrownCode(() => canonicalizeJson({ a: undefined }))).toBe('UNSUPPORTED_VALUE');
    expect(thrownCode(() => canonicalizeJson({ a: '\ud800' }))).toBe('LONE_SURROGATE');
    expect(thrownCode(() => canonicalizeJson(new Date(0)))).toBe('UNSUPPORTED_VALUE');
  });
});

describe('canonical review-package bytes', () => {
  const vector = getCase('legal');
  const expected = vector.expected.canonicalManifestUtf8Hex;

  it('does not depend on object key insertion order at any depth', () => {
    const manifest = manifestOf(vector);
    const reversed = (value: object): object => Object.fromEntries(Object.entries(value).reverse());
    const shuffled = {
      ...reversed(manifest),
      context: reversed(manifest.context),
      profile: reversed(manifest.profile),
      approval: reversed(manifest.approval),
      artifacts: manifest.artifacts.map(reversed),
    };
    expect(Object.keys(shuffled)).not.toEqual(Object.keys(manifest));
    expect(bytesToHex(canonicalizeReviewPackage(shuffled))).toBe(expected);
    // Whitespace and member order in raw JSON text are equally irrelevant.
    expect(bytesToHex(canonicalizeReviewPackage(JSON.stringify(shuffled, null, 4)))).toBe(expected);
  });

  it('treats array order as committed data', async () => {
    const manifest = manifestOf(vector);
    manifest.artifacts.reverse();
    const reordered = canonicalizeReviewPackage(manifest);
    expect(bytesToHex(reordered)).not.toBe(expected);
    expect(await packageDigest(reordered)).not.toBe(vector.expected.packageDigest);

    const scope = manifestOf(vector);
    scope.approval.scopeArtifactIds.reverse();
    expect(bytesToHex(canonicalizeReviewPackage(scope))).not.toBe(expected);
  });

  it('preserves Unicode without normalization: composed and decomposed labels differ', () => {
    const composed = manifestOf(vector);
    const decomposed = manifestOf(vector);
    at(composed.artifacts, 0).label = 'caf\u00e9';
    at(decomposed.artifacts, 0).label = 'cafe\u0301';
    expect('caf\u00e9'.normalize('NFD')).toBe('cafe\u0301');
    const left = canonicalizeReviewPackage(composed);
    const right = canonicalizeReviewPackage(decomposed);
    expect(bytesToHex(left)).not.toBe(bytesToHex(right));
    expect(decode(left)).toContain('caf\u00e9');
    expect(decode(right)).toContain('cafe\u0301');
  });

  it('has no canonical form for an invalid manifest', () => {
    const manifest = manifestOf(vector);
    expect(thrownCode(() => canonicalizeReviewPackage({ ...manifest, extra: true }))).toBe(
      'UNKNOWN_FIELD',
    );
    expect(thrownCode(() => canonicalizeReviewPackage({ ...manifest, packageId: 'nope' }))).toBe(
      'SCHEMA_INVALID',
    );
  });
});
