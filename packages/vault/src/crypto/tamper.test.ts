import { describe, expect, it } from 'vitest';
import { decodeEnvelope, encodeEnvelope, referenceOf } from '../v1/encoding';
import { fromBase64Url, toBase64Url } from '../v1/base64url';
import { VaultKeys } from './browser-crypto';
import { BINDING, fromHex, vaultVectors } from '../test-vectors';

/*
 * Chapter 12: the remaining tamper cases, in browser Web Crypto when run by `pnpm vault:browser`.
 * Truncation, swapped valid objects between owners and vaults, and the rule that a failure never echoes
 * plaintext, key material or ciphertext. Complements browser-crypto.test.ts, which covers salt, IV,
 * tag, owner, rpId, object ID, reference mismatch and wire-format rules.
 */

const PRF = fromHex(vaultVectors[0]?.prfOutput ?? '0x');
const SECRET = 'SYNTHETIC-secret-evidence-7f3a';
const encode = (text: string) => new TextEncoder().encode(text);

async function keys(): Promise<VaultKeys> {
  const made = await VaultKeys.fromPrf(PRF);
  if (!made.ok) throw new Error(made.code);
  return made.data;
}

interface Binding {
  readonly vaultId: string;
  readonly ownerAddress: string;
  readonly rpId: string;
}

async function seal(vault: VaultKeys, binding: Binding, text = SECRET) {
  const made = await vault.encrypt(binding, encode(text), 'structured');
  if (!made.ok) throw new Error(made.code);
  const envelope = decodeEnvelope(made.data.bytes);
  if (!envelope.ok) throw new Error('decode');
  return { ...made.data, envelope: envelope.data };
}

const rewrite = (envelope: unknown): Uint8Array => {
  const encoded = encodeEnvelope(envelope as never);
  if (!encoded.ok) throw new Error(encoded.code);
  return encoded.data;
};

describe('[vault-browser-crypto-tamper] truncation and length', () => {
  it('a truncated or emptied ciphertext fails authentication, never a short plaintext', async () => {
    const vault = await keys();
    const made = await seal(vault, BINDING);
    const raw = fromBase64Url(made.envelope.ciphertext) ?? new Uint8Array();
    // Lengths the strict envelope encoder will still write: the tag alone, and one byte short.
    for (const length of [16, raw.length - 1]) {
      const wire = rewrite({ ...made.envelope, ciphertext: toBase64Url(raw.slice(0, length)) });
      const opened = await vault.decrypt(
        wire,
        { ...BINDING, objectId: made.ref.objectId },
        'structured',
      );
      expect(opened.ok).toBe(false);
    }
    // Shorter than a tag cannot even be written canonically: a hand-built wire form is refused too.
    for (const length of [0, 1, 15]) {
      const wire = encode(
        JSON.stringify({ ...made.envelope, ciphertext: toBase64Url(raw.slice(0, length)) }),
      );
      const opened = await vault.decrypt(
        wire,
        { ...BINDING, objectId: made.ref.objectId },
        'structured',
      );
      expect(opened.ok).toBe(false);
    }
  });

  it('appended bytes inside the ciphertext fail authentication', async () => {
    const vault = await keys();
    const made = await seal(vault, BINDING);
    const raw = fromBase64Url(made.envelope.ciphertext) ?? new Uint8Array();
    const wire = rewrite({
      ...made.envelope,
      ciphertext: toBase64Url(new Uint8Array([...raw, 0])),
    });
    expect(
      await vault.decrypt(wire, { ...BINDING, objectId: made.ref.objectId }, 'structured'),
    ).toEqual({
      ok: false,
      code: 'INTEGRITY',
    });
  });
});

describe('[vault-browser-crypto-tamper] valid objects swapped between owners and vaults', () => {
  const OTHER_OWNER = { ...BINDING, ownerAddress: `0x${'66'.repeat(20)}` };
  const OTHER_VAULT = { ...BINDING, vaultId: 'c0000000-0000-4000-8000-0000000000aa' };

  it.each([
    ['another owner', OTHER_OWNER],
    ['another vault', OTHER_VAULT],
  ])(
    'an envelope valid for %s is refused even when its reference and ID are presented as genuine',
    async (_label, foreign) => {
      const vault = await keys();
      const theirs = await seal(vault, foreign, 'their evidence');
      // Presented under THIS binding, with the reference computed from the foreign bytes (so the digest
      // and length agree) and the foreign object ID: only the envelope's own binding can say no.
      const opened = await vault.decrypt(
        theirs.bytes,
        { ...BINDING, ref: await referenceOf(theirs.ref.objectId, theirs.bytes) },
        'structured',
      );
      expect(opened).toEqual({ ok: false, code: 'INTEGRITY' });
    },
  );

  it('the same key and binding still open its own object, so the refusals above are about the binding', async () => {
    const vault = await keys();
    const mine = await seal(vault, BINDING);
    const opened = await vault.decrypt(mine.bytes, { ...BINDING, ref: mine.ref }, 'structured');
    expect(opened.ok && new TextDecoder().decode(opened.data)).toBe(SECRET);
  });
});

describe('[vault-browser-crypto-tamper] failures never echo secret material', () => {
  it('no failure result contains the plaintext, the key bytes or the ciphertext', async () => {
    const vault = await keys();
    const made = await seal(vault, BINDING);
    const raw = fromBase64Url(made.envelope.ciphertext) ?? new Uint8Array();
    const broken = raw.slice();
    broken[0] = (broken[0] ?? 0) ^ 1;
    const wire = rewrite({ ...made.envelope, ciphertext: toBase64Url(broken) });
    const results = [
      await vault.decrypt(wire, { ...BINDING, objectId: made.ref.objectId }, 'structured'),
      await vault.decrypt(
        made.bytes,
        { ...BINDING, vaultId: 'c0000000-0000-4000-8000-0000000000bb' },
        'structured',
      ),
      await vault.decrypt(new Uint8Array([1, 2, 3]), BINDING, 'structured'),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      const text = JSON.stringify(result);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(toBase64Url(PRF));
      expect(text).not.toContain(made.envelope.ciphertext);
      expect(text.length).toBeLessThan(80); // a code, not a dump
    }
  });
});
