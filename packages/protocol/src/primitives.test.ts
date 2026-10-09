import { describe, expect, it } from 'vitest';
import {
  bytes32Schema,
  chainIdSchema,
  evmAddressSchema,
  isRfc3339Timestamp,
  opaqueIdSchema,
  rfc3339TimestampSchema,
  unsignedDecimalSchema,
} from './primitives';

describe('addresses and digests', () => {
  it('accepts exactly 20-byte and 32-byte 0x values', () => {
    expect(evmAddressSchema.safeParse(`0x${'ab'.repeat(20)}`).success).toBe(true);
    expect(bytes32Schema.safeParse(`0x${'cd'.repeat(32)}`).success).toBe(true);
  });

  it.each([
    ['missing prefix', 'ab'.repeat(20)],
    ['too short', `0x${'ab'.repeat(19)}`],
    ['too long', `0x${'ab'.repeat(21)}`],
    ['non-hex', `0x${'zz'.repeat(20)}`],
    ['surrounding whitespace', ` 0x${'ab'.repeat(20)}`],
    ['a digest used as an address', `0x${'ab'.repeat(32)}`],
  ])('rejects a malformed address: %s', (_label, value) => {
    expect(evmAddressSchema.safeParse(value).success).toBe(false);
  });

  it('rejects a short or non-hex digest', () => {
    expect(bytes32Schema.safeParse(`0x${'ab'.repeat(31)}`).success).toBe(false);
    expect(bytes32Schema.safeParse(`0x${'g'.repeat(64)}`).success).toBe(false);
  });
});

describe('timestamps', () => {
  it.each(['2026-10-14T04:59:00+01:00', '2026-10-14T03:59:00Z', '2028-02-29T00:00:00.123Z'])(
    'accepts %s',
    (value) => {
      expect(rfc3339TimestampSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each([
    ['not a date', 'tomorrow'],
    ['date only', '2026-10-14'],
    ['missing offset', '2026-10-14T03:59:00'],
    ['month 13', '2026-13-01T00:00:00Z'],
    ['Feb 30', '2026-02-30T00:00:00Z'],
    ['non-leap Feb 29', '2027-02-29T00:00:00Z'],
    ['hour 24', '2026-10-14T24:00:00Z'],
    ['offset hour 24', '2026-10-14T00:00:00+24:00'],
  ])('rejects %s', (_label, value) => {
    expect(isRfc3339Timestamp(value)).toBe(false);
  });
});

describe('identifiers and decimals', () => {
  it('rejects ambiguous opaque identifiers', () => {
    expect(opaqueIdSchema.safeParse('matter_01').success).toBe(true);
    expect(opaqueIdSchema.safeParse('a/b').success).toBe(false);
    expect(opaqueIdSchema.safeParse('').success).toBe(false);
  });

  it('requires canonical unsigned decimals and positive chain IDs', () => {
    expect(unsignedDecimalSchema.safeParse('0').success).toBe(true);
    expect(unsignedDecimalSchema.safeParse('007').success).toBe(false);
    expect(unsignedDecimalSchema.safeParse('1e3').success).toBe(false);
    expect(unsignedDecimalSchema.safeParse('-1').success).toBe(false);
    expect(chainIdSchema.safeParse('10143').success).toBe(true);
    expect(chainIdSchema.safeParse('0').success).toBe(false);
  });
});
