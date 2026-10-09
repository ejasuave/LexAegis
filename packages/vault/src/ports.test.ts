import { describe, expect, it } from 'vitest';
import {
  createUnavailableEvidenceVault,
  encryptedManifestSchema,
  encryptedObjectMetadataSchema,
} from './ports';

describe('unavailable evidence vault', () => {
  it('fails every operation with NOT_IMPLEMENTED and never returns plaintext or ciphertext', async () => {
    const vault = createUnavailableEvidenceVault();
    const bytes = new Uint8Array([1, 2, 3]);
    const results = await Promise.all([
      vault.encrypt(bytes),
      vault.decrypt({ metadata: { objectId: 'obj_1', byteLength: '3' }, ciphertext: bytes }),
      vault.readManifest(),
      vault.exportBundle(['obj_1']),
      vault.importBundle(bytes),
    ]);
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('NOT_IMPLEMENTED');
    }
  });
});

describe('public vault metadata', () => {
  it('rejects content hashes, titles or filenames smuggled into public metadata', () => {
    const ok = { objectId: 'obj_1', byteLength: '42' };
    expect(encryptedObjectMetadataSchema.safeParse(ok).success).toBe(true);
    expect(
      encryptedObjectMetadataSchema.safeParse({ ...ok, title: 'Settlement.pdf' }).success,
    ).toBe(false);
    expect(
      encryptedObjectMetadataSchema.safeParse({ ...ok, sha256: `0x${'ab'.repeat(32)}` }).success,
    ).toBe(false);
    expect(encryptedManifestSchema.safeParse({ revision: '0', objects: [ok] }).success).toBe(true);
  });
});
