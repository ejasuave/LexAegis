import { encodeAbiParameters, keccak256, sha256, type Hex } from 'viem';
import { z } from 'zod';
import { readMetadataTrailer, type MetadataTrailer, type TrailerFailure } from './cbor';

/*
 * Expected runtime bytecode and its comparison with observed code.
 *
 * The compiler emits zeros where an immutable value or a linked library address goes, and lists
 * those ranges. Each one is RESOLVED here from the pinned source and the authenticated deployment
 * context (chain, address, EIP-712 name and version) and written into the expected code. Nothing
 * is copied from the observed bytes, nothing is zero-masked and no range is skipped: an immutable
 * or link this module cannot derive makes the result "incomplete", never a match.
 */

const span = z.strictObject({
  start: z.number().int().nonnegative(),
  length: z.number().int().positive(),
});

export const compiledSchema = z.looseObject({
  bytecode: z.looseObject({ object: z.string().regex(/^0x[0-9a-fA-F_$]*$/) }),
  deployedBytecode: z.looseObject({
    object: z.string().regex(/^0x[0-9a-fA-F_$]+$/),
    immutableReferences: z.record(z.string(), z.array(span)).default({}),
    linkReferences: z.record(z.string(), z.record(z.string(), z.array(span))).default({}),
  }),
  metadata: z.looseObject({
    compiler: z.looseObject({ version: z.string() }),
    settings: z.looseObject({
      optimizer: z.looseObject({ enabled: z.boolean().optional(), runs: z.number().optional() }),
      evmVersion: z.string().optional(),
      viaIR: z.boolean().optional(),
      metadata: z
        .looseObject({ bytecodeHash: z.string().optional(), appendCBOR: z.boolean().optional() })
        .optional(),
      libraries: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
});
export type Compiled = z.infer<typeof compiledSchema>;

export interface ImmutableName {
  readonly contract: string;
  readonly name: string;
}

/** Immutable declarations by AST id, from the `ast` of every artifact of ONE compilation. */
export function collectImmutableNames(asts: readonly unknown[]): Map<string, ImmutableName> {
  const found = new Map<string, ImmutableName>();
  const visit = (node: unknown, contract: string | null): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, contract);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const owner =
      record.nodeType === 'ContractDefinition' && typeof record.name === 'string'
        ? record.name
        : contract;
    if (
      record.nodeType === 'VariableDeclaration' &&
      record.mutability === 'immutable' &&
      typeof record.id === 'number' &&
      typeof record.name === 'string' &&
      owner !== null
    ) {
      found.set(String(record.id), { contract: owner, name: record.name });
    }
    for (const value of Object.values(record)) visit(value, owner);
  };
  visit(asts, null);
  return found;
}

/** What is known, independently of the observed code, about the deployment being checked. */
export interface DeploymentContext {
  readonly chainId: bigint;
  readonly address: Hex;
  readonly eip712Name: string;
  readonly eip712Version: string;
}

const EIP712_DOMAIN_TYPEHASH = keccak256(
  new TextEncoder().encode(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
  ),
);
const word = (value: bigint): Hex => `0x${value.toString(16).padStart(64, '0')}`;
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** OpenZeppelin ShortString: the bytes left-aligned, the length in the last byte. Null over 31 bytes. */
export function shortString(value: string): Hex | null {
  const bytes = text(value);
  if (bytes.length > 31) return null;
  const out = new Uint8Array(32);
  out.set(bytes);
  out[31] = bytes.length;
  return `0x${Array.from(out, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The value the pinned constructor stores in each known immutable. EIP712 (OpenZeppelin 5.x):
 * `_hashedName`, `_hashedVersion`, `_cachedChainId`, `_cachedThis`, `_cachedDomainSeparator`,
 * `_name`, `_version`. Returns null for any immutable this module has no rule for.
 */
export function resolveImmutable(immutable: ImmutableName, context: DeploymentContext): Hex | null {
  if (immutable.contract !== 'EIP712') return null;
  const hashedName = keccak256(text(context.eip712Name));
  const hashedVersion = keccak256(text(context.eip712Version));
  switch (immutable.name) {
    case '_hashedName':
      return hashedName;
    case '_hashedVersion':
      return hashedVersion;
    case '_cachedChainId':
      return word(context.chainId);
    case '_cachedThis':
      return word(BigInt(context.address));
    case '_cachedDomainSeparator':
      return keccak256(
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'bytes32' },
            { type: 'bytes32' },
            { type: 'uint256' },
            { type: 'address' },
          ],
          [EIP712_DOMAIN_TYPEHASH, hashedName, hashedVersion, context.chainId, context.address],
        ),
      );
    case '_name':
      return shortString(context.eip712Name);
    case '_version':
      return shortString(context.eip712Version);
    default:
      return null;
  }
}

export interface Region {
  readonly kind: 'immutable' | 'link';
  readonly label: string;
  readonly start: number;
  readonly length: number;
}

export type ExpectedRuntime =
  | {
      readonly ok: true;
      readonly code: Uint8Array;
      readonly regions: Region[];
      readonly immutables: { label: string; value: Hex; occurrences: number }[];
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'UNRESOLVED_IMMUTABLE'
        | 'UNRESOLVED_LINK'
        | 'IMMUTABLE_RANGE_INVALID'
        | 'LINK_RANGE_INVALID'
        | 'ARTIFACT_BYTECODE_INVALID';
      readonly detail: string;
    };

const fromHex = (value: string): Uint8Array => {
  const body = value.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/**
 * Builds the complete expected runtime: the compiled code with every immutable and link range
 * filled with its independently derived value.
 */
export function buildExpectedRuntime(input: {
  readonly compiled: Compiled;
  readonly immutableNames: ReadonlyMap<string, ImmutableName>;
  readonly context: DeploymentContext;
  /** Library addresses by "<source file>:<library>", from the deployment record. */
  readonly libraries?: Readonly<Record<string, Hex>>;
}): ExpectedRuntime {
  const { deployedBytecode } = input.compiled;
  // Unlinked code carries `__$<hash>$__` placeholders where an address goes: 40 characters each.
  const object = deployedBytecode.object.replace(/__\$[0-9a-fA-F]{34}\$__/g, '0'.repeat(40));
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(object)) {
    return {
      ok: false,
      reason: 'ARTIFACT_BYTECODE_INVALID',
      detail: 'runtime object is not whole bytes',
    };
  }
  const code = fromHex(object);
  const regions: Region[] = [];
  const immutables: { label: string; value: Hex; occurrences: number }[] = [];
  const fill = (start: number, bytes: Uint8Array): boolean => {
    if (start + bytes.length > code.length) return false;
    // The compiler leaves these ranges zeroed. Anything else means the ranges are not what they claim.
    for (let i = 0; i < bytes.length; i += 1) if (code[start + i] !== 0) return false;
    code.set(bytes, start);
    return true;
  };

  for (const [id, spans] of Object.entries(deployedBytecode.immutableReferences)) {
    const named = input.immutableNames.get(id);
    if (named === undefined)
      return {
        ok: false,
        reason: 'UNRESOLVED_IMMUTABLE',
        detail: `AST id ${id} has no declaration`,
      };
    const label = `${named.contract}.${named.name}`;
    const value = resolveImmutable(named, input.context);
    if (value === null) return { ok: false, reason: 'UNRESOLVED_IMMUTABLE', detail: label };
    for (const { start, length } of spans) {
      if (length !== 32 || !fill(start, fromHex(value))) {
        return {
          ok: false,
          reason: 'IMMUTABLE_RANGE_INVALID',
          detail: `${label} at ${String(start)}`,
        };
      }
      regions.push({ kind: 'immutable', label, start, length });
    }
    immutables.push({ label, value, occurrences: spans.length });
  }
  for (const [file, libraries] of Object.entries(deployedBytecode.linkReferences)) {
    for (const [library, spans] of Object.entries(libraries)) {
      const label = `${file}:${library}`;
      const address = input.libraries?.[label];
      if (address === undefined || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        return { ok: false, reason: 'UNRESOLVED_LINK', detail: label };
      }
      for (const { start, length } of spans) {
        if (length !== 20 || !fill(start, fromHex(address))) {
          return {
            ok: false,
            reason: 'LINK_RANGE_INVALID',
            detail: `${label} at ${String(start)}`,
          };
        }
        regions.push({ kind: 'link', label, start, length });
      }
    }
  }
  return { ok: true, code, regions, immutables };
}

export interface CodeIdentity {
  readonly bytes: number;
  readonly keccak256: Hex;
  readonly sha256: Hex;
}
const identity = (code: Uint8Array): CodeIdentity => ({
  bytes: code.length,
  keccak256: keccak256(code),
  sha256: sha256(code),
});

export interface Comparison {
  readonly status: 'exact_match' | 'metadata_only_match' | 'mismatch';
  readonly full: { readonly observed: CodeIdentity; readonly expected: CodeIdentity };
  /** Present only when both sides carry a validated compiler trailer: the code without it. */
  readonly normalised: { readonly observed: CodeIdentity; readonly expected: CodeIdentity } | null;
  readonly trailer: {
    readonly expected: MetadataTrailer | TrailerFailure | 'METADATA_NOT_APPENDED';
    readonly observed: MetadataTrailer | TrailerFailure | 'NOT_EXAMINED';
  };
  /** Where the executable part differs, by kind. Empty for a match. */
  readonly differences: {
    readonly lengthDiffers: boolean;
    readonly executableBytes: number;
    readonly immutables: string[];
    readonly links: string[];
    readonly firstOffset: number | null;
  };
}

/**
 * Exact comparison first. Only if that fails, and only when the build appended metadata and BOTH
 * sides end in a validated compiler trailer, the trailers alone are set aside and every remaining
 * byte is compared. With metadata disabled the complete runtime is compared and nothing is stripped.
 */
export function compareRuntime(input: {
  readonly observed: Uint8Array;
  readonly expected: Uint8Array;
  readonly regions: readonly Region[];
  /** From the build settings (`metadata.appendCBOR`), not guessed from the bytes. */
  readonly metadataAppended: boolean;
}): Comparison {
  const { observed, expected } = input;
  const full = { observed: identity(observed), expected: identity(expected) };
  const none = {
    lengthDiffers: false,
    executableBytes: 0,
    immutables: [],
    links: [],
    firstOffset: null,
  };
  const expectedTrailer = input.metadataAppended ? readMetadataTrailer(expected) : null;
  const expectedSeen =
    expectedTrailer === null
      ? 'METADATA_NOT_APPENDED'
      : expectedTrailer.ok
        ? expectedTrailer.trailer
        : expectedTrailer.reason;

  if (full.observed.keccak256 === full.expected.keccak256 && observed.length === expected.length) {
    const observedTrailer = input.metadataAppended ? readMetadataTrailer(observed) : null;
    return {
      status: 'exact_match',
      full,
      normalised: null,
      trailer: {
        expected: expectedSeen,
        observed:
          observedTrailer === null
            ? 'NOT_EXAMINED'
            : observedTrailer.ok
              ? observedTrailer.trailer
              : observedTrailer.reason,
      },
      differences: none,
    };
  }

  let observedBody = observed;
  let expectedBody = expected;
  let normalised: Comparison['normalised'] = null;
  let observedSeen: Comparison['trailer']['observed'] = 'NOT_EXAMINED';
  if (expectedTrailer?.ok === true) {
    const observedTrailer = readMetadataTrailer(observed);
    observedSeen = observedTrailer.ok ? observedTrailer.trailer : observedTrailer.reason;
    if (observedTrailer.ok) {
      observedBody = observed.subarray(0, observed.length - observedTrailer.trailer.totalBytes);
      expectedBody = expected.subarray(0, expected.length - expectedTrailer.trailer.totalBytes);
      normalised = { observed: identity(observedBody), expected: identity(expectedBody) };
    }
  }

  const differing: number[] = [];
  const shared = Math.min(observedBody.length, expectedBody.length);
  for (let i = 0; i < shared; i += 1) if (observedBody[i] !== expectedBody[i]) differing.push(i);
  const lengthDiffers = observedBody.length !== expectedBody.length;
  if (normalised !== null && differing.length === 0 && !lengthDiffers) {
    return {
      status: 'metadata_only_match',
      full,
      normalised,
      trailer: { expected: expectedSeen, observed: observedSeen },
      differences: none,
    };
  }
  const immutables = new Set<string>();
  const links = new Set<string>();
  let executableBytes = 0;
  for (const offset of differing) {
    const region = input.regions.find(
      (item) => offset >= item.start && offset < item.start + item.length,
    );
    if (region === undefined) executableBytes += 1;
    else if (region.kind === 'immutable') immutables.add(region.label);
    else links.add(region.label);
  }
  return {
    status: 'mismatch',
    full,
    normalised,
    trailer: { expected: expectedSeen, observed: observedSeen },
    differences: {
      lengthDiffers,
      executableBytes,
      immutables: [...immutables].sort(),
      links: [...links].sort(),
      firstOffset: differing[0] ?? (lengthDiffers ? shared : null),
    },
  };
}
