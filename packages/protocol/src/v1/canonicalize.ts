import serialize from 'canonicalize';
import { utf8, type Bytes } from './bytes';
import { LIMITS } from './constants';
import { ProtocolError } from './errors';
import { assertPlainJson, DEFAULT_JSON_LIMITS, type JsonLimits } from './parse-json';
import { readReviewPackage } from './parse';

/**
 * RFC 8785 (JCS) canonical UTF-8 bytes of plain JSON data: recursive UTF-16 code-unit property
 * ordering, preserved array order, no Unicode normalization, no byte-order mark. The input is
 * first copied and checked, so accessors, custom prototypes and unsafe numbers never reach the
 * serializer.
 */
export function canonicalizeJson(value: unknown, limits: JsonLimits = DEFAULT_JSON_LIMITS): Bytes {
  const text = serialize(assertPlainJson(value, limits));
  if (text === undefined) throw new ProtocolError('UNSUPPORTED_VALUE');
  const bytes = utf8(text);
  if (bytes.byteLength > limits.maxBytes) throw new ProtocolError('INPUT_TOO_LARGE');
  return bytes;
}

/**
 * canonicalBytes = UTF8(JCS(validatedManifest)).
 * The manifest is strictly validated first; an invalid manifest has no canonical form.
 */
export function canonicalizeReviewPackage(manifest: unknown): Bytes {
  return canonicalizeJson(readReviewPackage(manifest), {
    maxBytes: LIMITS.maxJsonBytes,
    maxDepth: LIMITS.maxDepth,
  });
}
