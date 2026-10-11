/*
 * Synthetic canaries for the disclosure-boundary checks. A canary is a value planted in, or
 * produced by, a TEST-OWNED journey (synthetic documents, a virtual authenticator, local services).
 * The checks search every observation layer for each canary in the encodings a leak would plausibly
 * take. They report the canary's ID and class, never its value.
 *
 * This is bounded detection. It does not prove the absence of every encoding or side channel.
 */

export const CANARY_CLASSES = [
  'selected_text',
  'unselected_text',
  'filename',
  'matter_title',
  'reviewer_note',
  'money_field',
  'opening_nonce',
  'artifact_hash',
  'prf_output',
  'signing_key',
  /** Anything that would let a signing session be resumed or reused. It has no permitted store. */
  'signing_session_secret',
  'vault_key',
  'session_cookie',
  'provider_credential',
  'storage_credential',
  'database_credential',
] as const;
export type CanaryClass = (typeof CANARY_CLASSES)[number];

export interface Canary {
  readonly id: string;
  readonly class: CanaryClass;
  /**
   * `text`: searched case-insensitively and in escaped and encoded forms.
   * `bytes`: `value` is lowercase hex; searched as hex, base64, base64url and decimal arrays.
   * `token`: a number-like value searched only where digits do not continue on either side.
   */
  readonly kind: 'text' | 'bytes' | 'token';
  readonly value: string;
}

export interface CanaryHit {
  readonly id: string;
  readonly class: CanaryClass;
  readonly encoding: string;
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));

/**
 * Base64 of a byte string depends on where it starts inside a longer buffer. These are the parts
 * of the encoding that stay the same at each of the three alignments.
 */
export function base64Cores(bytes: Uint8Array): string[] {
  const cores: string[] = [];
  for (let lead = 0; lead < 3; lead += 1) {
    const padded = new Uint8Array(lead + bytes.length);
    padded.set(bytes, lead);
    const encoded = toBase64(padded).replace(/=+$/, '');
    const start = lead === 0 ? 0 : lead === 1 ? 2 : 3;
    const tail = (lead + bytes.length) % 3 === 0 ? 0 : 1;
    const core = encoded.slice(start, encoded.length - tail);
    if (core.length >= 12) cores.push(core);
  }
  return cores;
}

/** Every searchable form of one canary, each with a label for the report. */
export function needles(
  canary: Canary,
): { encoding: string; needle: string; caseInsensitive: boolean }[] {
  const out: { encoding: string; needle: string; caseInsensitive: boolean }[] = [];
  const add = (encoding: string, needle: string, caseInsensitive = false) => {
    if (needle.length >= 6) out.push({ encoding, needle, caseInsensitive });
  };
  if (canary.kind === 'bytes') {
    const bytes = fromHex(canary.value);
    add('hex', canary.value, true);
    for (const core of base64Cores(bytes)) {
      add('base64', core);
      add('base64url', core.replace(/\+/g, '-').replace(/\//g, '_'));
    }
    add('decimal-array', Array.from(bytes).join(','));
    add('decimal-array-spaced', Array.from(bytes).join(', '));
    return out;
  }
  if (canary.kind === 'text') {
    const bytes = new TextEncoder().encode(canary.value);
    add('plain', canary.value, true);
    add('json-escaped', JSON.stringify(canary.value).slice(1, -1), true);
    add('url-encoded', encodeURIComponent(canary.value), true);
    add('form-encoded', encodeURIComponent(canary.value).replace(/%20/g, '+'), true);
    add('utf8-hex', Buffer.from(bytes).toString('hex'), true);
    for (const core of base64Cores(bytes)) {
      add('base64', core);
      add('base64url', core.replace(/\+/g, '-').replace(/\//g, '_'));
    }
    return out;
  }
  return out;
}

/** Finds every canary in `text`: at most one hit per canary. */
export function findCanaries(text: string, canaries: readonly Canary[]): CanaryHit[] {
  const hits: CanaryHit[] = [];
  const lower = text.toLowerCase();
  for (const canary of canaries) {
    if (canary.value === '') continue;
    if (canary.kind === 'token') {
      const escaped = canary.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?<![0-9A-Za-z])${escaped}(?![0-9A-Za-z])`).test(text)) {
        hits.push({ id: canary.id, class: canary.class, encoding: 'token' });
      }
      continue;
    }
    // One hit per canary: the first encoding that matches. (Plain text is often also its own
    // escaped and URL-encoded form; reporting it three times would say nothing more.)
    for (const { encoding, needle, caseInsensitive } of needles(canary)) {
      const found = caseInsensitive ? lower.includes(needle.toLowerCase()) : text.includes(needle);
      if (found) {
        hits.push({ id: canary.id, class: canary.class, encoding });
        break;
      }
    }
  }
  return hits;
}
