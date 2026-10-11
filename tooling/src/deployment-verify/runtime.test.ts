import { domainSeparator, keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  buildExpectedRuntime,
  collectImmutableNames,
  compareRuntime,
  resolveImmutable,
  shortString,
  type DeploymentContext,
} from './runtime';
import {
  CHAIN_ID,
  EXEC,
  NAMES,
  REGISTRY,
  SOLC_TRAILER,
  compiledFixture,
  deployedFixture,
} from './test-fixture';

const context: DeploymentContext = {
  chainId: CHAIN_ID,
  address: REGISTRY,
  eip712Name: 'LexAegisProofOfReview',
  eip712Version: '1',
};
const bytes = (hex: string) =>
  Uint8Array.from(hex.replace(/^0x/, '').match(/../g) ?? [], (pair) => parseInt(pair, 16));
const expectedOk = (compiled = compiledFixture(), libraries?: Record<string, Hex>) => {
  const built = buildExpectedRuntime({
    compiled,
    immutableNames: NAMES,
    context,
    ...(libraries !== undefined && { libraries }),
  });
  if (!built.ok) throw new Error(built.reason);
  return built;
};
const flip = (hex: string, byteOffset: number): Hex => {
  const body = hex.replace(/^0x/, '');
  const at = byteOffset * 2;
  const changed = (parseInt(body.slice(at, at + 2), 16) ^ 0x01).toString(16).padStart(2, '0');
  return `0x${body.slice(0, at)}${changed}${body.slice(at + 2)}`;
};

describe('immutable resolution (from the deployment context, never from observed bytes)', () => {
  it('names immutables from the syntax trees of one compilation', () => {
    const ast = {
      nodeType: 'SourceUnit',
      nodes: [
        {
          nodeType: 'ContractDefinition',
          name: 'EIP712',
          nodes: [
            {
              nodeType: 'VariableDeclaration',
              id: 3240,
              name: '_cachedChainId',
              mutability: 'immutable',
            },
            { nodeType: 'VariableDeclaration', id: 9, name: 'ordinary', mutability: 'mutable' },
          ],
        },
      ],
    };
    expect([...collectImmutableNames([ast])]).toEqual([
      ['3240', { contract: 'EIP712', name: '_cachedChainId' }],
    ]);
  });
  it('derives every OpenZeppelin EIP712 immutable, and the separator equals an independent implementation', () => {
    const resolve = (name: string) => resolveImmutable({ contract: 'EIP712', name }, context);
    expect(resolve('_cachedChainId')).toBe(`0x${CHAIN_ID.toString(16).padStart(64, '0')}`);
    expect(resolve('_cachedThis')).toBe(`0x${'0'.repeat(24)}${REGISTRY.slice(2)}`);
    expect(resolve('_hashedName')).toBe(
      keccak256(new TextEncoder().encode('LexAegisProofOfReview')),
    );
    expect(resolve('_hashedVersion')).toBe(keccak256(new TextEncoder().encode('1')));
    expect(resolve('_cachedDomainSeparator')).toBe(
      domainSeparator({
        domain: {
          name: 'LexAegisProofOfReview',
          version: '1',
          chainId: CHAIN_ID,
          verifyingContract: REGISTRY,
        },
      }),
    );
    // "1" is one byte: 0x31 then zeros then the length 1.
    expect(resolve('_version')).toBe(`0x31${'00'.repeat(30)}01`);
    expect(resolve('_name')).toBe(shortString('LexAegisProofOfReview'));
    expect(shortString('x'.repeat(32))).toBeNull();
  });
  it('has no rule for an unknown immutable: it is unresolved, never guessed', () => {
    expect(resolveImmutable({ contract: 'EIP712', name: '_somethingNew' }, context)).toBeNull();
    expect(resolveImmutable({ contract: 'Other', name: '_cachedChainId' }, context)).toBeNull();
    const unknown = buildExpectedRuntime({
      compiled: compiledFixture(),
      immutableNames: new Map([['10', { contract: 'Other', name: 'x' }]]),
      context,
    });
    expect(unknown).toMatchObject({ ok: false, reason: 'UNRESOLVED_IMMUTABLE' });
    const undeclared = buildExpectedRuntime({
      compiled: compiledFixture(),
      immutableNames: new Map(),
      context,
    });
    expect(undeclared).toMatchObject({ ok: false, reason: 'UNRESOLVED_IMMUTABLE' });
  });
  it('fills every range and refuses a range that is not zeroed or not 32 bytes', () => {
    const built = expectedOk();
    expect(`0x${Buffer.from(built.code).toString('hex')}`).toBe(deployedFixture());
    expect(built.immutables.map((item) => item.label)).toEqual([
      'EIP712._cachedChainId',
      'EIP712._cachedThis',
    ]);
    const compiled = compiledFixture();
    compiled.deployedBytecode.immutableReferences['10'] = [{ start: 0, length: 32 }]; // overlaps real code
    expect(buildExpectedRuntime({ compiled, immutableNames: NAMES, context })).toMatchObject({
      ok: false,
      reason: 'IMMUTABLE_RANGE_INVALID',
    });
    const short = compiledFixture();
    short.deployedBytecode.immutableReferences['10'] = [{ start: 6, length: 20 }];
    expect(buildExpectedRuntime({ compiled: short, immutableNames: NAMES, context })).toMatchObject(
      { ok: false, reason: 'IMMUTABLE_RANGE_INVALID' },
    );
  });
  it('links a library only from a supplied address; a missing one is unresolved', () => {
    const library = `0x${'1b'.repeat(20)}`;
    expect(
      buildExpectedRuntime({
        compiled: compiledFixture({ link: true }),
        immutableNames: NAMES,
        context,
      }),
    ).toMatchObject({
      ok: false,
      reason: 'UNRESOLVED_LINK',
      detail: 'src/Lib.sol:Lib',
    });
    const linked = expectedOk(compiledFixture({ link: true }), { 'src/Lib.sol:Lib': library });
    expect(`0x${Buffer.from(linked.code).toString('hex')}`).toBe(
      deployedFixture({ link: library.slice(2) }),
    );
    expect(linked.regions.filter((region) => region.kind === 'link')).toHaveLength(1);
  });
});

