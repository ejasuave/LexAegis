import { describe, expect, it } from 'vitest';
import { VaultKeys } from './crypto/browser-crypto';
import { emptyCatalog, isRegression, nextCatalog, openCatalog, sealCatalog } from './catalog';
import {
  buildContextExport,
  buildEncryptedReviewExport,
  buildReadableReviewExport,
  exportFileName,
} from './export';
import {
  RecoverableCapture,
  VerifiedReview,
  sealFrozenReview,
  verifyFrozenReview,
  type SealedFrozenReview,
} from './frozen-review';
import {
  importContextEntries,
  parseContextExport,
  parseEncryptedReviewExport,
  parseReadableReviewExport,
} from './import';
import {
  addEntry,
  addFrozenReview,
  addSource,
  confirmEntry,
  correctEntry,
  newMatter,
  removeEntry,
  selectContext,
  unresolvedReferences,
  type MatterRecordV1,
} from './matter';
import { toBase64Url, fromBase64Url } from './v1/base64url';
import { VAULT_LIMITS } from './v1/constants';
import { decodeEnvelope, parseJsonBytes } from './v1/encoding';
import type { VaultDescriptorV1 } from './v1/schemas';
import {
  BINDING,
  MemoryStore,
  OWNER,
  RP_ID,
  VAULT_ID,
  fromHex,
  prepareSynthetic,
  vaultVectors,
} from './test-vectors';

const NOW = '2026-10-09T10:00:00.000Z';
const uuid = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DESCRIPTOR: VaultDescriptorV1 = {
  schema: 'lexaegis.vault-descriptor.v1',
  vaultId: VAULT_ID,
  ownerAddress: OWNER,
  rpId: RP_ID,
  accountProfileId: 'lexaegis.evm.bip32-prf.v1',
  cryptoProfileId: 'lexaegis.vault.hkdf-sha256.aes-256-gcm.v1',
};

async function keys(index = 0): Promise<VaultKeys> {
  const made = await VaultKeys.fromPrf(fromHex(vaultVectors[index]?.prfOutput ?? '0x'));
  if (!made.ok) throw new Error(made.code);
  return made.data;
}
const must = <T>(result: { ok: true; data: T } | { ok: false; code: string }): T => {
  if (!result.ok) throw new Error(result.code);
  return result.data;
};

async function saved(owner = OWNER) {
  const k = await keys();
  const store = new MemoryStore();
  const binding = { ...BINDING, ownerAddress: owner };
  const prepared = await prepareSynthetic('legal');
  const sealed = must(await sealFrozenReview(k, binding, prepared));
  for (const object of sealed.objects) store.put(object.ref.objectId, object.bytes);
  return { k, store, binding, prepared, sealed };
}

describe('catalog', () => {
  it('starts at revision 0 and chains each revision to the digest before it', async () => {
    const k = await keys();
    const first = must(await sealCatalog(k, BINDING, emptyCatalog(VAULT_ID)));
    const opened = must(
      await openCatalog(k, BINDING, first.bytes, { ref: first.ref, revision: '0' }),
    );
    expect(opened).toMatchObject({ revision: '0', previousCatalogDigest: null, matters: [] });

    const second = must(
      nextCatalog({ catalog: opened, ref: first.ref }, [{ matterId: uuid(1), matter: first.ref }]),
    );
    expect(second).toMatchObject({
      revision: '1',
      previousCatalogDigest: first.ref.envelopeSha256,
    });
  });

  it('rejects a catalog whose revision or vault disagrees with the head the server claimed', async () => {
    const k = await keys();
    const first = must(await sealCatalog(k, BINDING, emptyCatalog(VAULT_ID)));
    expect(await openCatalog(k, BINDING, first.bytes, { ref: first.ref, revision: '5' })).toEqual({
      ok: false,
      code: 'INTEGRITY',
    });
    const other = must(
      await sealCatalog(k, BINDING, emptyCatalog('c0000000-0000-4000-8000-0000000000ff')),
    );
    expect(await openCatalog(k, BINDING, other.bytes, { ref: other.ref, revision: '0' })).toEqual({
      ok: false,
      code: 'INTEGRITY',
    });
  });

  it('enforces unique matters, the 16-matter quota and revision/digest consistency', async () => {
    const k = await keys();
    const first = must(await sealCatalog(k, BINDING, emptyCatalog(VAULT_ID)));
    const base = must(
      await openCatalog(k, BINDING, first.bytes, { ref: first.ref, revision: '0' }),
    );
    const entry = (n: number) => ({
      matterId: uuid(n),
      matter: { ...first.ref, objectId: uuid(100 + n) },
    });
    expect(nextCatalog({ catalog: base, ref: first.ref }, [entry(1), entry(1)]).ok).toBe(false);
    expect(
      nextCatalog(
        { catalog: base, ref: first.ref },
        Array.from({ length: 16 }, (_, i) => entry(i + 1)),
      ).ok,
    ).toBe(true);
    expect(
      nextCatalog(
        { catalog: base, ref: first.ref },
        Array.from({ length: 17 }, (_, i) => entry(i + 1)),
      ),
    ).toEqual({ ok: false, code: 'QUOTA' });
  });

  it('detects regression against a head already observed', () => {
    expect(isRegression('7', '6')).toBe(true);
    expect(isRegression('7', '7')).toBe(false);
    expect(isRegression('7', '8')).toBe(false);
    expect(isRegression(null, '0')).toBe(false);
  });
});

