import { z } from 'zod';

/** Positive integer schema version carried by versioned envelopes. */
export const schemaVersionSchema = z.int().min(1).max(1000);
export type SchemaVersion = z.infer<typeof schemaVersionSchema>;

/** Opaque identifier: no structure may be inferred from it. */
export const opaqueIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'invalid identifier');
export type OpaqueId = z.infer<typeof opaqueIdSchema>;

/** 0x-prefixed, exactly 20 bytes. Case is accepted here; Chapter 2 narrows wire fields to lowercase. */
export const evmAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'invalid EVM address');
export type EvmAddress = z.infer<typeof evmAddressSchema>;

/** 0x-prefixed, exactly 32 bytes. */
export const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'invalid bytes32 value');
export type Bytes32 = z.infer<typeof bytes32Schema>;

/** Canonical unsigned decimal string: "0" or a nonzero digit followed by digits (at most 78 digits, the width of uint256). */
export const unsignedDecimalSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, 'invalid unsigned decimal')
  .max(78);
export type UnsignedDecimal = z.infer<typeof unsignedDecimalSchema>;

/** Positive chain identifier serialized as a decimal string. */
export const chainIdSchema = unsignedDecimalSchema.refine((value) => value !== '0', {
  message: 'chain id must be positive',
});

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Validates an RFC 3339 date-time including calendar validity. Never falls back to Date parsing. */
export function isRfc3339Timestamp(value: string): boolean {
  const match = RFC3339.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part));
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return false;
  }
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 60) return false;
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  return offsetHour <= 23 && offsetMinute <= 59;
}

export const rfc3339TimestampSchema = z
  .string()
  .max(40)
  .refine(isRfc3339Timestamp, { message: 'invalid RFC 3339 timestamp' });
export type Rfc3339Timestamp = z.infer<typeof rfc3339TimestampSchema>;
