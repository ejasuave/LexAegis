import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from './bytes';
import { computeCommitment, generateBlindingNonce } from './commitment';
import { ProtocolError } from './errors';
import { artifactDigest } from './hashes';
import { prepareReviewPackage } from './prepare';
import { PreparedReviewPackage } from './prepared';
import { artifactMap, at, expectOk, failureCode, getCase, manifestOf } from './test-helpers';

const legal = getCase('legal');
const firstId = at(legal.artifacts, 0).id;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('artifact-set completeness', () => {
  it('rejects missing, extra and duplicate entries', async () => {
    const missing = artifactMap(legal);
    missing.delete(firstId);
    const missingResult = await prepareReviewPackage(legal.opening.manifest, missing);
    expect(!missingResult.ok && missingResult.error).toEqual({
      code: 'ARTIFACT_MISSING',
      artifactId: firstId,
    });

    const extra = artifactMap(legal);
    extra.set('e0000000-0000-4000-8000-000000000099', new Uint8Array([1]));
    const extraResult = await prepareReviewPackage(legal.opening.manifest, extra);
    expect(!extraResult.ok && extraResult.error).toEqual({
      code: 'ARTIFACT_EXTRA',
      artifactId: 'e0000000-0000-4000-8000-000000000099',
    });
    // An arbitrary caller-supplied key is not echoed back.
    const named = artifactMap(legal);
    named.set('../../etc/passwd', new Uint8Array([1]));
    const namedResult = await prepareReviewPackage(legal.opening.manifest, named);
    expect(!namedResult.ok && namedResult.error).toEqual({ code: 'ARTIFACT_EXTRA' });

    const entries = [...artifactMap(legal)];
    const duplicated = [...entries, at(entries, 0)];
    expect(failureCode(await prepareReviewPackage(legal.opening.manifest, duplicated))).toBe(
      'ARTIFACT_DUPLICATE',
    );
  });

  it('rejects malformed artifact input', async () => {
    const manifest = legal.opening.manifest;
    const withFirst = (value: unknown) => {
      const map = new Map<string, unknown>(artifactMap(legal));
      map.set(firstId, value);
      return map as Map<string, Uint8Array>;
    };
    expect(failureCode(await prepareReviewPackage(manifest, withFirst('text')))).toBe(
      'ARTIFACT_INPUT_INVALID',
    );
    expect(failureCode(await prepareReviewPackage(manifest, withFirst(new ArrayBuffer(4))))).toBe(
      'ARTIFACT_INPUT_INVALID',
    );
    expect(failureCode(await prepareReviewPackage(manifest, withFirst([1, 2, 3])))).toBe(
      'ARTIFACT_INPUT_INVALID',
    );
    expect(
      failureCode(await prepareReviewPackage(manifest, null as unknown as Map<string, Uint8Array>)),
    ).toBe('ARTIFACT_INPUT_INVALID');
    expect(
      failureCode(
        await prepareReviewPackage(manifest, [['only-one']] as unknown as Map<string, Uint8Array>),
      ),
    ).toBe('ARTIFACT_INPUT_INVALID');
  });

  it('rejects SharedArrayBuffer-backed and detached input', async () => {
    const manifest = legal.opening.manifest;
    const original = at([...artifactMap(legal).values()], 0);

    if (typeof SharedArrayBuffer !== 'undefined') {
      const shared = new Uint8Array(new SharedArrayBuffer(original.byteLength));
      shared.set(original);
      const map = artifactMap(legal) as Map<string, Uint8Array>;
      map.set(firstId, shared);
      expect(failureCode(await prepareReviewPackage(manifest, map))).toBe('ARTIFACT_INPUT_INVALID');
    }

    const detachedMap = artifactMap(legal);
    const victim = at([...detachedMap.values()], 0);
    structuredClone(victim.buffer, { transfer: [victim.buffer] }); // detaches the buffer
    expect(victim.byteLength).toBe(0);
    expect(failureCode(await prepareReviewPackage(manifest, detachedMap))).toBe(
      'ARTIFACT_INPUT_INVALID',
    );
  });

  it('rejects wrong lengths and digests rather than rewriting the manifest', async () => {
    const shorter = artifactMap(legal);
    shorter.set(firstId, at([...shorter.values()], 0).slice(1));
    const lengthResult = await prepareReviewPackage(legal.opening.manifest, shorter);
    expect(!lengthResult.ok && lengthResult.error).toEqual({
      code: 'ARTIFACT_LENGTH_MISMATCH',
      artifactId: firstId,
    });

    const altered = artifactMap(legal);
    const bytes = at([...altered.values()], 0);
    bytes[10] = (at([...bytes], 10) + 1) % 256; // same length, one byte changed
    const digestResult = await prepareReviewPackage(legal.opening.manifest, altered);
    expect(!digestResult.ok && digestResult.error).toEqual({
      code: 'ARTIFACT_DIGEST_MISMATCH',
      artifactId: firstId,
    });

    // A manifest that declares a wrong digest is rejected too; it is not "corrected".
    const lying = manifestOf(legal);
    at(lying.artifacts, 0).sha256 = `0x${'00'.repeat(32)}`;
    expect(failureCode(await prepareReviewPackage(lying, artifactMap(legal)))).toBe(
      'ARTIFACT_DIGEST_MISMATCH',
    );
    expect(
      failureCode(
        await prepareReviewPackage({ ...manifestOf(legal), extra: 1 }, artifactMap(legal)),
      ),
    ).toBe('UNKNOWN_FIELD');
  });
});

