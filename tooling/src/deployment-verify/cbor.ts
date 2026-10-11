/*
 * Solidity appends optional CBOR metadata to runtime bytecode: `<cbor map> <two-byte big-endian
 * length of the map>`. This is a BOUNDED decoder for exactly that structure. It never searches for
 * a magic prefix and never removes a fixed suffix: the final two bytes give a length, and the
 * bytes they point at must decode, completely and exactly, as a map of the keys the compiler is
 * documented to write. Anything else is "no validated trailer", and nothing is stripped.
 *
 * Reference: Solidity documentation, "Contract Metadata", section "Encoding of the Metadata Hash
 * in the Bytecode".
 */

/** Larger than any trailer the compiler writes (ipfs + solc + experimental is about 53 bytes). */
export const MAX_TRAILER_BYTES = 128;
const MAX_ENTRIES = 6;
const KNOWN_KEYS = ['ipfs', 'bzzr0', 'bzzr1', 'experimental', 'solc'] as const;
type KnownKey = (typeof KNOWN_KEYS)[number];

export const TRAILER_FAILURES = [
  'TOO_SHORT',
  'LENGTH_OUT_OF_RANGE',
  'NOT_A_MAP',
  'UNSUPPORTED_ITEM',
  'UNKNOWN_KEY',
  'DUPLICATE_KEY',
  'TRUNCATED',
  'TRAILING_BYTES',
  'VALUE_SHAPE',
] as const;
export type TrailerFailure = (typeof TRAILER_FAILURES)[number];

export interface MetadataEntry {
  readonly kind: 'bytes' | 'text' | 'bool';
  /** Hex of a byte string, the text itself, or "true"/"false". */
  readonly value: string;
}

export interface MetadataTrailer {
  /** The CBOR map plus its two length bytes: what a metadata-insensitive comparison may ignore. */
  readonly totalBytes: number;
  readonly entries: Readonly<Partial<Record<KnownKey, MetadataEntry>>>;
  /** "0.8.37" for a release compiler, the literal text for a pre-release, or null if absent. */
  readonly solcVersion: string | null;
}

export type TrailerResult =
  | { readonly ok: true; readonly trailer: MetadataTrailer }
  | { readonly ok: false; readonly reason: TrailerFailure };

const fail = (reason: TrailerFailure): TrailerResult => ({ ok: false, reason });
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Reads one CBOR head: major type and an argument of at most two bytes. */
function head(
  data: Uint8Array,
  at: number,
): { major: number; argument: number; next: number; simple: number } | null {
  const first = data[at];
  if (first === undefined) return null;
  const major = first >> 5;
  const info = first & 0x1f;
  if (info < 24) return { major, argument: info, next: at + 1, simple: info };
  if (info === 24) {
    const one = data[at + 1];
    return one === undefined ? null : { major, argument: one, next: at + 2, simple: info };
  }
  if (info === 25) {
    const high = data[at + 1];
    const low = data[at + 2];
    if (high === undefined || low === undefined) return null;
    return { major, argument: (high << 8) | low, next: at + 3, simple: info };
  }
  // Longer arguments and indefinite lengths never occur in compiler metadata.
  return { major: -1, argument: 0, next: at, simple: info };
}

export function readMetadataTrailer(code: Uint8Array): TrailerResult {
  if (code.length < 4) return fail('TOO_SHORT');
  const declared = ((code[code.length - 2] ?? 0) << 8) | (code[code.length - 1] ?? 0);
  if (declared < 2 || declared > MAX_TRAILER_BYTES || declared + 2 > code.length) {
    return fail('LENGTH_OUT_OF_RANGE');
  }
  const map = code.subarray(code.length - 2 - declared, code.length - 2);
  const start = head(map, 0);
  if (start === null) return fail('TRUNCATED');
  if (start.major !== 5) return fail('NOT_A_MAP');
  if (start.argument < 1 || start.argument > MAX_ENTRIES) return fail('NOT_A_MAP');

  const entries: Partial<Record<KnownKey, MetadataEntry>> = {};
  let cursor = start.next;
  for (let index = 0; index < start.argument; index += 1) {
    const key = head(map, cursor);
    if (key === null) return fail('TRUNCATED');
    if (key.major !== 3 || key.argument > 16) return fail('UNSUPPORTED_ITEM');
    if (key.next + key.argument > map.length) return fail('TRUNCATED');
    const name = new TextDecoder().decode(map.subarray(key.next, key.next + key.argument));
    if (!(KNOWN_KEYS as readonly string[]).includes(name)) return fail('UNKNOWN_KEY');
    const known = name as KnownKey;
    if (entries[known] !== undefined) return fail('DUPLICATE_KEY');
    cursor = key.next + key.argument;

    const value = head(map, cursor);
    if (value === null) return fail('TRUNCATED');
    if (value.major === 2 || value.major === 3) {
      if (value.argument > 64) return fail('UNSUPPORTED_ITEM');
      if (value.next + value.argument > map.length) return fail('TRUNCATED');
      const body = map.subarray(value.next, value.next + value.argument);
      entries[known] =
        value.major === 2
          ? { kind: 'bytes', value: hex(body) }
          : { kind: 'text', value: new TextDecoder().decode(body) };
      cursor = value.next + value.argument;
    } else if (value.major === 7 && (value.simple === 20 || value.simple === 21)) {
      entries[known] = { kind: 'bool', value: value.simple === 21 ? 'true' : 'false' };
      cursor = value.next;
    } else {
      return fail('UNSUPPORTED_ITEM');
    }
  }
  // The map must fill the declared length exactly: no undecoded bytes ride along.
  if (cursor !== map.length) return fail('TRAILING_BYTES');

  // The compiler's documented shapes. A value of another shape is not compiler metadata.
  const { ipfs, bzzr0, bzzr1, experimental, solc } = entries;
  if (ipfs !== undefined && !(ipfs.kind === 'bytes' && ipfs.value.length === 68))
    return fail('VALUE_SHAPE');
  for (const swarm of [bzzr0, bzzr1]) {
    if (swarm !== undefined && !(swarm.kind === 'bytes' && swarm.value.length === 64)) {
      return fail('VALUE_SHAPE');
    }
  }
  if (experimental !== undefined && experimental.kind !== 'bool') return fail('VALUE_SHAPE');
  let solcVersion: string | null = null;
  if (solc !== undefined) {
    if (solc.kind === 'bytes') {
      if (solc.value.length !== 6) return fail('VALUE_SHAPE');
      solcVersion = [0, 2, 4]
        .map((at) => String(parseInt(solc.value.slice(at, at + 2), 16)))
        .join('.');
    } else if (solc.kind === 'text') {
      solcVersion = solc.value;
    } else {
      return fail('VALUE_SHAPE');
    }
  }
  return { ok: true, trailer: { totalBytes: declared + 2, entries, solcVersion } };
}
