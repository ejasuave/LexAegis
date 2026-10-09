import { visit } from 'jsonc-parser';
import { isWellFormedString } from './bytes';
import { LIMITS } from './constants';
import { ProtocolError } from './errors';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface JsonLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
}

export const DEFAULT_JSON_LIMITS: JsonLimits = Object.freeze({
  maxBytes: LIMITS.maxJsonBytes,
  maxDepth: LIMITS.maxDepth,
});

/** Property names that could manipulate prototypes are never accepted. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Only plain integer literals are allowed; amounts, chain IDs and lengths travel as strings. */
const INTEGER_LITERAL = /^-?(?:0|[1-9][0-9]*)$/;

function decodeUtf8(bytes: Uint8Array, limits: JsonLimits): string {
  if (bytes.byteLength > limits.maxBytes) throw new ProtocolError('INPUT_TOO_LARGE');
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new ProtocolError('BYTE_ORDER_MARK');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ProtocolError('INVALID_UTF8');
  }
}

function checkText(text: string, limits: JsonLimits): void {
  // UTF-8 length is never smaller than the UTF-16 length, so this bounds work before encoding.
  if (text.length > limits.maxBytes) throw new ProtocolError('INPUT_TOO_LARGE');
  if (!isWellFormedString(text)) throw new ProtocolError('LONE_SURROGATE');
  if (new TextEncoder().encode(text).byteLength > limits.maxBytes) {
    throw new ProtocolError('INPUT_TOO_LARGE');
  }
  if (text.charCodeAt(0) === 0xfeff) throw new ProtocolError('BYTE_ORDER_MARK');
}

type Frame =
  | { kind: 'object'; value: JsonObject; keys: Set<string>; pendingKey: string | null }
  | { kind: 'array'; value: JsonValue[] };

function sameJson(left: JsonValue, right: unknown): boolean {
  if (left === null || typeof left !== 'object') return Object.is(left, right);
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      right.length === left.length &&
      left.every((item, index) => sameJson(item, right[index]))
    );
  }
  if (right === null || typeof right !== 'object' || Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const record = right as Record<string, unknown>;
  return (
    Object.keys(record).length === leftKeys.length &&
    leftKeys.every((key) => {
      const value = left[key];
      return value !== undefined && Object.hasOwn(record, key) && sameJson(value, record[key]);
    })
  );
}

function parseText(text: string, limits: JsonLimits): JsonValue {
  const stack: Frame[] = [];
  let root: JsonValue | undefined;

  const attach = (value: JsonValue): void => {
    const top = stack.at(-1);
    if (top === undefined) {
      if (root !== undefined) throw new ProtocolError('INVALID_JSON');
      root = value;
    } else if (top.kind === 'array') {
      top.value.push(value);
    } else {
      if (top.pendingKey === null) throw new ProtocolError('INVALID_JSON');
      top.value[top.pendingKey] = value;
      top.pendingKey = null;
    }
  };
  const open = (frame: Frame): void => {
    // Checked before descending, so hostile nesting stops at the limit rather than the stack.
    if (stack.length >= limits.maxDepth) throw new ProtocolError('NESTING_TOO_DEEP');
    attach(frame.value);
    stack.push(frame);
  };
  const close = (): void => {
    if (stack.pop() === undefined) throw new ProtocolError('INVALID_JSON');
  };

  // The tokenizer reports each member name before any object is built, so duplicates (including
  // names that are equal only after escape decoding) are seen instead of silently overwritten.
  visit(
    text,
    {
      onObjectBegin: () => {
        open({ kind: 'object', value: {}, keys: new Set(), pendingKey: null });
      },
      onObjectProperty: (name: string) => {
        const top = stack.at(-1);
        if (top?.kind !== 'object') throw new ProtocolError('INVALID_JSON');
        if (!isWellFormedString(name)) throw new ProtocolError('LONE_SURROGATE');
        if (FORBIDDEN_KEYS.has(name)) throw new ProtocolError('FORBIDDEN_KEY');
        if (top.keys.has(name)) throw new ProtocolError('DUPLICATE_KEY');
        top.keys.add(name);
        top.pendingKey = name;
      },
      onObjectEnd: close,
      onArrayBegin: () => {
        open({ kind: 'array', value: [] });
      },
      onArrayEnd: close,
      onLiteralValue: (value: unknown, offset: number, length: number) => {
        if (typeof value === 'number') {
          const raw = text.slice(offset, offset + length);
          if (!INTEGER_LITERAL.test(raw) || raw === '-0' || !Number.isSafeInteger(value)) {
            throw new ProtocolError('UNSAFE_NUMBER');
          }
          attach(value);
        } else if (typeof value === 'string') {
          if (!isWellFormedString(value)) throw new ProtocolError('LONE_SURROGATE');
          attach(value);
        } else if (typeof value === 'boolean' || value === null) {
          attach(value);
        } else {
          throw new ProtocolError('INVALID_JSON');
        }
      },
      onComment: () => {
        throw new ProtocolError('INVALID_JSON');
      },
      // Every tokenizer or grammar error is fatal: comments, trailing commas, trailing content.
      onError: () => {
        throw new ProtocolError('INVALID_JSON');
      },
    },
    { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false },
  );

  if (root === undefined || stack.length !== 0) throw new ProtocolError('INVALID_JSON');

  // Independent grammar gate: the engine's own parser must accept the text and agree on the value.
  let native: unknown;
  try {
    native = JSON.parse(text);
  } catch {
    throw new ProtocolError('INVALID_JSON');
  }
  if (!sameJson(root, native)) throw new ProtocolError('INVALID_JSON');
  return root;
}

