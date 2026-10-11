import { keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { READ_METHODS, RpcUnavailable } from './rpc';
import {
  CHAIN_ID,
  DEPLOYMENT_BLOCK,
  REGISTRY,
  buildFixture,
  compiledFixture,
  deployedFixture,
  recordFixture,
  scriptedNode,
  type NodeScript,
} from './test-fixture';
import { EXIT, verifyDeployment, type BuildInput, type Policy } from './verify';

/*
 * UNIT CASES WITH STUBBED NETWORK RESPONSES. `scriptedNode` returns scripted answers; nothing here
 * is a chain observation. Real immutable resolution against a real local deployment is exercised in
 * contracts/integration/verify-deployment.anvil.test.ts, and the live result is recorded separately.
 */

const run = (
  script: NodeScript = {},
  over: {
    record?: unknown;
    build?: BuildInput | 'missing' | 'invalid';
    policy?: Policy;
    expectedChainId?: string;
  } = {},
) => {
  const rpc = scriptedNode(script);
  return verifyDeployment({
    record: over.record ?? recordFixture((script.code ?? deployedFixture()) as Hex),
    expectedChainId: over.expectedChainId ?? CHAIN_ID.toString(),
    build: over.build ?? buildFixture(),
    rpc,
    policy: over.policy ?? 'exact',
  });
};
const flip = (hex: string, byteOffset: number): Hex => {
  const at = 2 + byteOffset * 2;
  return `${hex.slice(0, at)}${(parseInt(hex.slice(at, at + 2), 16) ^ 1).toString(16).padStart(2, '0')}${hex.slice(at + 2)}` as Hex;
};
const IPFS_TRAILER = `a2646970667358221220${'cd'.repeat(32)}64736f6c63430008250033`;

describe('deployment verification (stubbed network)', () => {
  it('reports an exact match with a re-checked checkpoint and a consistent deployment transaction', async () => {
    const report = await run();
    expect(report).toMatchObject({
      outcome: 'match',
      exitCode: EXIT.MATCH,
      issues: [],
      codeMatch: 'exact_match',
      codePin: { equal: true },
      checkpoint: { blockNumber: '997', finalizedBlock: '1000', rechecked: true },
      deploymentTransaction: {
        status: 'consistent',
        creation: 'CREATE by an externally owned transaction (to = null)',
      },
      endpoint: 'https://rpc.example.invalid',
    });
    expect(report.build?.immutables.map((item) => item.label)).toEqual([
      'EIP712._cachedChainId',
      'EIP712._cachedThis',
    ]);
    expect(Object.values(report.deploymentTransaction?.checks ?? {}).every(Boolean)).toBe(true);
    expect(report.deploymentTransaction?.blockTimestamp).toBe('2026-10-09T00:00:00.000Z');
  });

  it('only ever reads: no signing, sending or estimating method is called', async () => {
    const report = await run();
    expect(report.methods.length).toBeGreaterThan(5);
    for (const method of report.methods) {
      expect((READ_METHODS as readonly string[]).includes(method)).toBe(true);
      expect(/send|sign|estimate|personal|wallet|accounts/i.test(method)).toBe(false);
    }
    expect(READ_METHODS).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_getTransactionByHash',
      'eth_getTransactionReceipt',
    ]);
  });

  it('one changed executable byte, immutable byte or code pin is a mismatch (exit 10)', async () => {
    const executable = await run({ code: flip(deployedFixture(), 3) }, { record: recordFixture() });
    expect(executable).toMatchObject({ outcome: 'mismatch', exitCode: 10, codeMatch: 'mismatch' });
    expect(executable.issues).toEqual(
      expect.arrayContaining(['EXECUTABLE_MISMATCH', 'CODE_PIN_MISMATCH']),
    );

    const immutable = await run({ code: flip(deployedFixture(), 71) }, { record: recordFixture() });
    expect(immutable.issues).toEqual(expect.arrayContaining(['IMMUTABLE_MISMATCH']));
    expect(immutable.comparison?.differences.immutables).toEqual(['EIP712._cachedThis']);
    expect(immutable.issues).not.toContain('EXECUTABLE_MISMATCH');

    // The code equals the build, but the record pins a different hash: the stronger pin still fails.
    const pinned = await run(
      {},
      { record: { ...recordFixture(), runtimeCodeKeccak256: keccak256('0x00') } },
    );
    expect(pinned).toMatchObject({
      outcome: 'mismatch',
      codeMatch: 'exact_match',
      issues: ['CODE_PIN_MISMATCH'],
    });
  });

  it('a metadata-only match passes only under the metadata-insensitive policy, and is labelled', async () => {
    const code = deployedFixture({ trailer: IPFS_TRAILER });
    const exact = await run({ code });
    expect(exact).toMatchObject({
      outcome: 'mismatch',
      exitCode: 10,
      codeMatch: 'metadata_only_match',
    });
    expect(exact.issues).toEqual(['METADATA_ONLY_MATCH_UNDER_EXACT_POLICY']);
    const relaxed = await run({ code }, { policy: 'metadata-insensitive' });
    expect(relaxed).toMatchObject({
      outcome: 'match',
      exitCode: 0,
      codeMatch: 'metadata_only_match',
      issues: [],
    });
    expect(relaxed.comparison?.full.observed.keccak256).not.toBe(
      relaxed.comparison?.full.expected.keccak256,
    );

    // Same executable bytes, but the trailer names another compiler: provenance is checked apart.
    const otherCompiler = deployedFixture({ trailer: 'a164736f6c6343000824000a' });
    const provenance = await run({ code: otherCompiler }, { policy: 'metadata-insensitive' });
    expect(provenance.outcome).toBe('mismatch');
    expect(provenance.issues).toEqual(['COMPILER_VERSION_IN_TRAILER_DIFFERS']);
  });

  it('wrong network, wrong genesis and empty code are mismatches, never matches', async () => {
    expect(await run({ chainId: 143n })).toMatchObject({
      outcome: 'mismatch',
      issues: ['WRONG_CHAIN'],
      codeMatch: 'not_compared',
    });
    expect(await run({ genesis: `0x${'00'.repeat(32)}` })).toMatchObject({
      outcome: 'mismatch',
      issues: ['GENESIS_MISMATCH'],
    });
    expect(await run({ code: '0x' }, { record: recordFixture() })).toMatchObject({
      outcome: 'mismatch',
      issues: ['NO_RUNTIME_CODE'],
      codeMatch: 'not_compared',
    });
    // A record for another chain is refused before any request is made.
    const other = await run({}, { expectedChainId: '143' });
    expect(other).toMatchObject({
      outcome: 'invalid',
      exitCode: 11,
      issues: ['RECORD_NOT_EXPECTED_NETWORK'],
      methods: [],
    });
  });

  it('an unavailable, malformed or exhausted endpoint is unavailable (exit 12), with no result claimed', async () => {
    const down = await run({ fail: () => new RpcUnavailable('RPC_UNAVAILABLE') });
    expect(down).toMatchObject({
      outcome: 'unavailable',
      exitCode: 12,
      issues: ['RPC_UNAVAILABLE'],
      codeMatch: 'not_compared',
      comparison: null,
    });
    const malformed = await run({ code: 'not-hex' }, { record: recordFixture() });
    expect(malformed).toMatchObject({ outcome: 'unavailable', issues: ['RPC_MALFORMED'] });
    const late = await run({
      fail: (method) => (method === 'eth_getCode' ? new RpcUnavailable('BUDGET_EXCEEDED') : null),
    });
    expect(late).toMatchObject({ outcome: 'unavailable', issues: ['BUDGET_EXCEEDED'] });
    expect(await run({ finalized: null })).toMatchObject({
      outcome: 'unavailable',
      issues: ['NO_FINALIZED_BLOCK'],
    });
    expect(await run({ finalized: DEPLOYMENT_BLOCK + 2n })).toMatchObject({
      outcome: 'unavailable',
      issues: ['CHECKPOINT_BEFORE_DEPLOYMENT'],
    });
  });

  it('a checkpoint whose hash changes between reads is inconsistent, even if the code would match', async () => {
    const report = await run({
      blockHash: (number, reads) =>
        number === 997n && reads > 1
          ? `0x${'ff'.repeat(32)}`
          : `0x${(number + 0xabcdn).toString(16).padStart(64, '0')}`,
    });
    expect(report).toMatchObject({
      outcome: 'unavailable',
      exitCode: 12,
      checkpoint: { rechecked: false },
      codeMatch: 'not_compared',
    });
    expect(report.issues).toEqual(['CHECKPOINT_INCONSISTENT']);
  });

  it('a missing, invalid or unreproducible build and unresolved immutables are invalid (exit 11) with no request', async () => {
    expect(await run({}, { build: 'missing' })).toMatchObject({
      outcome: 'invalid',
      exitCode: 11,
      issues: ['ARTIFACT_MISSING'],
      methods: [],
    });
    expect(await run({}, { build: 'invalid' })).toMatchObject({
      outcome: 'invalid',
      issues: ['ARTIFACT_INVALID'],
      methods: [],
    });
    expect(await run({}, { record: { nonsense: true } })).toMatchObject({
      outcome: 'invalid',
      issues: ['RECORD_INVALID'],
      methods: [],
    });

    const drifted = await run(
      {},
      {
        record: {
          ...recordFixture(),
          build: { ...recordFixture().build, creationCodeKeccak256: keccak256('0x01') },
        },
      },
    );
    expect(drifted).toMatchObject({
      outcome: 'invalid',
      issues: ['BUILD_NOT_REPRODUCIBLE'],
      methods: [],
    });

    const settings = await run(
      {},
      {
        build: {
          ...buildFixture(),
          expectedSettings: { ...buildFixture().expectedSettings, optimizerRuns: 1 },
        },
      },
    );
    expect(settings).toMatchObject({
      outcome: 'invalid',
      issues: ['BUILD_SETTINGS_MISMATCH'],
      methods: [],
    });

    // An immutable with no resolution rule: incomplete, and the observed bytes are never consulted.
    const unresolved = await run(
      {},
      {
        build: {
          ...buildFixture(),
          immutableNames: new Map([['10', { contract: 'EIP712', name: '_new' }]]),
        },
      },
    );
    expect(unresolved).toMatchObject({
      outcome: 'invalid',
      exitCode: 11,
      issues: ['UNRESOLVED_IMMUTABLE'],
      methods: [],
      codeMatch: 'not_compared',
    });
    const unlinked = await run(
      {},
      {
        build: buildFixture(compiledFixture({ link: true })),
        record: recordFixture(deployedFixture(), compiledFixture({ link: true })),
      },
    );
    expect(unlinked).toMatchObject({
      outcome: 'invalid',
      issues: ['UNRESOLVED_LINK'],
      methods: [],
    });
  });

  it('reads the deployment transaction back: a wrong sender, target, status or block is inconsistent', async () => {
    const transaction = {
      from: `0x${'d2'.repeat(20)}`,
      to: null,
      input: compiledFixture().bytecode.object,
      nonce: '0x5',
      blockNumber: '0x64',
    };
    const wrongSender = await run({ transaction });
    expect(wrongSender).toMatchObject({
      outcome: 'mismatch',
      codeMatch: 'exact_match',
      deploymentTransaction: { status: 'inconsistent' },
    });
    expect(wrongSender.deploymentTransaction?.checks.addressFollowsFromSenderAndNonce).toBe(false);
    expect(wrongSender.issues).toEqual(['DEPLOYMENT_TX_INCONSISTENT']);

    const viaCall = await run({
      transaction: { ...transaction, from: `0x${'c1'.repeat(20)}`, to: `0x${'f0'.repeat(20)}` },
    });
    expect(viaCall.deploymentTransaction).toMatchObject({
      status: 'inconsistent',
      creation: 'not established',
    });

    const failed = await run({
      receipt: {
        status: '0x0',
        contractAddress: REGISTRY,
        blockNumber: '0x64',
        blockHash: `0x${(100n + 0xabcdn).toString(16).padStart(64, '0')}`,
      },
    });
    expect(failed.deploymentTransaction?.checks.executionSucceeded).toBe(false);

    const elsewhere = await run({
      receipt: {
        status: '0x1',
        contractAddress: REGISTRY,
        blockNumber: '0x65',
        blockHash: `0x${'aa'.repeat(32)}`,
      },
    });
    expect(elsewhere.deploymentTransaction?.checks).toMatchObject({
      blockNumberEqualsTheRecord: false,
      blockIsCanonicalAtTheCheckpoint: false,
    });

    // A transaction the endpoint does not have is "unavailable", not an invented value.
    const pruned = await run({ transaction: null });
    expect(pruned).toMatchObject({
      outcome: 'unavailable',
      exitCode: 12,
      codeMatch: 'exact_match',
    });
    expect(pruned.deploymentTransaction).toMatchObject({
      status: 'unavailable',
      sender: null,
      creation: 'not established',
    });
  });
});
