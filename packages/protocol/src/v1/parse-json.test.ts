import { describe, expect, it } from 'vitest';
import { ProtocolError } from './errors';
import { assertPlainJson, parseStrictJson, readJsonInput } from './parse-json';
import { encodeUtf8 } from './test-helpers';

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof ProtocolError ? error.code : `OTHER:${String(error)}`;
  }
  return 'NONE';
}

const parse = (text: string) => code(() => parseStrictJson(text));

class Box {
  readonly kind = 'box';
}

describe('strict JSON import', () => {
  it('parses ordinary JSON and preserves decoded string contents exactly', () => {
    const text =
      '{ "a": [1, -2, 0, true, false, null], "s": " caf\\u00e9 \\ud83d\\ude00 e\\u0301 " }';
    const expected = { a: [1, -2, 0, true, false, null], s: ' café 😀 é ' };
    expect(parseStrictJson(text)).toEqual(expected);
    expect(parseStrictJson(encodeUtf8(text))).toEqual(expected);
  });

  it('rejects duplicate member names, including names equal only after escape decoding', () => {
    expect(parse('{"a":1,"a":2}')).toBe('DUPLICATE_KEY');
    expect(parse('{"a":1,"\\u0061":2}')).toBe('DUPLICATE_KEY');
    expect(parse('{"x":{"k":"v","k":"v"}}')).toBe('DUPLICATE_KEY');
    // The same name in different objects is fine.
    expect(parse('{"x":{"k":1},"y":{"k":2}}')).toBe('NONE');
  });

  it.each([
    ['line comment', '// c\n{}'],
    ['block comment', '{/* c */}'],
    ['trailing comma in object', '{"a":1,}'],
    ['trailing comma in array', '[1,]'],
    ['trailing content', '{} {}'],
    ['trailing garbage', '{"a":1}x'],
    ['empty input', ''],
    ['whitespace only', '  \n'],
    ['single quotes', "{'a':1}"],
    ['unquoted key', '{a:1}'],
    ['leading zero', '01'],
    ['leading plus', '+1'],
    ['bare fraction', '.5'],
    ['unterminated array', '[1,2'],
    ['unescaped control character', '"a\tb"'],
    ['invalid escape', '"\\x41"'],
    ['non-breaking space as whitespace', ' 1'],
    ['NaN literal', 'NaN'],
    ['undefined literal', 'undefined'],
  ])('rejects %s as invalid JSON', (_label, text) => {
    expect(parse(text)).toBe('INVALID_JSON');
  });

  it('rejects a byte-order mark in bytes and in text', () => {
    expect(code(() => parseStrictJson(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])))).toBe(
      'BYTE_ORDER_MARK',
    );
    expect(parse('﻿{}')).toBe('BYTE_ORDER_MARK');
  });

  it.each([
    ['truncated sequence', [0x22, 0xc3, 0x22]],
    ['invalid start byte', [0x22, 0xff, 0x22]],
    ['overlong encoding', [0x22, 0xc0, 0xaf, 0x22]],
    ['encoded surrogate', [0x22, 0xed, 0xa0, 0x80, 0x22]],
  ])('rejects malformed UTF-8: %s', (_label, bytes) => {
    expect(code(() => parseStrictJson(new Uint8Array(bytes)))).toBe('INVALID_UTF8');
  });

  it('rejects lone UTF-16 surrogates in values and member names', () => {
    expect(parse('"\\ud800"')).toBe('LONE_SURROGATE');
    expect(parse('"\\udc00\\ud800"')).toBe('LONE_SURROGATE');
    expect(parse('{"\\ud800":1}')).toBe('LONE_SURROGATE');
    expect(parse('"\ud800"')).toBe('LONE_SURROGATE');
    expect(parse('"\\ud83d\\ude00"')).toBe('NONE');
  });

  it.each([
    '9007199254740993',
    '-9007199254740993',
    '1.5',
    '1.0',
    '1e3',
    '1E3',
    '-0',
    '0.0',
    '1e-2',
  ])('rejects the numeric token %s', (token) => {
    expect(parse(token)).toBe('UNSAFE_NUMBER');
    expect(parse(`{"n":${token}}`)).toBe('UNSAFE_NUMBER');
  });

  it('accepts safe plain integers at the boundary', () => {
    expect(parseStrictJson('[9007199254740991,-9007199254740991,0]')).toEqual([
      9007199254740991, -9007199254740991, 0,
    ]);
  });

  it('enforces the nesting limit without overflowing the stack', () => {
    const nested = (depth: number) => `${'['.repeat(depth)}${']'.repeat(depth)}`;
    expect(parse(nested(32))).toBe('NONE');
    expect(parse(nested(33))).toBe('NESTING_TOO_DEEP');
    expect(parse(`${'{"a":'.repeat(33)}1${'}'.repeat(33)}`)).toBe('NESTING_TOO_DEEP');
    expect(parse('['.repeat(200_000))).toBe('NESTING_TOO_DEEP');
  });

  it('checks the size limit before parsing, for bytes and text', () => {
    const limit = 1024 * 1024;
    const big = `"${'a'.repeat(limit)}"`;
    expect(parse(big)).toBe('INPUT_TOO_LARGE');
    expect(code(() => parseStrictJson(encodeUtf8(big)))).toBe('INPUT_TOO_LARGE');
    // Multi-byte text is measured in UTF-8 bytes, not UTF-16 units.
    const multibyte = `"${'€'.repeat(8)}"`;
    expect(code(() => parseStrictJson(multibyte, { maxBytes: 25, maxDepth: 32 }))).toBe(
      'INPUT_TOO_LARGE',
    );
    expect(code(() => parseStrictJson(multibyte, { maxBytes: 26, maxDepth: 32 }))).toBe('NONE');
    // Oversized input is rejected, never truncated to fit.
    expect(code(() => parseStrictJson('[1,2,3]', { maxBytes: 4, maxDepth: 32 }))).toBe(
      'INPUT_TOO_LARGE',
    );
  });

  it.each(['__proto__', 'constructor', 'prototype'])('rejects the member name %s', (name) => {
    expect(parse(`{"${name}":{}}`)).toBe('FORBIDDEN_KEY');
    expect(parse(`{"a":{"${name}":1}}`)).toBe('FORBIDDEN_KEY');
  });

  it('never echoes payload content in an error', () => {
    try {
      parseStrictJson('{"note":"SECRET-CANARY-TEXT","note":"SECRET-CANARY-TEXT"}');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect(JSON.stringify(error)).not.toContain('SECRET-CANARY');
      expect(String(error)).not.toContain('SECRET-CANARY');
      expect(error instanceof Error ? error.message : '').toBe('DUPLICATE_KEY');
    }
  });
});