/**
 * Strict JSON import from raw UTF-8 bytes or text. Rejects a byte-order mark, malformed UTF-8,
 * duplicate member names, comments, trailing commas or content, excessive nesting, lone
 * surrogates, and any number that is not a safe plain integer literal.
 */
export function parseStrictJson(
  input: Uint8Array | string,
  limits: JsonLimits = DEFAULT_JSON_LIMITS,
): JsonValue {
  let text: string;
  if (typeof input === 'string') {
    checkText(input, limits);
    text = input;
  } else {
    text = decodeUtf8(input, limits);
    if (text.charCodeAt(0) === 0xfeff) throw new ProtocolError('BYTE_ORDER_MARK');
  }
  return parseText(text, limits);
}

/**
 * Object-input import. Accepts ordinary JSON data only and returns an independent deep copy.
 * Rejects undefined, bigint, functions, symbols, non-finite or non-integer numbers, negative
 * zero, sparse arrays, cycles, accessors, custom prototypes (which covers custom toJSON) and
 * prototype-manipulation property names.
 */
export function assertPlainJson(
  input: unknown,
  limits: JsonLimits = DEFAULT_JSON_LIMITS,
): JsonValue {
  const ancestors = new Set<object>();
  // Bounds total work, including values shared many times within one structure.
  let budget = limits.maxBytes;
  const charge = (cost: number): void => {
    budget -= cost;
    if (budget < 0) throw new ProtocolError('INPUT_TOO_LARGE');
  };

  const clone = (value: unknown, depth: number): JsonValue => {
    charge(1);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      charge(value.length);
      if (!isWellFormedString(value)) throw new ProtocolError('LONE_SURROGATE');
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        throw new ProtocolError('UNSAFE_NUMBER');
      }
      return value;
    }
    if (typeof value !== 'object') throw new ProtocolError('UNSUPPORTED_VALUE');
    if (depth >= limits.maxDepth) throw new ProtocolError('NESTING_TOO_DEEP');
    if (ancestors.has(value)) throw new ProtocolError('UNSUPPORTED_VALUE');
    ancestors.add(value);
    try {
      const prototype: unknown = Object.getPrototypeOf(value);
      if (Array.isArray(value)) {
        // Exactly the indexes plus "length": no holes and no extra properties.
        if (prototype !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
          throw new ProtocolError('UNSUPPORTED_VALUE');
        }
        const out: JsonValue[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, index);
          if (descriptor === undefined || !('value' in descriptor)) {
            throw new ProtocolError('UNSUPPORTED_VALUE');
          }
          out.push(clone(descriptor.value, depth + 1));
        }
        return out;
      }
      if (prototype !== Object.prototype && prototype !== null) {
        throw new ProtocolError('UNSUPPORTED_VALUE');
      }
      const out: JsonObject = {};
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') throw new ProtocolError('UNSUPPORTED_VALUE');
        if (FORBIDDEN_KEYS.has(key)) throw new ProtocolError('FORBIDDEN_KEY');
        charge(key.length);
        if (!isWellFormedString(key)) throw new ProtocolError('LONE_SURROGATE');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !('value' in descriptor) ||
          descriptor.enumerable !== true
        ) {
          throw new ProtocolError('UNSUPPORTED_VALUE');
        }
        out[key] = clone(descriptor.value, depth + 1);
      }
      return out;
    } finally {
      ancestors.delete(value);
    }
  };

  try {
    return clone(input, 0);
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    // Hostile objects (throwing proxies and the like) are unsupported input, not a crash.
    throw new ProtocolError('UNSUPPORTED_VALUE');
  }
}

/** Raw bytes and text go through strict JSON parsing; anything else must be plain JSON data. */
export function readJsonInput(input: unknown, limits: JsonLimits = DEFAULT_JSON_LIMITS): JsonValue {
  if (typeof input === 'string' || input instanceof Uint8Array) {
    return parseStrictJson(input, limits);
  }
  return assertPlainJson(input, limits);
}
