import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  parseCommitmentOpening,
  verifyReviewPackage,
  type CommitmentOpeningV1,
  type PreparedReviewPackage,
  type ReceiptReferenceV1,
} from '@lexaegis/protocol/v1';
import { VaultKeys } from '@lexaegis/vault';
import {
  VAULT_LIMITS,
  matchesReference,
  parseJsonBytes,
  vaultObjectRefSchema,
  type VaultBinding,
  type VaultObjectRefV1,
} from '@lexaegis/vault/v1';

/*
 * Encrypted preservation of the private opening and the exact artifact bytes BEFORE anything is
 * published. It reuses the vault's unchanged envelope and encryption primitives (AES-256-GCM, HKDF
 * under a per-object salt, per-object IDs) with a SEPARATE storage key that this process holds only
 * in memory: it is never derived from the signing key, never written beside the ciphertext, never
 * logged. Directory permissions are not encryption and are not relied on.
 */

export const STORAGE_KEY_BYTES = 32;
export const RECORD_SCHEMA = 'lexaegis.example.signoff-evidence-record.v1';
const RP_ID = 'ai-pr-signoff.example';

const recordSchema = z.strictObject({
  schema: z.literal(RECORD_SCHEMA),
  vaultId: z.uuid(),
  ownerAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
  rpId: z.literal(RP_ID),
  opening: vaultObjectRefSchema,
  artifacts: z.array(z.strictObject({ artifactId: z.uuid(), ref: vaultObjectRefSchema })).max(128),
});
type RecordV1 = z.infer<typeof recordSchema>;

export interface SavedEvidence {
  readonly opening: CommitmentOpeningV1;
  readonly artifacts: ReadonlyMap<string, Uint8Array>;
}

export type StorageFailure =
  | 'STORAGE_KEY_INVALID'
  | 'ALREADY_EXISTS'
  | 'WRITE_FAILED'
  | 'READ_BACK_FAILED'
  | 'RECORD_MISSING'
  | 'RECORD_INVALID'
  | 'DECRYPTION_FAILED'
  | 'REFERENCE_MISMATCH';

export type StorageResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly code: StorageFailure };

export interface EvidenceStore {
  /** Encrypts, writes, reads back, decrypts and checks the ORIGINAL reference before returning. */
  save(prepared: PreparedReviewPackage): Promise<StorageResult<SavedEvidence>>;
  load(reference: ReceiptReferenceV1): Promise<StorageResult<SavedEvidence>>;
}

const fail = (code: StorageFailure): { readonly ok: false; readonly code: StorageFailure } => ({
  ok: false,
  code,
});

/** Parses the operator's base64url storage key (32 random bytes). Returns null when malformed. */
export function parseStorageKey(text: string): Uint8Array | null {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(trimmed)) return null;
  const bytes = Uint8Array.from(Buffer.from(trimmed, 'base64url'));
  return bytes.byteLength === STORAGE_KEY_BYTES ? bytes : null;
}

export const generateStorageKey = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(STORAGE_KEY_BYTES))).toString('base64url');

