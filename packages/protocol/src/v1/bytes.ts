import { ProtocolError } from './errors';

/** Bytes backed by an ordinary (non-shared) ArrayBuffer that this module owns. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** True when the string has no lone UTF-16 surrogates. */
export function isWellFormedString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function countCodePoints(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) index += 1;
    count += 1;
  }
  return count;
}

const encoder = new TextEncoder();

/** UTF-8 without a byte-order mark. Lone surrogates are rejected, never replaced. */
export function utf8(text: string): Bytes {
  if (!isWellFormedString(text)) throw new ProtocolError('LONE_SURROGATE');
  return encoder.encode(text);
}

/** Raw-byte concatenation. */
export function concatBytes(...parts: readonly Uint8Array[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const HEX = '0123456789abcdef';

/** Lowercase, 0x-prefixed hexadecimal. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '0x';
  for (const byte of bytes) out += `${HEX.charAt(byte >> 4)}${HEX.charAt(byte & 0x0f)}`;
  return out;
}

const STRICT_HEX = /^0x(?:[0-9a-f]{2})*$/;

/** Decodes strict lowercase 0x-prefixed hex. Never hashes or compares hex text in place of bytes. */
export function hexToBytes(hex: string, expectedLength?: number): Bytes {
  if (typeof hex !== 'string' || !STRICT_HEX.test(hex)) throw new ProtocolError('INVALID_HEX');
  const length = (hex.length - 2) / 2;
  if (expectedLength !== undefined && length !== expectedLength) {
    throw new ProtocolError('INVALID_BYTE_LENGTH');
  }
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    out[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return out;
}

function isSharedBuffer(buffer: unknown): boolean {
  return Object.prototype.toString.call(buffer) === '[object SharedArrayBuffer]';
}

function isDetached(buffer: ArrayBufferLike): boolean {
  const flag = (buffer as { detached?: unknown }).detached;
  if (typeof flag === 'boolean') return flag;
  try {
    // Engines without ArrayBuffer.prototype.detached throw when a view is built on a detached buffer.
    new Uint8Array(buffer, 0, 0);
    return false;
  } catch {
    return true;
  }
}

/** Validates caller bytes without copying. Shared and detached buffers are invalid input. */
export function assertUsableBytes(input: unknown): asserts input is Uint8Array {
  if (!(input instanceof Uint8Array)) throw new ProtocolError('ARTIFACT_INPUT_INVALID');
  if (isSharedBuffer(input.buffer) || isDetached(input.buffer)) {
    throw new ProtocolError('ARTIFACT_INPUT_INVALID');
  }
}

/**
 * Returns an independent copy of caller-supplied bytes. Must be called synchronously, before any
 * await, so later caller mutation cannot change what is hashed.
 */
export function captureBytes(input: unknown): Bytes {
  assertUsableBytes(input);
  return input.slice();
}

/** Recursively freezes plain JSON data. Typed arrays are never passed here. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
