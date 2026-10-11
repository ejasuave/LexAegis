import { describe, expect, it } from 'vitest';
import { MAX_TRAILER_BYTES, readMetadataTrailer } from './cbor';

const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const code = '6080604052'; // some executable bytes in front
/** `{"solc": h'000825'}` + length 0x000a: the real trailer of this repository's build. */
const SOLC_ONLY = 'a164736f6c6343000825000a';
const ipfsHash = `1220${'ab'.repeat(32)}`;
/** `{"ipfs": <34 bytes>, "solc": h'000825'}` + length 0x0033. */
const IPFS_AND_SOLC = `a2646970667358221220${'ab'.repeat(32)}64736f6c63430008250033`;

describe('Solidity metadata trailer', () => {
  it('reads the trailer this build writes: a solc-only map of ten bytes', () => {
    const result = readMetadataTrailer(bytes(code + SOLC_ONLY));
    expect(result).toEqual({
      ok: true,
      trailer: {
        totalBytes: 12,
        entries: { solc: { kind: 'bytes', value: '000825' } },
        solcVersion: '0.8.37',
      },
    });
  });
  it('reads an ipfs + solc trailer and a pre-release compiler text', () => {
    const result = readMetadataTrailer(bytes(code + IPFS_AND_SOLC));
    if (!result.ok) throw new Error(result.reason);
    expect(result.trailer.totalBytes).toBe(53);
    expect(result.trailer.entries.ipfs).toEqual({ kind: 'bytes', value: ipfsHash });
    expect(result.trailer.solcVersion).toBe('0.8.37');
    // {"solc": "0.8.38-nightly"} with a text value, plus "experimental": true
    const text = Array.from(new TextEncoder().encode('0.8.38-nightly'), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    const map = `a264736f6c636e${text}6c6578706572696d656e74616cf5`;
    const length = (map.length / 2).toString(16).padStart(4, '0');
    const prerelease = readMetadataTrailer(bytes(code + map + length));
    if (!prerelease.ok) throw new Error(prerelease.reason);
    expect(prerelease.trailer.solcVersion).toBe('0.8.38-nightly');
    expect(prerelease.trailer.entries.experimental).toEqual({ kind: 'bool', value: 'true' });
  });
  it('rejects a length that points outside the code, is tiny or is oversized', () => {
    expect(readMetadataTrailer(bytes('00'))).toEqual({ ok: false, reason: 'TOO_SHORT' });
    // Declares 0x0100 bytes of metadata in a 14-byte code.
    expect(readMetadataTrailer(bytes(`${code}a164736f6c63430008250100`))).toEqual({
      ok: false,
      reason: 'LENGTH_OUT_OF_RANGE',
    });
    expect(readMetadataTrailer(bytes(`${code}0000`))).toEqual({
      ok: false,
      reason: 'LENGTH_OUT_OF_RANGE',
    });
    const big = 'a0'.repeat(MAX_TRAILER_BYTES + 1);
    expect(
      readMetadataTrailer(
        bytes(`${code}${big}${(MAX_TRAILER_BYTES + 1).toString(16).padStart(4, '0')}`),
      ),
    ).toEqual({
      ok: false,
      reason: 'LENGTH_OUT_OF_RANGE',
    });
  });
  it('rejects a truncated map, undecoded trailing bytes and a non-map', () => {
    // The map says its value has 3 bytes but only 2 remain inside the declared length.
    expect(readMetadataTrailer(bytes(`${code}a164736f6c634300080009`))).toEqual({
      ok: false,
      reason: 'TRUNCATED',
    });
    // A valid map followed by one extra byte inside the declared length.
    expect(readMetadataTrailer(bytes(`${code}a164736f6c634300082500000b`))).toEqual({
      ok: false,
      reason: 'TRAILING_BYTES',
    });
    // An array of the same size instead of a map.
    expect(readMetadataTrailer(bytes(`${code}8164736f6c6343000825000a`))).toEqual({
      ok: false,
      reason: 'NOT_A_MAP',
    });
    // Ordinary executable bytes whose last two bytes happen to look like a small length.
    expect(readMetadataTrailer(bytes('6080604052348015600e575f5ffd5b50600a')).ok).toBe(false);
  });
  it('rejects unknown keys, duplicate keys, indefinite lengths and wrong value shapes', () => {
    // {"evil": h'000825'}
    expect(readMetadataTrailer(bytes(`${code}a1646576696c43000825000a`))).toEqual({
      ok: false,
      reason: 'UNKNOWN_KEY',
    });
    // {"solc": ..., "solc": ...}
    expect(readMetadataTrailer(bytes(`${code}a264736f6c634300082564736f6c63430008250013`))).toEqual(
      { ok: false, reason: 'DUPLICATE_KEY' },
    );
    // An indefinite-length map (0xbf).
    expect(readMetadataTrailer(bytes(`${code}bf64736f6c6343000825000a`))).toEqual({
      ok: false,
      reason: 'NOT_A_MAP',
    });
    // solc with 2 bytes, and ipfs with 3 bytes.
    expect(readMetadataTrailer(bytes(`${code}a164736f6c634200080009`))).toEqual({
      ok: false,
      reason: 'VALUE_SHAPE',
    });
    expect(readMetadataTrailer(bytes(`${code}a1646970667343010203000a`))).toEqual({
      ok: false,
      reason: 'VALUE_SHAPE',
    });
    // A nested map as a value.
    expect(readMetadataTrailer(bytes(`${code}a164736f6c63a00007`))).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_ITEM',
    });
  });
});