export async function createDirectoryStore(
  directory: string,
  storageKey: Uint8Array,
  ownerAddress: string,
): Promise<StorageResult<EvidenceStore>> {
  if (storageKey.byteLength !== STORAGE_KEY_BYTES) return fail('STORAGE_KEY_INVALID');
  const keys = await VaultKeys.fromPrf(storageKey);
  if (!keys.ok) return fail('STORAGE_KEY_INVALID');
  const folder = (reference: ReceiptReferenceV1): string =>
    join(directory, reference.commitment.slice(2));

  const open = async (
    reference: ReceiptReferenceV1,
    record: RecordV1,
  ): Promise<StorageResult<SavedEvidence>> => {
    const binding: VaultBinding = {
      vaultId: record.vaultId,
      ownerAddress: record.ownerAddress,
      rpId: record.rpId,
    };
    const fetchObject = async (
      ref: VaultObjectRefV1,
      kind: 'artifact' | 'structured',
    ): Promise<Uint8Array | null> => {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(join(folder(reference), `${ref.objectId}.sealed`)));
      } catch {
        return null;
      }
      if (!(await matchesReference(ref, bytes))) return null;
      const plaintext = await keys.data.decrypt(bytes, { ...binding, ref }, kind);
      return plaintext.ok ? plaintext.data : null;
    };
    const openingBytes = await fetchObject(record.opening, 'structured');
    if (openingBytes === null) return fail('DECRYPTION_FAILED');
    const json = parseJsonBytes(openingBytes, VAULT_LIMITS.maxStructuredBytes);
    const opening = json.ok ? parseCommitmentOpening(json.data) : null;
    if (opening === null || !opening.ok) return fail('DECRYPTION_FAILED');
    const artifacts = new Map<string, Uint8Array>();
    for (const item of record.artifacts) {
      const bytes = await fetchObject(item.ref, 'artifact');
      if (bytes === null) return fail('DECRYPTION_FAILED');
      artifacts.set(item.artifactId, bytes);
    }
    const verified = await verifyReviewPackage(opening.data, artifacts, reference);
    if (
      !verified.ok ||
      verified.data.manifestIntegrity !== 'match' ||
      verified.data.artifactIntegrity !== 'match'
    )
      return fail('REFERENCE_MISMATCH');
    return { ok: true, data: { opening: opening.data, artifacts } };
  };

  const load = async (reference: ReceiptReferenceV1): Promise<StorageResult<SavedEvidence>> => {
    let text: string;
    try {
      text = readFileSync(join(folder(reference), 'record.json'), 'utf8');
    } catch {
      return fail('RECORD_MISSING');
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return fail('RECORD_INVALID');
    }
    const record = recordSchema.safeParse(json);
    if (!record.success) return fail('RECORD_INVALID');
    if (record.data.ownerAddress !== ownerAddress) return fail('RECORD_INVALID');
    return open(reference, record.data);
  };

  const store: EvidenceStore = {
    load,
    async save(prepared) {
      const { reference } = prepared;
      const target = folder(reference);
      // Preservation is write-once: an existing record is read back and checked, never replaced.
      if (existsSync(join(target, 'record.json'))) return load(reference);
      const binding: VaultBinding = {
        vaultId: crypto.randomUUID(),
        ownerAddress,
        rpId: RP_ID,
      };
      try {
        mkdirSync(target, { recursive: true, mode: 0o700 });
      } catch {
        return fail('WRITE_FAILED');
      }
      const seal = async (
        plaintext: Uint8Array,
        kind: 'artifact' | 'structured',
      ): Promise<VaultObjectRefV1 | null> => {
        const sealed = await keys.data.encrypt(binding, plaintext, kind);
        if (!sealed.ok) return null;
        try {
          writeFileSync(join(target, `${sealed.data.ref.objectId}.sealed`), sealed.data.bytes, {
            flag: 'wx',
            mode: 0o600,
          });
        } catch {
          return null;
        }
        return sealed.data.ref;
      };
      const openingRef = await seal(
        new TextEncoder().encode(JSON.stringify(prepared.opening)),
        'structured',
      );
      if (openingRef === null) return fail('WRITE_FAILED');
      const artifactRefs: RecordV1['artifacts'] = [];
      for (const artifactId of prepared.artifactIds) {
        const ref = await seal(prepared.artifactBytes(artifactId), 'artifact');
        if (ref === null) return fail('WRITE_FAILED');
        artifactRefs.push({ artifactId, ref });
      }
      const record: RecordV1 = {
        schema: RECORD_SCHEMA,
        vaultId: binding.vaultId,
        ownerAddress,
        rpId: RP_ID,
        opening: openingRef,
        artifacts: artifactRefs,
      };
      // The record is written last and atomically: its presence means every object is complete.
      const temporary = join(target, `record.${String(process.pid)}.tmp`);
      try {
        writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
        renameSync(temporary, join(target, 'record.json'));
      } catch {
        return fail('WRITE_FAILED');
      }
      const readBack = await load(reference);
      return readBack.ok ? readBack : fail('READ_BACK_FAILED');
    },
  };
  return { ok: true, data: store };
}