describe('runtime comparison', () => {
  const compare = (
    observed: string,
    compiled = compiledFixture(),
    metadataAppended = true,
    libraries?: Record<string, Hex>,
  ) => {
    const built = expectedOk(compiled, libraries);
    return compareRuntime({
      observed: bytes(observed),
      expected: built.code,
      regions: built.regions,
      metadataAppended,
    });
  };
  it('exact match: every byte, immutables and trailer included', () => {
    const result = compare(deployedFixture());
    expect(result.status).toBe('exact_match');
    expect(result.full.observed).toEqual(result.full.expected);
    expect(result.normalised).toBeNull();
    expect(result.trailer.observed).toMatchObject({ solcVersion: '0.8.37' });
  });
  it('metadata-only match: a different valid trailer, every executable byte equal', () => {
    // The observed code carries an ipfs hash the local build did not append.
    const other = `a2646970667358221220${'cd'.repeat(32)}64736f6c63430008250033`;
    const result = compare(deployedFixture({ trailer: other }));
    expect(result.status).toBe('metadata_only_match');
    expect(result.full.observed.keccak256).not.toBe(result.full.expected.keccak256);
    expect(result.normalised?.observed).toEqual(result.normalised?.expected);
    expect(result.normalised?.observed.bytes).toBe(73);
    expect(result.differences.executableBytes).toBe(0);
  });
  it('a one-byte executable change is a mismatch, with or without a differing trailer', () => {
    const changed = compare(flip(deployedFixture(), 2));
    expect(changed.status).toBe('mismatch');
    expect(changed.differences).toMatchObject({
      executableBytes: 1,
      immutables: [],
      links: [],
      firstOffset: 2,
    });
    const other = `a2646970667358221220${'cd'.repeat(32)}64736f6c63430008250033`;
    const both = compare(flip(deployedFixture({ trailer: other }), 39));
    expect(both.status).toBe('mismatch');
    expect(both.differences.executableBytes).toBe(1);
  });
  it('a changed immutable value and a changed linked address are named as such', () => {
    const immutable = compare(flip(deployedFixture(), 37)); // last byte of the chain id word
    expect(immutable.status).toBe('mismatch');
    expect(immutable.differences).toMatchObject({
      executableBytes: 0,
      immutables: ['EIP712._cachedChainId'],
    });

    const library = `0x${'1b'.repeat(20)}`;
    const link = compare(
      flip(deployedFixture({ link: library.slice(2) }), 80),
      compiledFixture({ link: true }),
      true,
      { 'src/Lib.sol:Lib': library },
    );
    expect(link.status).toBe('mismatch');
    expect(link.differences).toMatchObject({ executableBytes: 0, links: ['src/Lib.sol:Lib'] });
  });
  it('a truncated or malformed observed trailer is never stripped: the bytes are compared as code', () => {
    const truncated = deployedFixture({ trailer: 'a164736f6c63430008000a' }); // one byte short, length unchanged
    const result = compare(truncated);
    expect(result.status).toBe('mismatch');
    expect(result.normalised).toBeNull();
    expect(typeof result.trailer.observed).toBe('string');
    // A longer suffix whose "length" would swallow executable bytes if it were trusted.
    const greedy = compare(`${deployedFixture().slice(0, -4)}0040`);
    expect(greedy.status).toBe('mismatch');
    expect(greedy.normalised).toBeNull();
  });
  it('with metadata disabled the complete runtime is compared and nothing is ever set aside', () => {
    const compiled = compiledFixture({ appendCBOR: false, trailer: '' });
    const exact = compare(deployedFixture({ trailer: '' }), compiled, false);
    expect(exact.status).toBe('exact_match');
    expect(exact.trailer.expected).toBe('METADATA_NOT_APPENDED');
    // Observed code with a trailer appended is NOT a metadata-only match for a no-metadata build.
    const extra = compare(deployedFixture({ trailer: SOLC_TRAILER }), compiled, false);
    expect(extra.status).toBe('mismatch');
    expect(extra.differences.lengthDiffers).toBe(true);
    // Even when the build's own code happens to end in trailer-shaped bytes, they stay executable.
    const lookalike = compiledFixture({ appendCBOR: false, trailer: SOLC_TRAILER });
    const changedTail = compare(flip(deployedFixture(), 73 + 9), lookalike, false);
    expect(changedTail.status).toBe('mismatch');
    expect(changedTail.differences.executableBytes).toBe(1);
  });
  it('a length difference in the executable part is a mismatch', () => {
    const longer = `${deployedFixture().slice(0, 2 + 73 * 2)}00${SOLC_TRAILER}`;
    const result = compare(longer);
    expect(result.status).toBe('mismatch');
    expect(result.differences.lengthDiffers).toBe(true);
    expect(EXEC.head.length).toBe(12);
  });
});