describe('captured snapshot', () => {
  it('is unaffected by mutation of the caller’s manifest and bytes during hashing', async () => {
    const manifest = manifestOf(legal);
    const artifacts = artifactMap(legal);
    const pending = prepareReviewPackage(manifest, artifacts);

    // The call has returned a promise; hashing has not finished. Mutate everything the caller owns.
    for (const bytes of artifacts.values()) bytes.fill(0xff);
    artifacts.clear();
    manifest.packageId = 'f0000000-0000-4000-8000-000000000000';
    at(manifest.artifacts, 0).label = 'changed after the call';
    manifest.artifacts.length = 0;

    const prepared = expectOk(await pending);
    expect(prepared.packageDigest).toBe(legal.expected.packageDigest);
    expect(prepared.opening.manifest).toEqual(legal.opening.manifest);
    for (const item of legal.artifacts) {
      expect(await artifactDigest(prepared.artifactBytes(item.id))).toBe(
        legal.expected.artifactDigests[item.id],
      );
    }
  });

  it('hands out byte copies: mutating them cannot alter the snapshot', async () => {
    const prepared = expectOk(
      await prepareReviewPackage(legal.opening.manifest, artifactMap(legal)),
    );
    prepared.artifactBytes(firstId).fill(0);
    for (const bytes of prepared.artifacts().values()) bytes.fill(0);
    prepared.canonicalManifestBytes().fill(0);

    expect(await artifactDigest(prepared.artifactBytes(firstId))).toBe(
      legal.expected.artifactDigests[firstId],
    );
    expect(bytesToHex(prepared.canonicalManifestBytes())).toBe(
      legal.expected.canonicalManifestUtf8Hex,
    );
    expect(prepared.artifactBytes(firstId)).not.toBe(prepared.artifactBytes(firstId));
  });

  it('deep-freezes its metadata', async () => {
    const prepared = expectOk(
      await prepareReviewPackage(legal.opening.manifest, artifactMap(legal)),
    );
    const { opening, reference } = prepared;
    for (const value of [
      prepared,
      opening,
      opening.manifest,
      opening.manifest.artifacts,
      at(opening.manifest.artifacts, 0),
      opening.manifest.approval.scopeArtifactIds,
      opening.manifest.context,
      reference,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => {
      (reference as { commitment: string }).commitment = `0x${'00'.repeat(32)}`;
    }).toThrow(TypeError);
    expect(() => {
      (opening.manifest.artifacts as unknown[]).push({});
    }).toThrow(TypeError);
    expect(() => prepared.artifactBytes('e0000000-0000-4000-8000-000000000099')).toThrow(
      ProtocolError,
    );
  });

  it('cannot be constructed or imitated', async () => {
    const prepared = expectOk(
      await prepareReviewPackage(legal.opening.manifest, artifactMap(legal)),
    );
    expect(PreparedReviewPackage.isPrepared(prepared)).toBe(true);
    const lookalike = Object.create(PreparedReviewPackage.prototype) as PreparedReviewPackage;
    expect(lookalike instanceof PreparedReviewPackage).toBe(true);
    expect(PreparedReviewPackage.isPrepared(lookalike)).toBe(false);
    expect(
      PreparedReviewPackage.isPrepared({
        opening: prepared.opening,
        reference: prepared.reference,
      }),
    ).toBe(false);
    const Constructor = PreparedReviewPackage as unknown as new (...args: unknown[]) => unknown;
    expect(() => new Constructor(Symbol('forged'), {})).toThrow(TypeError);
  });

  it('is a prepared snapshot only: it carries no approval, signature or status', async () => {
    const prepared = expectOk(
      await prepareReviewPackage(legal.opening.manifest, artifactMap(legal)),
    );
    const surface = [
      ...Object.getOwnPropertyNames(PreparedReviewPackage.prototype),
      ...Object.keys(prepared),
    ];
    for (const forbidden of [
      'approved',
      'signature',
      'status',
      'confirmed',
      'transactionHash',
      'issued',
    ]) {
      expect(surface).not.toContain(forbidden);
    }
  });
});

describe('public projection', () => {
  it('contains only the five reference fields and no private opening material', async () => {
    const prepared = expectOk(
      await prepareReviewPackage(legal.opening.manifest, artifactMap(legal)),
    );
    const { reference, opening } = prepared;
    expect(Object.keys(reference).sort()).toEqual([
      'chainId',
      'commitment',
      'registryAddress',
      'reviewerAddress',
      'schema',
    ]);

    const projection = JSON.stringify(reference);
    const privateValues = [
      opening.blindingNonce,
      prepared.packageDigest,
      opening.manifest.packageId,
      ...opening.manifest.artifacts.flatMap((item) => [item.sha256, item.id, item.label ?? '']),
    ].filter((value) => value !== '');
    expect(privateValues.length).toBeGreaterThan(10);
    for (const value of privateValues) {
      expect(projection).not.toContain(value);
      expect(projection).not.toContain(value.replace(/^0x/, ''));
    }
    expect(projection).not.toContain('manifest');
    expect(projection).not.toContain('SYNTHETIC');

    // Serializing or logging the snapshot itself exposes the reference and nothing else.
    expect(JSON.parse(JSON.stringify(prepared))).toEqual({ reference });
    expect(JSON.stringify({ wrapped: prepared })).not.toContain(opening.blindingNonce);
  });
});

describe('blinding nonce', () => {
  it('is drawn from crypto.getRandomValues, 32 bytes, once per preparation', async () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const mathRandom = vi.spyOn(Math, 'random');
    const first = expectOk(await prepareReviewPackage(legal.opening.manifest, artifactMap(legal)));
    expect(spy).toHaveBeenCalledTimes(1);
    const argument: unknown = spy.mock.calls[0]?.[0];
    expect(argument).toBeInstanceOf(Uint8Array);
    expect((argument as Uint8Array).byteLength).toBe(32);
    expect(mathRandom).not.toHaveBeenCalled();
    expect(first.opening.blindingNonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('uses exactly the bytes the CSPRNG produced', async () => {
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
      if (array instanceof Uint8Array) array.fill(0xa5);
      return array;
    });
    const prepared = expectOk(
      await prepareReviewPackage(legal.opening.manifest, artifactMap(legal)),
    );
    expect(prepared.opening.blindingNonce).toBe(`0x${'a5'.repeat(32)}`);
    expect(prepared.reference.commitment).toBe(
      await computeCommitment(`0x${'a5'.repeat(32)}`, legal.expected.packageDigest),
    );
  });

  it('gives each preparation a different nonce and commitment for the same package', async () => {
    const first = expectOk(await prepareReviewPackage(legal.opening.manifest, artifactMap(legal)));
    const second = expectOk(await prepareReviewPackage(legal.opening.manifest, artifactMap(legal)));
    expect(first.packageDigest).toBe(second.packageDigest);
    expect(first.opening.blindingNonce).not.toBe(second.opening.blindingNonce);
    expect(first.reference.commitment).not.toBe(second.reference.commitment);
    expect(bytesToHex(generateBlindingNonce())).not.toBe(bytesToHex(generateBlindingNonce()));
  });

  it('fails explicitly, with no predictable fallback, when secure randomness is unavailable', async () => {
    const mathRandom = vi.spyOn(Math, 'random');
    const dateNow = vi.spyOn(Date, 'now');
    vi.stubGlobal('crypto', { subtle: globalThis.crypto.subtle });
    expect(() => generateBlindingNonce()).toThrow(ProtocolError);
    expect(
      failureCode(await prepareReviewPackage(legal.opening.manifest, artifactMap(legal))),
    ).toBe('CRYPTO_UNAVAILABLE');
    expect(mathRandom).not.toHaveBeenCalled();
    expect(dateNow).not.toHaveBeenCalled();
  });

  it('fails explicitly when Web Crypto hashing is unavailable', async () => {
    vi.stubGlobal('crypto', {});
    expect(
      failureCode(await prepareReviewPackage(legal.opening.manifest, artifactMap(legal))),
    ).toBe('CRYPTO_UNAVAILABLE');
  });
});

describe('commitment construction', () => {
  it('different nonces give different commitments for an otherwise identical package', async () => {
    const digest = legal.expected.packageDigest;
    const one = await computeCommitment(`0x${'01'.repeat(32)}`, digest);
    const two = await computeCommitment(`0x${'02'.repeat(32)}`, digest);
    expect(one).not.toBe(two);
    expect(await computeCommitment(`0x${'01'.repeat(32)}`, digest)).toBe(one);
  });

  it('rejects wrong byte lengths and malformed hex', async () => {
    const digest = legal.expected.packageDigest;
    const nonce = legal.opening.blindingNonce;
    const code = async (run: Promise<unknown>) => {
      try {
        await run;
        return 'NONE';
      } catch (error) {
        return error instanceof ProtocolError ? error.code : 'OTHER';
      }
    };
    expect(await code(computeCommitment(nonce.slice(0, -2), digest))).toBe('INVALID_BYTE_LENGTH');
    expect(await code(computeCommitment(nonce, digest.slice(0, -2)))).toBe('INVALID_BYTE_LENGTH');
    expect(await code(computeCommitment(nonce.toUpperCase(), digest))).toBe('INVALID_HEX');
    expect(await code(computeCommitment(nonce.slice(2), digest))).toBe('INVALID_HEX');
    expect(await code(computeCommitment(`${nonce}0`, digest))).toBe('INVALID_HEX');
  });
});
