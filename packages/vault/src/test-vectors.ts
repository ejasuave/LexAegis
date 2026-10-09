/** Test-only. Not exported from the package. Literal values from fixtures/vault-v1/vectors.json. */
import vectorsFile from '../../../fixtures/vault-v1/vectors.json';

export interface VaultVector {
  readonly id: string;
  readonly prfOutput: string;
  readonly hkdfSalt: string;
  readonly iv: string;
  readonly plaintextHex: string;
  readonly expected: {
    readonly binding: Record<string, string>;
    readonly infoHex: string;
    readonly aadHex: string;
    readonly ciphertextHex: string;
    readonly envelope: { header: Record<string, string>; ciphertext: string };
    readonly envelopeWireHex: string;
    readonly envelopeSha256: string;
    readonly envelopeByteLength: string;
  };
}

export const vaultVectors = (vectorsFile as unknown as { cases: readonly VaultVector[] }).cases;

export const fromHex = (hex: string): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i += 1)
    out[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
};
export const toHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;

export const OWNER = `0x${'22'.repeat(20)}`;
export const VAULT_ID = 'b0000000-0000-4000-8000-000000000001';
export const RP_ID = 'app.lexaegis.test';
export const BINDING = { vaultId: VAULT_ID, ownerAddress: OWNER, rpId: RP_ID } as const;

import protocolVectors from '../../../fixtures/protocol-v1/vectors.json';
import { prepareReviewPackage, type PreparedReviewPackage } from '@lexaegis/protocol/v1';

interface ProtocolCase {
  readonly id: string;
  readonly artifacts: readonly { readonly id: string; readonly bytesBase64: string }[];
  readonly opening: { readonly manifest: unknown };
}
const cases = (protocolVectors as unknown as { cases: readonly ProtocolCase[] }).cases;

/** A real Chapter 2 snapshot prepared from a synthetic case, with a fresh blinding nonce. */
export async function prepareSynthetic(
  id: 'generic' | 'legal' | 'legal-revised',
): Promise<PreparedReviewPackage> {
  const found = cases.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no case ${id}`);
  const bytes = new Map(
    found.artifacts.map((item) => [
      item.id,
      Uint8Array.from(atob(item.bytesBase64), (c) => c.charCodeAt(0)),
    ]),
  );
  const prepared = await prepareReviewPackage(found.opening.manifest, bytes);
  if (!prepared.ok) throw new Error(prepared.error.code);
  return prepared.data;
}

/** An in-memory object store standing in for remote storage, with a switch to lose objects. */
export class MemoryStore {
  readonly objects = new Map<string, Uint8Array>();
  put(objectId: string, bytes: Uint8Array): void {
    this.objects.set(objectId, bytes);
  }
  readonly fetch = (ref: { objectId: string }): Promise<Uint8Array | null> =>
    Promise.resolve(this.objects.get(ref.objectId) ?? null);
}