describe('object-input import', () => {
  const plain = (value: unknown) => code(() => assertPlainJson(value));

  it('returns an independent deep copy of ordinary JSON data', () => {
    const input = { a: [1, { b: 'x' }], n: null, t: true };
    const copy = assertPlainJson(input);
    expect(copy).toEqual(input);
    input.a.push(2);
    (input.a[1] as { b: string }).b = 'changed';
    expect(copy).toEqual({ a: [1, { b: 'x' }], n: null, t: true });
    expect(assertPlainJson(Object.assign(Object.create(null) as object, { k: 'v' }))).toEqual({
      k: 'v',
    });
  });

  it.each([
    ['undefined', { a: undefined }],
    ['bigint', { a: 1n }],
    ['function', { a: () => 1 }],
    ['symbol value', { a: Symbol('s') }],
    ['symbol key', { [Symbol('k')]: 1 }],
    ['Date', { a: new Date(0) }],
    ['Map', { a: new Map() }],
    ['class instance', { a: new Box() }],
    ['typed array', { a: new Uint8Array(1) }],
    ['custom toJSON', { a: { toJSON: () => 'x' } }],
    ['boxed string', { a: new String('x') }],
  ])('rejects %s', (_label, value) => {
    expect(plain(value)).toBe('UNSUPPORTED_VALUE');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 1.5, 2 ** 53])(
    'rejects the number %s',
    (value) => {
      expect(plain({ n: value })).toBe('UNSAFE_NUMBER');
    },
  );

  it('rejects sparse arrays and arrays with extra properties', () => {
    const sparse: unknown[] = [];
    sparse[2] = 1;
    expect(plain(sparse)).toBe('UNSUPPORTED_VALUE');
    const extended = Object.assign([1, 2], { extra: true });
    expect(plain(extended)).toBe('UNSUPPORTED_VALUE');
    class Sub extends Array<number> {}
    expect(plain(Sub.from([1]))).toBe('UNSUPPORTED_VALUE');
  });

  it('rejects cycles but allows a repeated (non-cyclic) reference', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    expect(plain(cyclic)).toBe('UNSUPPORTED_VALUE');
    const shared = { v: 1 };
    expect(plain({ a: shared, b: shared })).toBe('NONE');
  });

  it('rejects accessors and non-enumerable properties', () => {
    const accessor = {};
    Object.defineProperty(accessor, 'a', { get: () => 'x', enumerable: true });
    expect(plain(accessor)).toBe('UNSUPPORTED_VALUE');
    const hidden = {};
    Object.defineProperty(hidden, 'a', { value: 'x', enumerable: false });
    expect(plain(hidden)).toBe('UNSUPPORTED_VALUE');
  });

  it('rejects prototype-manipulation property names', () => {
    expect(plain(JSON.parse('{"__proto__":{"polluted":true}}'))).toBe('FORBIDDEN_KEY');
    expect(plain({ constructor: 'x' })).toBe('FORBIDDEN_KEY');
    expect(plain({ a: { prototype: 'x' } })).toBe('FORBIDDEN_KEY');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects lone surrogates, excessive nesting and oversized data', () => {
    expect(plain({ a: '\ud800' })).toBe('LONE_SURROGATE');
    expect(plain({ '\udc00': 1 })).toBe('LONE_SURROGATE');
    let deep: unknown = 'leaf';
    for (let index = 0; index < 33; index += 1) deep = [deep];
    expect(plain(deep)).toBe('NESTING_TOO_DEEP');
    expect(plain({ big: 'a'.repeat(1024 * 1024 + 1) })).toBe('INPUT_TOO_LARGE');
    // A small structure that expands enormously through shared references is bounded too.
    let bomb: unknown[] = ['x'.repeat(1000)];
    for (let index = 0; index < 20; index += 1) bomb = [bomb, bomb];
    expect(plain(bomb)).toBe('INPUT_TOO_LARGE');
  });

  it('treats a hostile proxy as unsupported input rather than crashing', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('trap');
        },
      },
    );
    expect(plain(hostile)).toBe('UNSUPPORTED_VALUE');
  });

  it('dispatches bytes and text to the strict parser and everything else to the object check', () => {
    expect(readJsonInput('{"a":1}')).toEqual({ a: 1 });
    expect(readJsonInput(encodeUtf8('{"a":1}'))).toEqual({ a: 1 });
    expect(readJsonInput({ a: 1 })).toEqual({ a: 1 });
    expect(code(() => readJsonInput('{"a":1,"a":1}'))).toBe('DUPLICATE_KEY');
    expect(code(() => readJsonInput(new ArrayBuffer(2)))).toBe('UNSUPPORTED_VALUE');
  });
});
