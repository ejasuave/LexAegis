import { artifactDigest, canonicalizeJson } from '@lexaegis/protocol/v1';

export type Digest = string;

/** SHA-256 of exact bytes, as 0x-lowercase hex (Chapter 2's artifact digest). */
export const sha256Bytes = (bytes: Uint8Array): Promise<Digest> => artifactDigest(bytes);

/** SHA-256 of RFC 8785 canonical JSON, UTF-8 encoded. */
export function canonicalBytes(value: unknown): Uint8Array {
  return canonicalizeJson(value);
}
export const canonicalDigest = (value: unknown): Promise<Digest> =>
  artifactDigest(canonicalBytes(value));

export type Result<T, C extends string = string> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly code: C };
export const ok = <T>(data: T): { ok: true; data: T } => ({ ok: true, data });
export const fail = <C extends string>(code: C): { ok: false; code: C } => ({ ok: false, code });