describe('matter context', () => {
  const fresh = (): MatterRecordV1 => must(newMatter(uuid(1), 'Synthetic matter', NOW));

  it('keeps model proposals and imports unconfirmed until the user accepts them', () => {
    let record = fresh();
    record = must(
      addEntry(
        record,
        { entryId: uuid(10), kind: 'fact', text: 'Notice period is 4 weeks', confirmed: true },
        NOW,
      ),
    );
    record = must(
      addEntry(
        record,
        {
          entryId: uuid(11),
          kind: 'fact',
          text: 'Proposed by model',
          origin: 'model_proposed',
          confirmed: true,
        },
        NOW,
      ),
    );
    const [mine, proposed] = record.context.entries;
    expect(mine).toMatchObject({ status: 'confirmed', origin: 'user' });
    // Asking for confirmation on a proposal is ignored: only the user's own entries start confirmed.
    expect(proposed).toMatchObject({
      status: 'unconfirmed',
      origin: 'model_proposed',
      confirmedAt: null,
    });
    expect(selectContext(record, [uuid(11)])).toEqual({ ok: false, code: 'INVALID_INPUT' });
    record = must(confirmEntry(record, uuid(11), NOW));
    expect(must(selectContext(record, [uuid(11)])).entries).toHaveLength(1);
  });

  it('a correction is a new unconfirmed revision, and removal touches only working context', () => {
    let record = fresh();
    record = must(
      addEntry(record, { entryId: uuid(10), kind: 'fact', text: 'A', confirmed: true }, NOW),
    );
    record = must(correctEntry(record, uuid(10), 'B', '2026-10-09T11:00:00.000Z'));
    expect(record.context.entries[0]).toMatchObject({
      text: 'B',
      status: 'unconfirmed',
      confirmedAt: null,
      revision: '1',
    });
    record = must(removeEntry(record, uuid(10), NOW));
    expect(record.context.entries).toEqual([]);
    expect(removeEntry(record, uuid(10), NOW)).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('bounds entries at 4 KiB, requires a version for an outcome, and rejects duplicate IDs', () => {
    const record = fresh();
    expect(
      addEntry(record, { entryId: uuid(10), kind: 'note', text: 'x'.repeat(4096) }, NOW).ok,
    ).toBe(true);
    expect(
      addEntry(record, { entryId: uuid(10), kind: 'note', text: 'x'.repeat(4097) }, NOW).ok,
    ).toBe(false);
    expect(addEntry(record, { entryId: uuid(10), kind: 'outcome', text: 'Settled' }, NOW).ok).toBe(
      false,
    );
    const once = must(addEntry(record, { entryId: uuid(10), kind: 'note', text: 'a' }, NOW));
    expect(addEntry(once, { entryId: uuid(10), kind: 'note', text: 'b' }, NOW)).toEqual({
      ok: false,
      code: 'CONFLICT',
    });
  });

  it('shows unresolved source references and never truncates a selection over 32 KiB', () => {
    let record = fresh();
    const ref = { documentVersionId: uuid(500), anchor: 'clause 3' };
    record = must(
      addEntry(
        record,
        { entryId: uuid(10), kind: 'fact', text: 'F', sourceRefs: [ref], confirmed: true },
        NOW,
      ),
    );
    expect(unresolvedReferences(record)).toEqual([
      { entryId: uuid(10), documentVersionId: uuid(500) },
    ]);
    expect(must(selectContext(record, [uuid(10)])).versions).toEqual([
      { documentVersionId: uuid(500), resolved: false },
    ]);
    for (let i = 0; i < 9; i += 1) {
      record = must(
        addEntry(
          record,
          { entryId: uuid(20 + i), kind: 'fact', text: 'y'.repeat(4000), confirmed: true },
          NOW,
        ),
      );
    }
    expect(
      selectContext(
        record,
        record.context.entries.map((e) => e.entryId),
      ),
    ).toEqual({ ok: false, code: 'TOO_LARGE' });
    expect(selectContext(record, [uuid(999)])).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('never replaces a source version and keeps the frozen reference immutable', async () => {
    const { sealed, prepared } = await saved();
    let record = fresh();
    const source = {
      documentId: uuid(300),
      documentVersionId: uuid(301),
      artifactId: uuid(302),
      byteLength: '10',
      sha256: `0x${'ab'.repeat(32)}`,
      mediaType: 'application/pdf',
      label: 'Agreement',
      object: sealed.frozen.ref,
      addedAt: NOW,
    };
    record = must(addSource(record, source, NOW));
    expect(addSource(record, { ...source, byteLength: '11' }, NOW)).toEqual({
      ok: false,
      code: 'CONFLICT',
    });
    const frozen = {
      frozenReview: sealed.frozen.ref,
      packageId: prepared.opening.manifest.packageId,
      commitment: prepared.reference.commitment,
      savedAt: NOW,
    };
    const withFrozen = must(addFrozenReview(record, frozen, NOW));
    const edited = must(
      addEntry(withFrozen, { entryId: uuid(10), kind: 'note', text: 'later note' }, NOW),
    );
    // Working-context edits cannot change the frozen snapshot it points at.
    expect(edited.frozenReviews).toEqual(withFrozen.frozenReviews);
    expect(addFrozenReview(withFrozen, frozen, NOW)).toEqual({ ok: false, code: 'CONFLICT' });
  });
});

describe('frozen review', () => {
  it('round-trips a real Chapter 2 package and reproduces its commitment', async () => {
    const { k, store, binding, prepared, sealed } = await saved();
    const verified = must(await verifyFrozenReview(k, binding, sealed.frozen.ref, store.fetch, 3));
    expect(verified.review.reference).toEqual(prepared.reference);
    expect(verified.review.opening).toEqual(prepared.opening);
    for (const id of prepared.artifactIds) {
      expect(Array.from(verified.review.artifactBytes(id) ?? [])).toEqual(
        Array.from(prepared.artifactBytes(id)),
      );
    }
    expect(verified.capture).toMatchObject({
      commitment: prepared.reference.commitment,
      packageDigest: prepared.packageDigest,
      generation: 3,
      ownerAddress: OWNER,
      vaultId: VAULT_ID,
    });
    expect(verified.capture.captureDigest).toBe(sealed.frozen.ref.envelopeSha256);
    // Stored objects: every artifact, the opening and the record. One object per item, no plaintext.
    expect(sealed.objects).toHaveLength(prepared.artifactIds.length + 2);
    const stored = sealed.objects.map((o) => new TextDecoder().decode(o.bytes)).join('');
    expect(stored).not.toContain(prepared.opening.blindingNonce.slice(2));
    expect(stored).not.toContain(prepared.packageDigest.slice(2));
  });

  it('seals only a validated capture, never a look-alike', async () => {
    const k = await keys();
    const prepared = await prepareSynthetic('legal');
    for (const fake of [
      { opening: prepared.opening, reference: prepared.reference },
      structuredClone(prepared.opening),
      null,
      'x',
    ]) {
      expect(await sealFrozenReview(k, BINDING, fake as never)).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
      });
    }
  });

  it('reuses the existing nonce and does not refreeze: two seals describe the same commitment', async () => {
    const k = await keys();
    const prepared = await prepareSynthetic('legal');
    const a = must(await sealFrozenReview(k, BINDING, prepared));
    const b = must(await sealFrozenReview(k, BINDING, prepared));
    expect(a.record.receiptReference).toEqual(b.record.receiptReference);
    expect(a.frozen.ref.objectId).not.toBe(b.frozen.ref.objectId);
  });

  it('reuses an existing encrypted artifact only when the caller verified its exact bytes', async () => {
    const { k, binding, prepared, sealed } = await saved();
    const target = sealed.record.artifacts[0];
    if (target === undefined) throw new Error('no artifact');
    const again = must(
      await sealFrozenReview(k, binding, prepared, {
        reuse: (artifactId) =>
          Promise.resolve(artifactId === target.artifactId ? target.object : null),
      }),
    );
    expect(again.reused).toEqual([target.artifactId]);
    expect(again.record.artifacts.find((a) => a.artifactId === target.artifactId)?.object).toEqual(
      target.object,
    );
    expect(again.objects).toHaveLength(sealed.objects.length - 1);
  });

  it.each(['frozen record', 'opening', 'first artifact'] as const)(
    'a missing %s blocks readiness',
    async (which) => {
      const { k, store, binding, sealed } = await saved();
      const id =
        which === 'frozen record'
          ? sealed.frozen.ref.objectId
          : which === 'opening'
            ? sealed.record.opening.objectId
            : (sealed.record.artifacts[0]?.object.objectId ?? '');
      store.objects.delete(id);
      expect(await verifyFrozenReview(k, binding, sealed.frozen.ref, store.fetch, 1)).toEqual({
        ok: false,
        code: 'MISSING_OBJECT',
      });
    },
  );

  it('a modified or swapped object blocks readiness', async () => {
    const { k, store, binding, sealed } = await saved();
    const artifact = sealed.record.artifacts[0]?.object.objectId ?? '';
    const original = store.objects.get(artifact) ?? new Uint8Array();
    const tampered = original.slice();
    tampered[tampered.length - 20] = (tampered[tampered.length - 20] ?? 0) ^ 1;
    store.put(artifact, tampered);
    expect((await verifyFrozenReview(k, binding, sealed.frozen.ref, store.fetch, 1)).ok).toBe(
      false,
    );

    // A well-formed object from elsewhere in the same vault under the wrong reference.
    store.put(artifact, store.objects.get(sealed.record.opening.objectId) ?? original);
    expect(await verifyFrozenReview(k, binding, sealed.frozen.ref, store.fetch, 1)).toEqual({
      ok: false,
      code: 'REFERENCE_MISMATCH',
    });
    store.put(artifact, original);
    expect((await verifyFrozenReview(k, binding, sealed.frozen.ref, store.fetch, 1)).ok).toBe(true);
  });

  it('a different vault key cannot read it', async () => {
    const { store, binding, sealed } = await saved();
    const other = await keys(2);
    expect(await verifyFrozenReview(other, binding, sealed.frozen.ref, store.fetch, 1)).toEqual({
      ok: false,
      code: 'INTEGRITY',
    });
  });

  it('the recoverable-capture gate cannot be forged, replayed under another account, or serialized', async () => {
    const { k, store, binding, sealed } = await saved();
    const { capture } = must(
      await verifyFrozenReview(k, binding, sealed.frozen.ref, store.fetch, 4),
    );
    expect(RecoverableCapture.isRecoverable(capture)).toBe(true);
    expect(RecoverableCapture.isRecoverable(Object.assign({}, capture))).toBe(false);
    expect(RecoverableCapture.isRecoverable({ persisted: true, verified: true })).toBe(false);
    expect(capture.matches(OWNER, VAULT_ID, 4)).toBe(true);
    expect(capture.matches(OWNER, VAULT_ID, 5)).toBe(false);
    expect(capture.matches(`0x${'44'.repeat(20)}`, VAULT_ID, 4)).toBe(false);
    expect(() => JSON.stringify(capture)).toThrow();
    expect(
      () => new RecoverableCapture(Symbol('x'), Object.assign({}, capture) as never),
    ).toThrow();
    expect(VerifiedReview.isVerified({ opening: {}, reference: {} })).toBe(false);
  });
});

describe('exports and imports', () => {
  async function exports() {
    const base = await saved();
    const verified = must(
      await verifyFrozenReview(base.k, base.binding, base.sealed.frozen.ref, base.store.fetch, 1),
    );
    return { ...base, verified };
  }

  it('readable export preserves exact bytes and re-verifies', async () => {
    const { prepared, verified, k } = await exports();
    const bytes = must(buildReadableReviewExport(verified.review));
    expect(exportFileName('review', prepared.opening.manifest.packageId)).toMatch(
      /^lexaegis-review-[0-9a-f-]{36}\.json$/,
    );
    // The manifest names reviewer 0x22..; another destination account makes it a foreign review.
    expect(
      must(await parseReadableReviewExport(bytes, { ownerAddress: OWNER, rpId: RP_ID })).preview
        .foreignReviewer,
    ).toBe(false);
    const imported = must(
      await parseReadableReviewExport(bytes, {
        ownerAddress: `0x${'44'.repeat(20)}`,
        rpId: RP_ID,
        expectedReference: prepared.reference,
      }),
    );
    expect(imported.preview).toMatchObject({
      kind: 'readable',
      consistentWithClaimedReference: true,
      matchesExpectedReference: true,
      chainStatus: 'unknown',
      foreignReviewer: true,
      artifactCount: prepared.artifactIds.length,
    });
    for (const id of prepared.artifactIds) {
      expect(Array.from(imported.review?.artifactBytes(id) ?? [])).toEqual(
        Array.from(prepared.artifactBytes(id)),
      );
    }
    // No key material is in a readable export.
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toMatch(/prfOutput|hkdfSalt|privateKey|vaultKey/i);
    expect(k.unlocked).toBe(true);
  });

  it('distinguishes consistency with the claimed reference from agreement with an expected one', async () => {
    const { prepared, verified } = await exports();
    const bytes = must(buildReadableReviewExport(verified.review));
    const other = { ...prepared.reference, commitment: `0x${'cd'.repeat(32)}` };
    const imported = must(
      await parseReadableReviewExport(bytes, {
        ownerAddress: OWNER,
        rpId: RP_ID,
        expectedReference: other,
      }),
    );
    expect(imported.preview.consistentWithClaimedReference).toBe(true);
    expect(imported.preview.matchesExpectedReference).toBe(false);
    expect(
      must(await parseReadableReviewExport(bytes, { ownerAddress: OWNER, rpId: RP_ID })).preview
        .matchesExpectedReference,
    ).toBeNull();
  });

  it('rejects missing, extra, reordered, tampered and malformed readable bundles', async () => {
    const { prepared, verified } = await exports();
    const text = new TextDecoder().decode(must(buildReadableReviewExport(verified.review)));
    const bundle = JSON.parse(text) as { artifacts: { artifactId: string; bytes: string }[] };
    const ctx = { ownerAddress: OWNER, rpId: RP_ID };
    const parse = (value: unknown) =>
      parseReadableReviewExport(new TextEncoder().encode(JSON.stringify(value)), ctx);
    const [first, ...rest] = bundle.artifacts;
    if (first === undefined) throw new Error('no artifacts');

    expect(await parse({ ...bundle, artifacts: rest })).toEqual({
      ok: false,
      code: 'BUNDLE_INVALID',
    });
    expect(await parse({ ...bundle, artifacts: [...bundle.artifacts, first] })).toEqual({
      ok: false,
      code: 'BUNDLE_INVALID',
    });
    expect(await parse({ ...bundle, artifacts: [...rest, first] })).toEqual({
      ok: false,
      code: 'BUNDLE_INVALID',
    });
    expect(await parse({ ...bundle, extra: 1 })).toEqual({ ok: false, code: 'BUNDLE_INVALID' });
    expect(await parse({ ...bundle, schema: 'lexaegis.review-export.v2' })).toEqual({
      ok: false,
      code: 'BUNDLE_INVALID',
    });
    expect(
      await parse({ ...bundle, artifacts: [{ ...first, bytes: `${first.bytes}=` }, ...rest] }),
    ).toEqual({ ok: false, code: 'BUNDLE_INVALID' });
    expect(await parseReadableReviewExport(new TextEncoder().encode('{"a":1,"a":2}'), ctx)).toEqual(
      { ok: false, code: 'BUNDLE_INVALID' },
    );

    // One changed byte in a well-formed container: integrity fails, and no review is released.
    const flipped = fromBase64Url(first.bytes) ?? new Uint8Array();
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    const tampered = must(
      await parse({ ...bundle, artifacts: [{ ...first, bytes: toBase64Url(flipped) }, ...rest] }),
    );
    expect(tampered.preview.consistentWithClaimedReference).toBe(false);
    expect(tampered.review).toBeNull();
    expect(prepared.artifactIds.length).toBeGreaterThan(1);
  });

  it('encrypted export contains exactly the reachable objects, sorted, and imports only with the same owner', async () => {
    const { k, binding, sealed, verified, prepared } = await exports();
    const bytes = must(buildEncryptedReviewExport(DESCRIPTOR, sealed.frozen.ref, verified));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      objects: { header: { objectId: string } }[];
    };
    const ids = parsed.objects.map((o) => o.header.objectId);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toHaveLength(prepared.artifactIds.length + 2);
    expect(new TextDecoder().decode(bytes)).not.toContain(prepared.opening.blindingNonce.slice(2));

    const ctx = { ownerAddress: binding.ownerAddress, rpId: RP_ID };
    const imported = must(await parseEncryptedReviewExport(bytes, k, ctx, 7));
    expect(imported.preview).toMatchObject({
      kind: 'encrypted',
      consistentWithClaimedReference: true,
      chainStatus: 'unknown',
    });
    expect(imported.capture?.generation).toBe(7);
    expect(imported.review?.reference).toEqual(prepared.reference);

    expect(
      await parseEncryptedReviewExport(
        bytes,
        k,
        { ...ctx, ownerAddress: `0x${'44'.repeat(20)}` },
        1,
      ),
    ).toEqual({ ok: false, code: 'INTEGRITY' });
    expect(await parseEncryptedReviewExport(bytes, k, { ...ctx, rpId: 'other.test' }, 1)).toEqual({
      ok: false,
      code: 'INTEGRITY',
    });
    expect(await parseEncryptedReviewExport(bytes, await keys(2), ctx, 1)).toEqual({
      ok: false,
      code: 'INTEGRITY',
    });
  });

  it('rejects incomplete, extra, duplicated and tampered encrypted bundles', async () => {
    const { k, binding, sealed, verified } = await exports();
    const text = new TextDecoder().decode(
      must(buildEncryptedReviewExport(DESCRIPTOR, sealed.frozen.ref, verified)),
    );
    const bundle = JSON.parse(text) as {
      objects: { header: { objectId: string }; ciphertext: string }[];
    };
    const ctx = { ownerAddress: binding.ownerAddress, rpId: RP_ID };
    const parse = async (value: unknown) => {
      const bytes = parseJsonBytes(new TextEncoder().encode(JSON.stringify(value)), 1 << 26);
      return parseEncryptedReviewExport(
        new TextEncoder().encode(JSON.stringify(bytes.ok ? value : {})),
        k,
        ctx,
        1,
      );
    };
    const [first, second, ...rest] = bundle.objects;
    if (first === undefined || second === undefined) throw new Error('small bundle');

    expect((await parse({ ...bundle, objects: [first, ...rest] })).ok).toBe(false);
    expect(await parse({ ...bundle, objects: [...bundle.objects, first] })).toEqual({
      ok: false,
      code: 'BUNDLE_INVALID',
    });
    const flipped = fromBase64Url(second.ciphertext) ?? new Uint8Array();
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(
      (
        await parse({
          ...bundle,
          objects: [first, { ...second, ciphertext: toBase64Url(flipped) }, ...rest],
        })
      ).ok,
    ).toBe(false);

    // An extra, valid-looking object that nothing references.
    const extra = must(await k.encrypt(binding, new TextEncoder().encode('{}'), 'structured'));
    const decoded = decodeEnvelope(extra.bytes);
    expect(
      await parse({ ...bundle, objects: [...bundle.objects, decoded.ok ? decoded.data : null] }),
    ).toEqual({ ok: false, code: 'BUNDLE_INVALID' });
  });

  it('re-encrypts an import under fresh object IDs, salts and IVs for the destination vault', async () => {
    const { k, sealed, verified } = await exports();
    const destination = {
      vaultId: 'd0000000-0000-4000-8000-000000000009',
      ownerAddress: `0x${'55'.repeat(20)}`,
      rpId: 'dest.test',
    };
    const again = must(await sealFrozenReview(k, destination, verified.review));
    const before = new Set(sealed.objects.map((o) => o.ref.objectId));
    expect(again.objects.every((o) => !before.has(o.ref.objectId))).toBe(true);
    const headers = again.objects
      .map((o) => decodeEnvelope(o.bytes))
      .map((e) => (e.ok ? e.data.header : null));
    expect(new Set(headers.map((h) => h?.hkdfSalt)).size).toBe(headers.length);
    expect(headers.every((h) => h?.vaultId === destination.vaultId && h.rpId === 'dest.test')).toBe(
      true,
    );
    // The original reviewer identity and commitment are preserved, whatever vault holds them.
    expect(again.record.receiptReference).toEqual(verified.review.reference);
    const store = new MemoryStore();
    for (const o of again.objects) store.put(o.ref.objectId, o.bytes);
    expect((await verifyFrozenReview(k, destination, again.frozen.ref, store.fetch, 1)).ok).toBe(
      true,
    );
  });

  it('context export is limited to saved context, and imports arrive unconfirmed with provenance', () => {
    let record = must(newMatter(uuid(1), 'Source matter', NOW));
    record = must(
      addEntry(
        record,
        {
          entryId: uuid(10),
          kind: 'fact',
          text: 'Confirmed fact',
          confirmed: true,
          sourceRefs: [{ documentVersionId: uuid(77), anchor: null }],
        },
        NOW,
      ),
    );
    const bytes = must(buildContextExport(record));
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain('Source matter');
    expect(text).not.toContain('sources');
    const exported = must(parseContextExport(bytes));

    const destination = must(newMatter(uuid(2), 'Destination', NOW));
    const imported = must(
      importContextEntries(destination, exported, [uuid(10)], NOW, () => uuid(900)),
    );
    expect(imported.context.entries).toEqual([
      expect.objectContaining({
        entryId: uuid(900),
        status: 'unconfirmed',
        origin: 'imported',
        importedFrom: uuid(1),
        confirmedAt: null,
      }),
    ]);
    expect(unresolvedReferences(imported)).toHaveLength(1);
    expect(importContextEntries(destination, exported, [uuid(404)], NOW)).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(
      parseContextExport(
        new TextEncoder().encode('{"schema":"lexaegis.matter-context-export.v1"}'),
      ),
    ).toEqual({ ok: false, code: 'BUNDLE_INVALID' });
    expect(parseContextExport(new Uint8Array(VAULT_LIMITS.maxContextExportBytes + 1))).toEqual({
      ok: false,
      code: 'TOO_LARGE',
    });
  });

  it('safe file names never come from titles or paths', () => {
    expect(exportFileName('context', '../../etc/passwd')).toBe('lexaegis-context-export.json');
    expect(exportFileName('review', 'Settlement £24,000.pdf')).toBe('lexaegis-review-export.json');
  });
});

describe('typing check', () => {
  it('SealedFrozenReview exposes only envelope bytes and references', async () => {
    const { sealed } = await saved();
    const view: SealedFrozenReview = sealed;
    expect(Object.keys(view).sort()).toEqual(['frozen', 'objects', 'record', 'reused']);
  });
});
