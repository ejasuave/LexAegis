import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, toEventSelector, toFunctionSelector, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { proofOfReviewRegistryAbi } from '@lexaegis/sdk/registry';

/*
 * No chain and no deployment. The published interface, the compiled registry, the committed
 * artifact and the SDK's typed ABI must describe one and the same contract. Compiled output comes
 * from the pinned `forge build` that `pnpm test:contracts:integration` runs first; if it is missing
 * these tests fail rather than skip, because "not compared" is not "equal".
 */

const contracts = join(dirname(fileURLToPath(import.meta.url)), '..');
const repository = join(contracts, '..');
// The caller states the file's shape: this is a test reading its own committed artifacts.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const json = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

interface Param {
  name: string;
  type: string;
  internalType?: string;
  indexed?: boolean;
  components?: Param[];
}
interface Item {
  type: string;
  name?: string;
  inputs?: Param[];
  outputs?: Param[];
  stateMutability?: string;
}
interface Compiled {
  abi: Item[];
  bytecode: { object: string };
  deployedBytecode: { object: string };
}

const compiledPath = (file: string, name: string): string =>
  join(contracts, 'out', `${file}.sol`, `${name}.json`);
const registryOut = compiledPath('ProofOfReviewRegistry', 'ProofOfReviewRegistry');
const interfaceOut = compiledPath('IProofOfReviewRegistry', 'IProofOfReviewRegistry');

const typeOf = (param: Param): string =>
  param.type.startsWith('tuple')
    ? `(${(param.components ?? []).map(typeOf).join(',')})${param.type.slice('tuple'.length)}`
    : param.type;
const signature = (item: Item): string =>
  `${item.name ?? ''}(${(item.inputs ?? []).map(typeOf).join(',')})`;
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('compiled output is present', () => {
  it('the interface and the registry were both compiled by the pinned build', () => {
    expect(existsSync(registryOut), registryOut).toBe(true);
    expect(
      existsSync(interfaceOut),
      'the interface compiles on its own, as part of the same build',
    ).toBe(true);
  });
});

describe('IProofOfReviewRegistry against the deployed contract', () => {
  const registry = json<Compiled>(registryOut);
  const iface = json<Compiled>(interfaceOut);
  const artifact = json<{
    selectors: {
      functions: Record<string, string>;
      events: Record<string, string>;
      errors: Record<string, string>;
    };
    eip712: { fields: { name: string; type: string }[]; typeString: string };
    bytecode: { creationCodeKeccak256: string };
  }>(join(contracts, 'artifacts', 'registry-v1.json'));

  /** Members the registry has only because it inherits the EIP-712 base contract. */
  const INHERITED = new Set([
    'function REVIEW_ACTION_TYPEHASH()',
    'function eip712Domain()',
    'event EIP712DomainChanged()',
    'error InvalidShortString()',
    'error StringTooLong(string)',
  ]);
  const key = (item: Item): string => `${item.type} ${signature(item)}`;

  it('every interface member is present in the registry ABI with identical layout', () => {
    expect(iface.abi.length).toBeGreaterThan(15);
    for (const item of iface.abi) {
      const match = registry.abi.find((candidate) => key(candidate) === key(item));
      expect(match, key(item)).toBeDefined();
      // Complete member equality: tuple components, internal types, mutability, indexed flags, outputs.
      expect(match, key(item)).toEqual(item);
    }
  });

  it('the registry adds only inherited EIP-712 members, nothing else', () => {
    const interfaceKeys = new Set(iface.abi.map(key));
    const extra = registry.abi
      .filter((item) => !interfaceKeys.has(key(item)))
      .map(key)
      .sort();
    expect(extra).toEqual([...INHERITED].sort());
  });

  it('function, event and error selectors equal the committed artifact', () => {
    for (const item of iface.abi) {
      const signatureText = signature(item);
      if (item.type === 'function') {
        expect(toFunctionSelector(signatureText), signatureText).toBe(
          artifact.selectors.functions[signatureText],
        );
      } else if (item.type === 'event') {
        expect(toEventSelector(signatureText), signatureText).toBe(
          artifact.selectors.events[signatureText],
        );
      } else {
        expect(toFunctionSelector(signatureText), signatureText).toBe(
          artifact.selectors.errors[signatureText],
        );
      }
    }
  });

  it('indexed event fields are as documented', () => {
    const indexed = (name: string): boolean[] =>
      (iface.abi.find((item) => item.type === 'event' && item.name === name)?.inputs ?? []).map(
        (input) => input.indexed === true,
      );
    expect(indexed('ReceiptIssued')).toEqual([true, true, true, false, false]);
    expect(indexed('ReceiptRevoked')).toEqual([true, true, false, false]);
    expect(indexed('ReceiptSuperseded')).toEqual([true, true, true, false, false]);
    expect(indexed('NonceInvalidated')).toEqual([true, false, false, false]);
  });

  it('the ReviewAction tuple equals the signed EIP-712 fields, in order', () => {
    const execute = iface.abi.find((item) => item.type === 'function' && item.name === 'execute');
    const components = execute?.inputs?.[0]?.components ?? [];
    expect(components.map((component) => ({ name: component.name, type: component.type }))).toEqual(
      artifact.eip712.fields,
    );
    expect(
      `ReviewAction(${artifact.eip712.fields.map((field) => `${field.type} ${field.name}`).join(',')})`,
    ).toBe(artifact.eip712.typeString);
  });
});

