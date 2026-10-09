import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { applicationErrorSchema, createApplicationError } from './errors';
import { fail, ok, resultSchema, unavailable } from './result';
import {
  packageIntegritySchema,
  receiptLifecycleSchema,
  signerAcceptanceSchema,
  unknownVerificationStatus,
  verificationStatusSchema,
} from './states';

describe('result and error contracts', () => {
  const schema = resultSchema(z.strictObject({ value: z.string() }));

  it('accepts a success and a validated failure', () => {
    expect(schema.safeParse(ok({ value: 'x' })).success).toBe(true);
    const failure = fail(createApplicationError('INVALID_INPUT', 'Bad input.'));
    expect(schema.safeParse(failure).success).toBe(true);
  });

  it('rejects ambiguous envelopes', () => {
    expect(schema.safeParse({ ok: true, data: { value: 'x' }, error: {} }).success).toBe(false);
    expect(schema.safeParse({ ok: false, data: { value: 'x' } }).success).toBe(false);
    expect(schema.safeParse({ ok: true, data: { value: 'x', extra: 1 } }).success).toBe(false);
  });

  it('error schema is closed: no free-form details can carry payloads', () => {
    const base = { code: 'INTERNAL', message: 'Boom.', requestId: 'req_1' };
    expect(applicationErrorSchema.safeParse(base).success).toBe(true);
    expect(applicationErrorSchema.safeParse({ ...base, details: 'secret' }).success).toBe(false);
    expect(applicationErrorSchema.safeParse({ ...base, code: 'WHATEVER' }).success).toBe(false);
  });

  it('unavailable capabilities return a typed failure, never success', () => {
    const result = unavailable('NOT_IMPLEMENTED', 'Receipt submission');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_IMPLEMENTED');
      expect(applicationErrorSchema.safeParse(result.error).success).toBe(true);
    }
    const unconfigured = unavailable('NOT_CONFIGURED', 'Qwen');
    expect(!unconfigured.ok && unconfigured.error.code).toBe('NOT_CONFIGURED');
  });
});

describe('separated verification states', () => {
  it('keeps the three dimensions independent and defaults every one to unknown', () => {
    expect(unknownVerificationStatus()).toEqual({
      packageIntegrity: 'unknown',
      receiptLifecycle: 'unknown',
      signerAcceptance: 'unknown',
    });
  });

  it('matching bytes can coexist with any lifecycle and signer outcome', () => {
    const status = verificationStatusSchema.parse({
      packageIntegrity: 'match',
      receiptLifecycle: 'revoked',
      signerAcceptance: 'rejected',
    });
    expect(status.packageIntegrity).toBe('match');
    expect(status.receiptLifecycle).toBe('revoked');
  });

  it('does not allow one dimension to carry another dimension’s values or a collapsed flag', () => {
    expect(packageIntegritySchema.safeParse('active').success).toBe(false);
    expect(receiptLifecycleSchema.safeParse('match').success).toBe(false);
    expect(signerAcceptanceSchema.safeParse('match').success).toBe(false);
    expect(verificationStatusSchema.safeParse({ valid: true }).success).toBe(false);
    expect(
      verificationStatusSchema.safeParse({
        packageIntegrity: 'match',
        receiptLifecycle: 'active',
        signerAcceptance: 'accepted',
        valid: true,
      }).success,
    ).toBe(false);
    expect(verificationStatusSchema.safeParse({ packageIntegrity: 'match' }).success).toBe(false);
  });
});
