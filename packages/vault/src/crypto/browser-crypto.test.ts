import { describe, expect, it } from 'vitest';
import { decodeEnvelope, encodeEnvelope, matchesReference, referenceOf } from '../v1/encoding';
import { fromBase64Url, toBase64Url } from '../v1/base64url';
import { VAULT_LIMITS } from '../v1/constants';
import { sealWithEntropy, VaultKeys } from './browser-crypto';
import { BINDING, OWNER, RP_ID, VAULT_ID, fromHex, toHex, vaultVectors } from '../test-vectors';

/*
 * Expected bytes come from fixtures/vault-v1/vectors.json, produced independently with
 * node:crypto (OpenSSL HKDF and AES-GCM). These tests drive browser Web Crypto.
 */

async function baseKey(prf: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', prf.slice(), 'HKDF', false, ['deriveKey']);
}

async function keysFrom(prf: Uint8Array): Promise<VaultKeys> {
  const keys = await VaultKeys.fromPrf(prf);
  if (!keys.ok) throw new Error(keys.code);
  return keys.data;
}

const PRF_A = fromHex(vaultVectors[0]?.prfOutput ?? '0x');
const bytes = (text: string) => new TextEncoder().encode(text);

describe('vault crypto vectors', () => {
  it.each(vaultVectors.map((v) => [v.id, v] as const))(
    'reproduces %s byte for byte',
    async (_id, vector) => {
      const header = vector.expected.envelope.header;
      const sealed = await sealWithEntropy(
        await baseKey(fromHex(vector.prfOutput)),
        {
          vaultId: header.vaultId ?? '',
          ownerAddress: header.ownerAddress ?? '',
          rpId: header.rpId ?? '',
        },
        fromHex(vector.plaintextHex),
        'artifact',
        {
          objectId: header.objectId ?? '',
          hkdfSalt: fromHex(vector.hkdfSalt),
          iv: fromHex(vector.iv),
        },
      );
      if (!sealed.ok) throw new Error(sealed.code);
      expect(toHex(sealed.data.bytes)).toBe(vector.expected.envelopeWireHex);
      expect(sealed.data.ref).toEqual({
        objectId: header.objectId,
        envelopeSha256: vector.expected.envelopeSha256,
        envelopeByteLength: vector.expected.envelopeByteLength,
      });
      const envelope = decodeEnvelope(sealed.data.bytes);
      expect(envelope.ok && envelope.data).toEqual(vector.expected.envelope);
      expect(
        toHex(fromBase64Url(envelope.ok ? envelope.data.ciphertext : '') ?? new Uint8Array()),
      ).toBe(vector.expected.ciphertextHex);
    },
  );

  it.each(vaultVectors.map((v) => [v.id, v] as const))(
    'decrypts %s to the exact plaintext',
    async (_id, vector) => {
      const keys = await keysFrom(fromHex(vector.prfOutput));
      const header = vector.expected.envelope.header;
      const plaintext = await keys.decrypt(
        fromHex(vector.expected.envelopeWireHex),
        {
          vaultId: header.vaultId ?? '',
          ownerAddress: header.ownerAddress ?? '',
          rpId: header.rpId ?? '',
          ref: {
            objectId: header.objectId ?? '',
            envelopeSha256: vector.expected.envelopeSha256,
            envelopeByteLength: vector.expected.envelopeByteLength,
          },
        },
        'artifact',
      );
      expect(plaintext.ok && toHex(plaintext.data)).toBe(vector.plaintextHex);
    },
  );
});

