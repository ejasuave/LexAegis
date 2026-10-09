/** Test-only helpers. Not exported from the package entry point. */
import protocolVectorsFile from '../../../../fixtures/protocol-v1/vectors.json';
import registryVectorsFile from '../../../../fixtures/registry-v1/vectors.json';
import {
  prepareReviewPackage,
  type CommitmentOpeningV1,
  type PreparedReviewPackage,
  type ReceiptReferenceV1,
} from '@lexaegis/protocol/v1';
import type { RegistryErrorCode, RegistryResult } from './errors';
import type { BoundReviewAction, ReviewActionV1 } from './typed-data';

export interface RegistryVector {
  readonly id: string;
  readonly chainId: string;
  readonly registryAddress: string;
  readonly action: ReviewActionV1;
  readonly expected: {
    readonly domainSeparator: string;
    readonly structHash: string;
    readonly digest: string;
    readonly signature: string;
  };
}

interface RegistryVectorsFile {
  readonly eip712: {
    readonly domain: { readonly name: string; readonly version: string };
    readonly domainTypeString: string;
    readonly primaryType: string;
    readonly typeString: string;
    readonly typeHash: string;
  };
  readonly actionCodes: Readonly<Record<string, number>>;
  readonly signer: { readonly privateKey: string; readonly address: string };
  readonly vectors: readonly RegistryVector[];
}

/** Literal values from fixtures/registry-v1/vectors.json. Never rewritten by tests. */
export const registryVectors = registryVectorsFile as unknown as RegistryVectorsFile;

export function boundActionOf(vector: RegistryVector): BoundReviewAction {
  return {
    chainId: vector.chainId,
    registryAddress: vector.registryAddress,
    action: structuredClone(vector.action),
  };
}

interface ProtocolCase {
  readonly id: string;
  readonly artifacts: readonly { readonly id: string; readonly bytesBase64: string }[];
  readonly opening: CommitmentOpeningV1;
  readonly expected: { readonly reference: ReceiptReferenceV1 };
}

const protocolCases = (
  protocolVectorsFile as unknown as { readonly cases: readonly ProtocolCase[] }
).cases;

/** A Chapter 2 synthetic case: `legal` supersedes nothing, `legal-revised` supersedes `legal`. */
export function protocolCase(id: 'generic' | 'legal' | 'legal-revised'): ProtocolCase {
  const found = protocolCases.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing protocol case ${id}`);
  return found;
}

export function artifactBytes(vector: ProtocolCase): Map<string, Uint8Array> {
  return new Map(
    vector.artifacts.map((item) => [
      item.id,
      Uint8Array.from(atob(item.bytesBase64), (character) => character.charCodeAt(0)),
    ]),
  );
}

/** Prepares a real snapshot (fresh blinding nonce) from a Chapter 2 synthetic case. */
export async function prepareCase(
  id: 'generic' | 'legal' | 'legal-revised',
): Promise<PreparedReviewPackage> {
  const vector = protocolCase(id);
  const prepared = await prepareReviewPackage(vector.opening.manifest, artifactBytes(vector));
  if (!prepared.ok) throw new Error(`could not prepare ${id}: ${prepared.error.code}`);
  return prepared.data;
}

export function expectOk<T>(result: RegistryResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
  return result.data;
}

export function failureCode(result: RegistryResult<unknown>): RegistryErrorCode | 'OK' {
  return result.ok ? 'OK' : result.error.code;
}

export const NONCE = '0';
export const DEADLINE = '1800000600';
export const UINT256_MAX_DECIMAL = (2n ** 256n - 1n).toString();
export const ZERO32 = `0x${'00'.repeat(32)}`;
