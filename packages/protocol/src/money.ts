import { z } from 'zod';

export const CURRENCY_GBP = 'GBP' as const;

/** Largest absolute amount, in minor units, accepted at any boundary (18 decimal digits). */
const MAX_DIGITS = 18;

/**
 * Signed integer minor units (pence) as a canonical decimal string. JSON never carries bigint
 * or floating-point money; "-0", leading zeros, signs other than "-", and fractions are rejected.
 */
export const minorUnitsSchema = z
  .string()
  .regex(new RegExp(`^-?(0|[1-9][0-9]{0,${MAX_DIGITS - 1}})$`), 'invalid minor-unit amount')
  .refine((value) => value !== '-0', { message: 'negative zero is not canonical' });
export type MinorUnits = z.infer<typeof minorUnitsSchema>;

export const moneySchema = z.strictObject({
  currency: z.literal(CURRENCY_GBP),
  minorUnits: minorUnitsSchema,
});
export type Money = z.infer<typeof moneySchema>;

const LIMIT = 10n ** BigInt(MAX_DIGITS);

/** Parses a validated minor-unit string to bigint. Throws ZodError on malformed input. */
export function parseMinorUnits(value: string): bigint {
  return BigInt(minorUnitsSchema.parse(value));
}

/** Serializes a bigint amount to its canonical string, rejecting out-of-range values. */
export function formatMinorUnits(value: bigint): string {
  if (value <= -LIMIT || value >= LIMIT) {
    throw new RangeError('amount exceeds the supported minor-unit range');
  }
  return value.toString();
}

export function addMinorUnits(...values: readonly string[]): string {
  return formatMinorUnits(values.reduce((total, value) => total + parseMinorUnits(value), 0n));
}

export function subtractMinorUnits(minuend: string, subtrahend: string): string {
  return formatMinorUnits(parseMinorUnits(minuend) - parseMinorUnits(subtrahend));
}

export function gbp(minorUnits: string): Money {
  return moneySchema.parse({ currency: CURRENCY_GBP, minorUnits });
}
