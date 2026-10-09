/** Test-only helpers. Not exported from the package entry point. */
import vectorsFile from '../../../../fixtures/protocol-v1/vectors.json';
import type { Bytes } from './bytes';
import type { ProtocolErrorCode, ProtocolResult } from './errors';
import type { CommitmentOpeningV1, ReceiptReferenceV1, ReviewPackageV1 } from './schemas';

export interface VectorCase {
  readonly id: string;
  readonly description: string;
  readonly artifacts: readonly { readonly id: string; readonly bytesBase64: string }[];
  readonly opening: CommitmentOpeningV1;
  readonly expected: {
    readonly canonicalManifestUtf8Hex: string;
    readonly artifactDigests: Readonly<Record<string, string>>;
    readonly packageDigest: string;
    readonly commitment: string;
    readonly reference: ReceiptReferenceV1;
  };
}

interface VectorsFile {
  readonly domains: { readonly package: string; readonly commitment: string };
  readonly cases: readonly VectorCase[];
}

/** Literal expected values committed in fixtures/protocol-v1/vectors.json. Never rewritten by tests. */
export const vectors = vectorsFile as unknown as VectorsFile;

export function getCase(id: string): VectorCase {
  const found = vectors.cases.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing vector case ${id}`);
  return found;
}

export function decodeBase64(value: string): Bytes {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** Fresh, caller-owned copies of a case's exact artifact bytes. */
export function artifactMap(vector: VectorCase): Map<string, Bytes> {
  return new Map(vector.artifacts.map((item) => [item.id, decodeBase64(item.bytesBase64)]));
}

/** Mutable deep copy of a case's manifest, for tamper tests. */
export function manifestOf(vector: VectorCase): ReviewPackageV1 {
  return structuredClone(vector.opening.manifest);
}

export function openingOf(vector: VectorCase): CommitmentOpeningV1 {
  return structuredClone(vector.opening);
}

export function expectOk<T>(result: ProtocolResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
  return result.data;
}

export function failureCode(result: ProtocolResult<unknown>): ProtocolErrorCode | 'OK' {
  return result.ok ? 'OK' : result.error.code;
}

export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at index ${String(index)}`);
  return item;
}

export const encodeUtf8 = (text: string): Bytes => new TextEncoder().encode(text);
