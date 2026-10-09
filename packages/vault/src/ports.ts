import { z } from 'zod';
import {
  opaqueIdSchema,
  unavailable,
  unsignedDecimalSchema,
  type Result,
} from '@lexaegis/protocol';

/** Public metadata only. Legal plaintext, titles and content hashes never appear here. */
export const encryptedObjectMetadataSchema = z.strictObject({
  objectId: opaqueIdSchema,
  byteLength: unsignedDecimalSchema,
});
export type EncryptedObjectMetadata = z.infer<typeof encryptedObjectMetadataSchema>;

/** The backend only ever receives ciphertext plus allowlisted public metadata. */
export interface EncryptedObject {
  readonly metadata: EncryptedObjectMetadata;
  readonly ciphertext: Uint8Array;
}

export const encryptedManifestSchema = z.strictObject({
  revision: unsignedDecimalSchema,
  objects: z.array(encryptedObjectMetadataSchema).max(2048),
});
export type EncryptedManifest = z.infer<typeof encryptedManifestSchema>;

/**
 * Browser-side encrypted evidence storage. Implementations hold keys in memory only and never
 * accept a server credential. Account-signing and encryption key purposes stay separate.
 */
export interface EvidenceVault {
  encrypt(plaintext: Uint8Array, signal?: AbortSignal): Promise<Result<EncryptedObject>>;
  decrypt(object: EncryptedObject, signal?: AbortSignal): Promise<Result<Uint8Array>>;
  readManifest(signal?: AbortSignal): Promise<Result<EncryptedManifest>>;
  exportBundle(objectIds: readonly string[], signal?: AbortSignal): Promise<Result<Uint8Array>>;
  importBundle(bundle: Uint8Array, signal?: AbortSignal): Promise<Result<{ objectIds: string[] }>>;
}

export function createUnavailableEvidenceVault(): EvidenceVault {
  const fail = () =>
    Promise.resolve(unavailable('NOT_IMPLEMENTED', 'The encrypted evidence vault'));
  return {
    encrypt: fail,
    decrypt: fail,
    readManifest: fail,
    exportBundle: fail,
    importBundle: fail,
  };
}
