import { describe, expect, it } from 'vitest';
import {
  addMinorUnits,
  formatMinorUnits,
  gbp,
  minorUnitsSchema,
  moneySchema,
  parseMinorUnits,
  subtractMinorUnits,
} from './money';

describe('GBP minor units', () => {
  it('reproduces the control vector 2400000 - (1000000 + 1200000) = 200000 exactly', () => {
    const comparable = addMinorUnits('1000000', '1200000');
    expect(comparable).toBe('2200000');
    expect(subtractMinorUnits('2400000', comparable)).toBe('200000');
  });

  it('stays exact beyond Number.MAX_SAFE_INTEGER', () => {
    const big = '9007199254740993';
    expect(String(Number(big))).not.toBe(big); // a double cannot represent this value
    expect(addMinorUnits(big, '1')).toBe('9007199254740994');
    expect(subtractMinorUnits(big, '9007199254740992')).toBe('1');
  });

  it('never goes through floating point for fractions of a penny', () => {
    expect(minorUnitsSchema.safeParse('0.1').success).toBe(false);
    expect(minorUnitsSchema.safeParse('1e6').success).toBe(false);
    expect(minorUnitsSchema.safeParse('12.50').success).toBe(false);
  });

  it.each(['-0', '+5', '007', '', ' 5', '1,000', '1'.repeat(19)])('rejects %j', (value) => {
    expect(minorUnitsSchema.safeParse(value).success).toBe(false);
  });

  it('accepts signed canonical values at the range boundary', () => {
    expect(minorUnitsSchema.safeParse('-1').success).toBe(true);
    expect(minorUnitsSchema.safeParse('9'.repeat(18)).success).toBe(true);
  });

  it('rejects results outside the supported range instead of wrapping', () => {
    expect(() => addMinorUnits('9'.repeat(18), '1')).toThrow(RangeError);
    expect(() => formatMinorUnits(10n ** 18n)).toThrow(RangeError);
  });

  it('throws on malformed input to the bigint parser', () => {
    expect(() => parseMinorUnits('1.5')).toThrow();
  });

  it('serializes as a decimal string and rejects other currencies or extra fields', () => {
    expect(JSON.stringify(gbp('2200000'))).toBe('{"currency":"GBP","minorUnits":"2200000"}');
    expect(moneySchema.safeParse({ currency: 'USD', minorUnits: '1' }).success).toBe(false);
    expect(moneySchema.safeParse({ currency: 'GBP', minorUnits: '1', extra: 1 }).success).toBe(
      false,
    );
    expect(moneySchema.safeParse({ currency: 'GBP', minorUnits: 100 }).success).toBe(false);
  });
});