describe('encrypt and decrypt', () => {
  async function sealed(plaintext = 'hello vault') {
    const keys = await keysFrom(PRF_A);
    const result = await keys.encrypt(BINDING, bytes(plaintext), 'structured');
    if (!result.ok) throw new Error(result.code);
    return { keys, ...result.data };
  }

  it('round-trips and never shows plaintext in the envelope', async () => {
    const { keys, bytes: wire, ref } = await sealed('SENTINEL-plaintext-0123');
    expect(new TextDecoder().decode(wire)).not.toContain('SENTINEL');
    const opened = await keys.decrypt(wire, { ...BINDING, ref }, 'structured');
    expect(opened.ok && new TextDecoder().decode(opened.data)).toBe('SENTINEL-plaintext-0123');
    expect(await matchesReference(ref, wire)).toBe(true);
  });

  it('uses a fresh object ID, salt and IV for every object, even for identical plaintext', async () => {
    const keys = await keysFrom(PRF_A);
    const a = await keys.encrypt(BINDING, bytes('same'), 'structured');
    const b = await keys.encrypt(BINDING, bytes('same'), 'structured');
    if (!a.ok || !b.ok) throw new Error('seal failed');
    const [ea, eb] = [decodeEnvelope(a.data.bytes), decodeEnvelope(b.data.bytes)];
    if (!ea.ok || !eb.ok) throw new Error('decode failed');
    expect(ea.data.header.objectId).not.toBe(eb.data.header.objectId);
    expect(ea.data.header.hkdfSalt).not.toBe(eb.data.header.hkdfSalt);
    expect(ea.data.header.iv).not.toBe(eb.data.header.iv);
    expect(ea.data.ciphertext).not.toBe(eb.data.ciphertext);
    expect(ea.data.header.objectId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('encrypts an owned snapshot: mutating the input afterwards changes nothing', async () => {
    const keys = await keysFrom(PRF_A);
    const input = bytes('snapshot me');
    const pending = keys.encrypt(BINDING, input, 'structured');
    input.fill(0);
    const result = await pending;
    if (!result.ok) throw new Error(result.code);
    const opened = await keys.decrypt(
      result.data.bytes,
      { ...BINDING, ref: result.data.ref },
      'structured',
    );
    expect(opened.ok && new TextDecoder().decode(opened.data)).toBe('snapshot me');
  });

  it('a retry resends the identical envelope, an edit makes a new one', async () => {
    const { keys, bytes: first, ref } = await sealed('v1');
    expect(await referenceOf(ref.objectId, first)).toEqual(ref);
    const edited = await keys.encrypt(BINDING, bytes('v2'), 'structured');
    expect(edited.ok && edited.data.ref.objectId).not.toBe(ref.objectId);
  });
});

describe('everything that is wrong fails before plaintext is released', () => {
  async function fixture() {
    const keys = await keysFrom(PRF_A);
    const made = await keys.encrypt(BINDING, bytes('secret evidence'), 'structured');
    if (!made.ok) throw new Error(made.code);
    const envelope = decodeEnvelope(made.data.bytes);
    if (!envelope.ok) throw new Error('decode');
    return { keys, ...made.data, envelope: envelope.data };
  }
  const reencode = (envelope: unknown) => {
    const encoded = encodeEnvelope(envelope as never);
    if (!encoded.ok) throw new Error(encoded.code);
    return encoded.data;
  };
  const open = (f: Awaited<ReturnType<typeof fixture>>, wire: Uint8Array, over: object = {}) =>
    f.keys.decrypt(wire, { ...BINDING, objectId: f.ref.objectId, ...over }, 'structured');

  it('a wrong PRF output is an integrity failure, not a partial result', async () => {
    const f = await fixture();
    const wrong = await keysFrom(fromHex(vaultVectors[2]?.prfOutput ?? '0x'));
    expect(
      await wrong.decrypt(f.bytes, { ...BINDING, objectId: f.ref.objectId }, 'structured'),
    ).toEqual({ ok: false, code: 'INTEGRITY' });
  });

  it('a flipped ciphertext or tag byte fails', async () => {
    const f = await fixture();
    const raw = fromBase64Url(f.envelope.ciphertext) ?? new Uint8Array();
    for (const index of [0, raw.length - 1]) {
      const copy = raw.slice();
      copy[index] = (copy[index] ?? 0) ^ 1;
      const wire = reencode({ ...f.envelope, ciphertext: toBase64Url(copy) });
      expect(await open(f, wire)).toEqual({ ok: false, code: 'INTEGRITY' });
    }
  });

  it.each([
    ['hkdfSalt', 'hkdfSalt'],
    ['iv', 'iv'],
  ])('an altered %s fails', async (_label, field) => {
    const f = await fixture();
    const value =
      fromBase64Url((f.envelope.header as Record<string, string>)[field] ?? '') ?? new Uint8Array();
    value[0] = (value[0] ?? 0) ^ 1;
    const wire = reencode({
      ...f.envelope,
      header: { ...f.envelope.header, [field]: toBase64Url(value) },
    });
    expect(await open(f, wire)).toEqual({ ok: false, code: 'INTEGRITY' });
  });

  it('swapped owner, vault, rpId and object ID are caught by the binding', async () => {
    const f = await fixture();
    const other = {
      ownerAddress: `0x${'44'.repeat(20)}`,
      vaultId: 'b0000000-0000-4000-8000-0000000000ff',
      rpId: 'other.test',
      objectId: 'b0000000-0000-4000-8000-0000000000fe',
    };
    for (const [field, value] of Object.entries(other)) {
      // The header says one thing and the caller expects another.
      expect(await open(f, f.bytes, { [field]: value })).toEqual({ ok: false, code: 'INTEGRITY' });
      // The header is rewritten to match the caller, but the tag no longer authenticates it.
      const wire = reencode({ ...f.envelope, header: { ...f.envelope.header, [field]: value } });
      expect(await open(f, wire, { [field]: value })).toEqual({ ok: false, code: 'INTEGRITY' });
    }
    expect(OWNER).not.toBe(other.ownerAddress);
    expect(VAULT_ID).not.toBe(other.vaultId);
    expect(RP_ID).not.toBe(other.rpId);
  });

  it('an object that does not match its reference is rejected before decryption', async () => {
    const f = await fixture();
    const other = await f.keys.encrypt(BINDING, bytes('another'), 'structured');
    if (!other.ok) throw new Error('seal');
    expect(
      await f.keys.decrypt(other.data.bytes, { ...BINDING, ref: f.ref }, 'structured'),
    ).toEqual({ ok: false, code: 'REFERENCE_MISMATCH' });
    const longer = new Uint8Array([...f.bytes, 32]);
    expect(await f.keys.decrypt(longer, { ...BINDING, ref: f.ref }, 'structured')).toEqual({
      ok: false,
      code: 'REFERENCE_MISMATCH',
    });
  });

  it('malformed base64url, unknown fields, unknown versions and non-canonical bytes are rejected', async () => {
    const f = await fixture();
    const text = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const cases: [string, Uint8Array, string][] = [
      [
        'padding in ciphertext',
        text({ ...f.envelope, ciphertext: `${f.envelope.ciphertext}==` }),
        'ENVELOPE_INVALID',
      ],
      [
        'standard base64 alphabet',
        text({ ...f.envelope, ciphertext: 'a+b/' + f.envelope.ciphertext }),
        'ENVELOPE_INVALID',
      ],
      [
        'a short salt',
        text({ ...f.envelope, header: { ...f.envelope.header, hkdfSalt: 'AAAA' } }),
        'ENVELOPE_INVALID',
      ],
      ['an unknown field', text({ ...f.envelope, extra: 1 }), 'ENVELOPE_INVALID'],
      [
        'an unknown header field',
        text({ ...f.envelope, header: { ...f.envelope.header, note: 'x' } }),
        'ENVELOPE_INVALID',
      ],
      [
        'a future version',
        text({
          ...f.envelope,
          header: { ...f.envelope.header, schema: 'lexaegis.vault-object.v2' },
        }),
        'UNSUPPORTED_VERSION',
      ],
      [
        'another crypto profile',
        text({ ...f.envelope, header: { ...f.envelope.header, cryptoProfileId: 'x.v2' } }),
        'UNSUPPORTED_VERSION',
      ],
      [
        'non-canonical JSON (spaces)',
        new TextEncoder().encode(JSON.stringify(f.envelope, null, 1)),
        'ENVELOPE_INVALID',
      ],
      [
        'duplicate keys',
        new TextEncoder().encode(
          `${new TextDecoder().decode(f.bytes).slice(0, -1)},"ciphertext":"AAAA"}`,
        ),
        'ENVELOPE_INVALID',
      ],
      ['invalid UTF-8', new Uint8Array([0x7b, 0xff, 0x7d]), 'ENVELOPE_INVALID'],
      ['not JSON', bytes('hello'), 'ENVELOPE_INVALID'],
      ['empty input', new Uint8Array(), 'ENVELOPE_INVALID'],
    ];
    for (const [label, wire, code] of cases) {
      expect(await open(f, wire), label).toEqual({ ok: false, code });
    }
  });

  it('oversized input is rejected before any decoding', async () => {
    const f = await fixture();
    const huge = new Uint8Array(VAULT_LIMITS.maxEnvelopeBytes + 1);
    expect(await open(f, huge)).toEqual({ ok: false, code: 'TOO_LARGE' });
    const tooBigPlain = new Uint8Array(VAULT_LIMITS.maxStructuredBytes + 1);
    expect(await f.keys.encrypt(BINDING, tooBigPlain, 'structured')).toEqual({
      ok: false,
      code: 'TOO_LARGE',
    });
    expect(
      (await f.keys.encrypt(BINDING, new Uint8Array(VAULT_LIMITS.maxStructuredBytes), 'structured'))
        .ok,
    ).toBe(true);
    expect(
      await f.keys.encrypt(BINDING, new Uint8Array(VAULT_LIMITS.maxArtifactBytes + 1), 'artifact'),
    ).toEqual({ ok: false, code: 'TOO_LARGE' });
  });

  it('a disposed vault fails closed for every operation', async () => {
    const f = await fixture();
    f.keys.dispose();
    expect(f.keys.unlocked).toBe(false);
    expect(await f.keys.encrypt(BINDING, bytes('x'), 'structured')).toEqual({
      ok: false,
      code: 'KEY_UNAVAILABLE',
    });
    expect(await open(f, f.bytes)).toEqual({ ok: false, code: 'KEY_UNAVAILABLE' });
  });

  it('refuses a PRF output of the wrong length', async () => {
    for (const length of [0, 16, 31, 33, 64]) {
      expect(await VaultKeys.fromPrf(new Uint8Array(length))).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
      });
    }
  });

  it('keeps the key non-extractable and never exposes a handle', async () => {
    const keys = await keysFrom(PRF_A);
    expect(Object.keys(keys)).toEqual([]);
    expect(JSON.stringify(keys)).toBe('{}');
    await expect(crypto.subtle.exportKey('raw', await baseKey(PRF_A))).rejects.toThrow();
  });
});
