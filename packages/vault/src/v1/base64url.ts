const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP = new Map(Array.from(ALPHABET, (character, index) => [character, index] as const));

/** Unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    out += ALPHABET.charAt((triple >> 18) & 63) + ALPHABET.charAt((triple >> 12) & 63);
    if (index + 1 < bytes.length) out += ALPHABET.charAt((triple >> 6) & 63);
    if (index + 2 < bytes.length) out += ALPHABET.charAt(triple & 63);
  }
  return out;
}

/** Decodes unpadded base64url, or null for anything malformed. Canonicality is checked by the caller. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let position = 0;
  for (let index = 0; index < text.length; index += 4) {
    let triple = 0;
    const chunk = text.slice(index, index + 4);
    for (let offset = 0; offset < 4; offset += 1) {
      const character = chunk[offset];
      const value = character === undefined ? 0 : LOOKUP.get(character);
      if (value === undefined) return null;
      triple = (triple << 6) | value;
    }
    out[position++] = (triple >> 16) & 255;
    if (chunk.length > 2) out[position++] = (triple >> 8) & 255;
    if (chunk.length > 3) out[position++] = triple & 255;
  }
  return out;
}