describe('the SDK constant is the complete compiled ABI', () => {
  it('proofOfReviewRegistryAbi equals the compiler output, member for member', () => {
    const compiled = json<Compiled>(registryOut).abi;
    expect(JSON.parse(JSON.stringify(proofOfReviewRegistryAbi))).toEqual(compiled);
  });
});

describe('registry bytecode is unchanged under the recorded build', () => {
  const compiled = json<Compiled>(registryOut);
  const baseline = json<{
    compiledRegistry: { abiSha256: string; deployedBytecodeSha256: string };
  }>(join(repository, 'docs', 'evidence', 'chapter15-baseline-2026-10-11.json'));
  const protectedBaseline = json<{
    compiled: { abiSha256: string; deployedBytecodeSha256: string };
  }>(join(repository, 'docs', 'protected-baselines.json'));
  const artifact = json<{
    compiler: Record<string, unknown>;
    bytecode: { creationCodeKeccak256: string };
  }>(join(contracts, 'artifacts', 'registry-v1.json'));
  const deployment = json<{
    build: { creationCodeKeccak256: string; solc: string; evmVersion: string };
  }>(join(contracts, 'deployments', 'monad-testnet.json'));

  it('the runtime bytecode and ABI hashes equal both recorded baselines (metadata included)', () => {
    // The full object is hashed: nothing is stripped, so an appended metadata change would show.
    expect(sha256(compiled.deployedBytecode.object)).toBe(
      protectedBaseline.compiled.deployedBytecodeSha256,
    );
    expect(sha256(compiled.deployedBytecode.object)).toBe(
      baseline.compiledRegistry.deployedBytecodeSha256,
    );
    expect(sha256(JSON.stringify(compiled.abi))).toBe(baseline.compiledRegistry.abiSha256);
  });

  it('the creation code equals the committed artifact and the recorded testnet build', () => {
    const creation = keccak256(compiled.bytecode.object as Hex);
    expect(creation).toBe(artifact.bytecode.creationCodeKeccak256);
    expect(creation).toBe(deployment.build.creationCodeKeccak256);
  });

  it('the compiler settings are the recorded ones', () => {
    expect(artifact.compiler).toEqual({
      solc: deployment.build.solc,
      evmVersion: deployment.build.evmVersion,
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
      bytecodeHash: 'none',
    });
  });
});
