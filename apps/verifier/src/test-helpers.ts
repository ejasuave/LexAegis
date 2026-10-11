/** Test-only helpers: Chapter 2 literal vector bytes shaped into the files a recipient receives. */
import { toBase64Url } from '@lexaegis/protocol/portable';
import type { ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import vectorsFile from '../../../fixtures/protocol-v1/vectors.json';

interface Vector {
  readonly id: string;
  readonly artifacts: readonly { readonly id: string; readonly bytesBase64: string }[];
  readonly opening: {
    readonly manifest: { readonly artifacts: readonly { readonly id: string }[] };
  };
  readonly expected: { readonly reference: ReceiptReferenceV1 };
}

const cases = (vectorsFile as unknown as { readonly cases: readonly Vector[] }).cases;

export function vector(id: 'generic' | 'legal' | 'legal-revised'): Vector {
  const found = cases.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing vector ${id}`);
  return found;
}

const decode = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

/** The readable export bytes for a case: exactly what Chapter 5 writes. */
export function exportBytes(
  id: 'generic' | 'legal' | 'legal-revised',
  mutate: (envelope: Record<string, unknown>) => void = () => undefined,
): Uint8Array<ArrayBuffer> {
  const item = vector(id);
  const bytes = new Map(item.artifacts.map((a) => [a.id, decode(a.bytesBase64)]));
  const envelope: Record<string, unknown> = {
    schema: 'lexaegis.review-export.v1',
    receiptReference: item.expected.reference,
    opening: item.opening,
    artifacts: item.opening.manifest.artifacts.map((artifact) => ({
      artifactId: artifact.id,
      bytes: toBase64Url(bytes.get(artifact.id) ?? new Uint8Array()),
    })),
  };
  mutate(envelope);
  return new TextEncoder().encode(JSON.stringify(envelope));
}

export const openingBytes = (id: 'generic' | 'legal' | 'legal-revised') =>
  new TextEncoder().encode(JSON.stringify(vector(id).opening));

export const referenceOf = (id: 'generic' | 'legal' | 'legal-revised') =>
  vector(id).expected.reference;

/** A File-shaped object that records whether anything read it. */
export function fakeFile(bytes: Uint8Array, name = 'bundle.json') {
  let reads = 0;
  const file = {
    name,
    size: bytes.byteLength,
    arrayBuffer: () => {
      reads += 1;
      return Promise.resolve(bytes.slice().buffer);
    },
  } as unknown as File;
  return { file, reads: () => reads };
}
