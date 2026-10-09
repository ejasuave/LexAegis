/**
 * TEST HARNESS ONLY. Local chain, well-known development accounts and compiled-artifact access
 * for the Anvil compatibility tests. Nothing here is imported by a package or an application.
 */
import { join } from 'node:path';
import { isHex, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { z } from 'zod';
import {
  prepareReviewPackage,
  type PreparedReviewPackage,
  type ReceiptReferenceV1,
  type ReviewPackageV1,
} from '@lexaegis/protocol/v1';
import type { RegistryResult, ReviewActionV1 } from '@lexaegis/sdk/registry';
import protocolVectorsFile from '../../fixtures/protocol-v1/vectors.json';
import registryVectorsFile from '../../fixtures/registry-v1/vectors.json';
import { contractsDir, readJsonFile } from '../scripts/lib/toolchain';

/**
 * Anvil's published development mnemonic. The accounts are funded only on a throwaway local
 * chain and must never be used anywhere else.
 */
const DEVELOPMENT_MNEMONIC = 'test test test test test test test test test test test junk';
const developmentAccount = (addressIndex: number) =>
  mnemonicToAccount(DEVELOPMENT_MNEMONIC, { addressIndex });

export const accounts = {
  deployer: developmentAccount(0),
  /** Signs typed data. It sends a transaction only to cancel its own nonce. */
  reviewer: developmentAccount(1),
  /** Unrelated accounts that submit other people's signed actions. */
  executor: developmentAccount(2),
  secondExecutor: developmentAccount(3),
  /** Owner key of the synthetic ERC-1271 contract account. */
  accountOwner: developmentAccount(4),
  /** Never authorized for anything. */
  stranger: developmentAccount(5),
} as const;

const compiledSchema = z.looseObject({
  bytecode: z.looseObject({ object: z.string().regex(/^0x(?:[0-9a-f]{2})+$/) }),
});

/** Creation bytecode from the Foundry output directory. */
export function creationCode(sourceFile: string, contract: string): Hex {
  const path = join(contractsDir, 'out', sourceFile, `${contract}.json`);
  const { object } = compiledSchema.parse(readJsonFile(path)).bytecode;
  if (!isHex(object)) throw new Error(`no bytecode in ${path}`);
  return object;
}

export interface RegistryVector {
  readonly id: string;
  readonly chainId: string;
  readonly registryAddress: string;
  readonly action: ReviewActionV1;
  readonly expected: { readonly digest: string; readonly signature: string };
}

/** Literal registry vectors. Never rewritten by tests. */
export const registryVectors = (
  registryVectorsFile as unknown as { readonly vectors: readonly RegistryVector[] }
).vectors;

interface ProtocolCase {
  readonly id: string;
  readonly artifacts: readonly { readonly id: string; readonly bytesBase64: string }[];
  readonly opening: { readonly manifest: ReviewPackageV1 };
}

const protocolCases = (
  protocolVectorsFile as unknown as { readonly cases: readonly ProtocolCase[] }
).cases;

function protocolCase(id: string): ProtocolCase {
  const found = protocolCases.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing protocol case ${id}`);
  return found;
}

/** The exact synthetic artifact bytes of a Chapter 2 case. */
export function syntheticArtifacts(caseId: 'legal' | 'legal-revised'): Map<string, Uint8Array> {
  return new Map(
    protocolCase(caseId).artifacts.map((item) => [
      item.id,
      Uint8Array.from(atob(item.bytesBase64), (character) => character.charCodeAt(0)),
    ]),
  );
}

export interface LocalBinding {
  readonly chainId: string;
  readonly registryAddress: string;
  readonly reviewerAddress: string;
}

/**
 * Prepares a new package from a Chapter 2 synthetic case, bound to the real local chain,
 * registry and reviewer. A new manifest is built and prepared from scratch; no existing opening
 * is edited.
 */
export async function prepareLocalPackage(
  caseId: 'legal' | 'legal-revised',
  context: LocalBinding,
  supersedes: ReceiptReferenceV1 | null,
): Promise<PreparedReviewPackage> {
  const manifest = {
    ...structuredClone(protocolCase(caseId).opening.manifest),
    context,
    supersedes,
  };
  const prepared = await prepareReviewPackage(manifest, syntheticArtifacts(caseId));
  if (!prepared.ok) throw new Error(`could not prepare ${caseId}: ${prepared.error.code}`);
  return prepared.data;
}

export function expectOk<T>(result: RegistryResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
  return result.data;
}

export function lower(value: string): string {
  return value.toLowerCase();
}
