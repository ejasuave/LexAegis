import { z } from 'zod';
import { LIMITS } from './constants';
import { countCodePoints, isWellFormedString } from './bytes';

/*
 * Strict v1 wire validators. They refine the Chapter 1 primitives: lowercase only, canonical
 * decimals, exact lengths. Nothing here lowercases, trims, defaults or coerces a value.
 */

/** Lowercase UUIDv4. */
export const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

export function isUuid(value: unknown): value is string {
  return uuidSchema.safeParse(value).success;
}

/** Lowercase 0x-prefixed 20-byte address. */
export const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);

export const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;

/** Registry and reviewer fields additionally reject the zero address. */
export const nonZeroAddressSchema = addressSchema
  .refine((value) => value !== ZERO_ADDRESS, { message: 'zero address' })
  .meta({ not: { const: ZERO_ADDRESS } });

/** Lowercase 0x-prefixed 32-byte digest. */
export const digestSchema = z.string().regex(/^0x[0-9a-f]{64}$/);

/** Lowercase 0x-prefixed 32-byte blinding nonce: same wire shape as a digest, different meaning. */
export const blindingNonceSchema = z.string().regex(/^0x[0-9a-f]{64}$/);

const UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/;

/** "0" or a nonzero digit followed by digits: no leading zeros, signs, whitespace or exponent. */
export const unsignedDecimalSchema = z.string().regex(UNSIGNED_DECIMAL);

/** Safe comparison for decimal strings; malformed input is simply "not within range". */
export function decimalAtMost(value: string, max: bigint): boolean {
  return UNSIGNED_DECIMAL.test(value) && value.length <= 78 && BigInt(value) <= max;
}

const UINT256_MAX = 2n ** 256n - 1n;

/** Positive unsigned decimal string no greater than 2^256 - 1. */
export const chainIdSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(78)
  .refine((value) => decimalAtMost(value, UINT256_MAX), { message: 'exceeds uint256' });

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Valid UTC instant with exactly millisecond precision: YYYY-MM-DDTHH:mm:ss.sssZ. */
export function isCanonicalTimestamp(value: string): boolean {
  const match = TIMESTAMP.exec(value);
  if (!match) return false;
  const [year = NaN, month = NaN, day = NaN, hour = NaN, minute = NaN, second = NaN] = match
    .slice(1, 7)
    .map(Number);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

export const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(isCanonicalTimestamp, { message: 'invalid UTC timestamp' });

/** 1–80 lowercase ASCII letters, digits, dots or hyphens. */
export const profileIdSchema = z.string().regex(/^[a-z0-9.-]{1,80}$/);

/** Positive canonical decimal string. */
export const profileVersionSchema = z.string().regex(/^[1-9][0-9]*$/);

/** Lowercase `type/subtype` without parameters, at most 127 characters. */
export const mediaTypeSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/)
  .max(LIMITS.maxMediaTypeLength);

/** At most 256 Unicode code points, with no lone surrogates. Empty is allowed. */
export const labelSchema = z
  .string()
  .refine(
    (value) =>
      value.length <= LIMITS.maxLabelCodePoints * 2 &&
      isWellFormedString(value) &&
      countCodePoints(value) <= LIMITS.maxLabelCodePoints,
    { message: 'label too long or malformed' },
  )
  .meta({ maxLength: LIMITS.maxLabelCodePoints });

/** Unsigned decimal byte length within the per-artifact limit. */
export const artifactByteLengthSchema = unsignedDecimalSchema.refine(
  (value) => decimalAtMost(value, BigInt(LIMITS.maxArtifactBytes)),
  { message: 'artifact too large', params: { protocolCode: 'ARTIFACT_TOO_LARGE' } },
);
