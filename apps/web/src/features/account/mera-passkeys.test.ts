import { createPasskeyWithPrfOutput, getPasskeyPrfOutput, MeraError } from '@category-labs/mera';
import { describe, expect, it } from 'vitest';
import { CONFIG } from '@/test-support/account-harness';
import { FakeAuthenticator } from '@/test-support/fake-authenticator';
import { accountPrfSalt, vaultPrfSalt } from './derivation-profile';
import { PasskeyCeremonies, mapPasskeyError } from './mera-passkeys';

const LABELS = { name: 'LexAegis account', displayName: 'LexAegis account' };

function setup(options = {}) {
  const authenticator = new FakeAuthenticator(options);
  const ceremonies = new PasskeyCeremonies(CONFIG, {
    create: createPasskeyWithPrfOutput,
    get: getPasskeyPrfOutput,
    webAuthnClient: authenticator.client,
  });
  return { authenticator, ceremonies };
}
const ok = <T>(result: { ok: true; data: T } | { ok: false; code: string }): T => {
  if (!result.ok) throw new Error(result.code);
  return result.data;
};
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('passkey creation', () => {
  it('uses create-time PRF without an extra assertion when the authenticator provides it', async () => {
    const { authenticator, ceremonies } = setup({ createTimePrf: true });
    const created = ok(await ceremonies.create(LABELS, accountPrfSalt()));
    expect(created.prfOutput).toHaveLength(32);
    expect(created.fallbackAssertion).toBe(false);
    expect(authenticator.calls).toEqual({ create: 1, get: 0 });
    expect(created.credential.credentialId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('records the SDK fallback assertion when PRF is not evaluated at creation', async () => {
    const { authenticator, ceremonies } = setup({ createTimePrf: false });
    const created = ok(await ceremonies.create(LABELS, accountPrfSalt()));
    expect(created.fallbackAssertion).toBe(true);
    expect(authenticator.calls).toEqual({ create: 1, get: 1 });
  });

  it('reports PRF_UNAVAILABLE on an authenticator without PRF, leaving the passkey it created', async () => {
    const { authenticator, ceremonies } = setup({ prfSupported: false });
    expect(await ceremonies.create(LABELS, accountPrfSalt())).toEqual({
      ok: false,
      code: 'PRF_UNAVAILABLE',
    });
    expect(authenticator.credentials).toHaveLength(1);
  });

  it('gives each call a new credential (Mera generates the user handle)', async () => {
    const { authenticator, ceremonies } = setup();
    ok(await ceremonies.create(LABELS, accountPrfSalt()));
    ok(await ceremonies.create(LABELS, accountPrfSalt()));
    expect(authenticator.credentials).toHaveLength(2);
  });

  it('serializes ceremonies: a double click makes one request', async () => {
    const { authenticator, ceremonies } = setup();
    authenticator.hold();
    const first = ceremonies.create(LABELS, accountPrfSalt());
    expect(await ceremonies.create(LABELS, accountPrfSalt())).toEqual({ ok: false, code: 'BUSY' });
    expect(await ceremonies.evaluate(accountPrfSalt())).toEqual({ ok: false, code: 'BUSY' });
    authenticator.release();
    expect((await first).ok).toBe(true);
    expect(authenticator.calls.create).toBe(1);
  });

  it('discards a result that completes after cancellation', async () => {
    const { authenticator, ceremonies } = setup();
    authenticator.hold();
    const pending = ceremonies.create(LABELS, accountPrfSalt());
    ceremonies.cancel();
    authenticator.release();
    expect(await pending).toEqual({ ok: false, code: 'STALE' });
    // The authenticator still made the credential; cancelling cannot undo that.
    expect(authenticator.credentials).toHaveLength(1);
    expect(ceremonies.busy).toBe(false);
  });
});

describe('PRF evaluation', () => {
  it('is stable for one credential and salt, and separate per salt', async () => {
    const { ceremonies } = setup();
    const created = ok(await ceremonies.create(LABELS, accountPrfSalt()));
    const original = hex(created.prfOutput);
    const again = ok(await ceremonies.evaluate(accountPrfSalt(), created.credential));
    const vault = ok(await ceremonies.evaluate(vaultPrfSalt(), created.credential));
    expect(hex(again.prfOutput)).toBe(original);
    expect(hex(vault.prfOutput)).not.toBe(original);
  });

  it('recovers by discovery with no credential metadata at all', async () => {
    const { ceremonies } = setup();
    const created = ok(await ceremonies.create(LABELS, accountPrfSalt()));
    const recovered = ok(await ceremonies.evaluate(accountPrfSalt()));
    expect(recovered.credentialId).toBe(created.credential.credentialId);
    expect(hex(recovered.prfOutput)).toBe(hex(created.prfOutput));
  });

  it('rejects an unexpected credential when one was pinned', async () => {
    const { authenticator, ceremonies } = setup();
    const first = ok(await ceremonies.create(LABELS, accountPrfSalt()));
    ok(await ceremonies.create(LABELS, accountPrfSalt()));
    authenticator.answerWith = authenticator.credentials[1]?.id ?? null;
    const result = await ceremonies.evaluate(accountPrfSalt(), first.credential);
    expect(result.ok).toBe(false);
    expect(!result.ok && ['WRONG_CREDENTIAL', 'FAILED']).toContain(!result.ok && result.code);
  });

  it('never creates an account when recovery finds nothing', async () => {
    const { authenticator, ceremonies } = setup();
    expect((await ceremonies.evaluate(accountPrfSalt())).ok).toBe(false);
    expect(authenticator.calls.create).toBe(0);
    expect(authenticator.credentials).toHaveLength(0);
  });
});

describe('error mapping', () => {
  const passkeyFailure = (name?: string) => {
    const cause = name === undefined ? undefined : Object.assign(new Error(name), { name });
    return new MeraError('PASSKEY_OPERATION_FAILED', 'x', { cause });
  };

  it('maps installed Mera codes to redaction-safe codes', () => {
    expect(mapPasskeyError(new MeraError('PRF_UNAVAILABLE', 'x'))).toBe('PRF_UNAVAILABLE');
    expect(mapPasskeyError(new MeraError('CRYPTO_UNAVAILABLE', 'x'))).toBe('UNSUPPORTED');
    expect(mapPasskeyError(new MeraError('INPUT_INVALID', 'x'))).toBe('FAILED');
    expect(mapPasskeyError(new Error('anything else'))).toBe('FAILED');
  });

  it('tells a confirmed abort from an ambiguous dismissal, and guesses nothing else', () => {
    expect(mapPasskeyError(passkeyFailure('AbortError'))).toBe('CANCELLED');
    // NotAllowedError covers dismissal, timeout and denial alike.
    expect(mapPasskeyError(passkeyFailure('NotAllowedError'))).toBe('NOT_COMPLETED');
    expect(mapPasskeyError(passkeyFailure('SecurityError'))).toBe('UNSUPPORTED');
    expect(mapPasskeyError(passkeyFailure('UnknownError'))).toBe('FAILED');
    expect(mapPasskeyError(passkeyFailure())).toBe('FAILED');
  });

  it('surfaces a dismissed browser prompt as NOT_COMPLETED through the real SDK', async () => {
    const { authenticator, ceremonies } = setup();
    authenticator.failNext = 'NotAllowedError';
    expect(await ceremonies.create(LABELS, accountPrfSalt())).toEqual({
      ok: false,
      code: 'NOT_COMPLETED',
    });
    expect(ceremonies.busy).toBe(false);
  });
});
