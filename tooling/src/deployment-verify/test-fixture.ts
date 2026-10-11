/** UNIT-TEST FIXTURE ONLY. A tiny synthetic "compiled contract" and a scripted JSON-RPC answerer. */
import { getContractAddress, keccak256, type Hex } from 'viem';
import type { ReadMethod, RpcReader } from './rpc';
import { compiledSchema, type Compiled, type ImmutableName } from './runtime';
import type { BuildInput } from './verify';

export const SOLC_TRAILER = 'a164736f6c6343000825000a';
export const EXEC = { head: '600160025500', middle: '6003', tail: 'fe' };
const ZERO32 = '00'.repeat(32);

/** head (6 bytes) | immutable A (32) | middle (2) | immutable B (32) | tail (1) | trailer. */
export function compiledFixture(
  over: { trailer?: string; appendCBOR?: boolean; link?: boolean } = {},
): Compiled {
  const link = over.link === true ? '00'.repeat(20) : '';
  return compiledSchema.parse({
    bytecode: { object: '0x6080604052600080fd' },
    deployedBytecode: {
      object: `0x${EXEC.head}${ZERO32}${EXEC.middle}${ZERO32}${EXEC.tail}${link}${over.trailer ?? SOLC_TRAILER}`,
      immutableReferences: { '10': [{ start: 6, length: 32 }], '11': [{ start: 40, length: 32 }] },
      linkReferences:
        over.link === true ? { 'src/Lib.sol': { Lib: [{ start: 73, length: 20 }] } } : {},
    },
    metadata: {
      compiler: { version: '0.8.37+commit.f401782d' },
      settings: {
        optimizer: { enabled: true, runs: 200 },
        evmVersion: 'osaka',
        metadata: { bytecodeHash: 'none', ...(over.appendCBOR === false && { appendCBOR: false }) },
        libraries: {},
      },
    },
  });
}

export const NAMES: ReadonlyMap<string, ImmutableName> = new Map([
  ['10', { contract: 'EIP712', name: '_cachedChainId' }],
  ['11', { contract: 'EIP712', name: '_cachedThis' }],
]);

export const DEPLOYER: Hex = `0x${'c1'.repeat(20)}`;
export const DEPLOYER_NONCE = 5n;
export const REGISTRY = getContractAddress({
  from: DEPLOYER,
  nonce: DEPLOYER_NONCE,
}).toLowerCase() as Hex;
export const CHAIN_ID = 10143n;
export const GENESIS = `0x${'29'.repeat(32)}`;
export const TX_HASH = `0x${'e6'.repeat(32)}`;
export const DEPLOYMENT_BLOCK = 100n;

export function buildFixture(compiled: Compiled = compiledFixture()): BuildInput {
  return {
    compiled,
    immutableNames: NAMES,
    eip712: { name: 'LexAegisProofOfReview', version: '1' },
    expectedSettings: {
      solc: '0.8.37+commit.f401782d',
      evmVersion: 'osaka',
      optimizerEnabled: true,
      optimizerRuns: 200,
      viaIR: false,
      bytecodeHash: 'none',
    },
  };
}

const word = (value: bigint) => value.toString(16).padStart(64, '0');
/** The runtime a correct deployment of the fixture has, with both immutables filled in. */
export function deployedFixture(over: { trailer?: string; link?: string } = {}): Hex {
  return `0x${EXEC.head}${word(CHAIN_ID)}${EXEC.middle}${word(BigInt(REGISTRY))}${EXEC.tail}${over.link ?? ''}${over.trailer ?? SOLC_TRAILER}`;
}

export function recordFixture(
  code: Hex = deployedFixture(),
  compiled: Compiled = compiledFixture(),
) {
  return {
    schema: 'lexaegis.registry-deployment.v1',
    environment: 'testnet',
    network: 'monad-testnet',
    contract: 'ProofOfReviewRegistry',
    build: {
      solc: '0.8.37+commit.f401782d',
      evmVersion: 'osaka',
      creationCodeKeccak256: keccak256(compiled.bytecode.object as Hex),
    },
    status: 'deployed',
    chainId: CHAIN_ID.toString(),
    registryAddress: REGISTRY,
    transactionHash: TX_HASH,
    blockNumber: DEPLOYMENT_BLOCK.toString(),
    runtimeCodeKeccak256: keccak256(code),
    genesisHash: GENESIS,
  };
}

export interface NodeScript {
  chainId?: bigint;
  genesis?: string;
  finalized?: bigint | null;
  code?: string;
  /** Returns the hash of a block; `reads` counts how often that number was asked for. */
  blockHash?: (number: bigint, reads: number) => string;
  transaction?: Record<string, unknown> | null;
  receipt?: Record<string, unknown> | null;
  fail?: (method: ReadMethod, callIndex: number) => Error | null;
  creationInput?: Hex;
}

/** SCRIPTED answers, not a chain. Records every method it was asked for. */
export function scriptedNode(script: NodeScript = {}): RpcReader {
  const methods: ReadMethod[] = [];
  const reads = new Map<string, number>();
  const hashOf = (number: bigint) => {
    const count = (reads.get(number.toString()) ?? 0) + 1;
    reads.set(number.toString(), count);
    return script.blockHash?.(number, count) ?? `0x${word(number + 0xabcdn)}`;
  };
  const finalized = script.finalized === undefined ? 1000n : script.finalized;
  return {
    endpoint: 'https://rpc.example.invalid',
    methods,
    call(method, params) {
      const index = methods.length;
      methods.push(method);
      const failure = script.fail?.(method, index) ?? null;
      if (failure !== null) return Promise.reject(failure);
      switch (method) {
        case 'eth_chainId':
          return Promise.resolve(`0x${(script.chainId ?? CHAIN_ID).toString(16)}`);
        case 'eth_getBlockByNumber': {
          const tag = params[0] as string;
          if (tag === '0x0')
            return Promise.resolve({ number: '0x0', hash: script.genesis ?? GENESIS });
          if (tag === 'finalized') {
            return Promise.resolve(
              finalized === null
                ? null
                : { number: `0x${finalized.toString(16)}`, hash: `0x${word(finalized)}` },
            );
          }
          return Promise.resolve({
            number: tag,
            hash: hashOf(BigInt(tag)),
            timestamp: '0x6ac82e80',
          });
        }
        case 'eth_getCode':
          return Promise.resolve(script.code ?? deployedFixture());
        case 'eth_getTransactionByHash':
          return Promise.resolve(
            script.transaction === undefined
              ? {
                  from: DEPLOYER,
                  to: null,
                  input: script.creationInput ?? compiledFixture().bytecode.object,
                  nonce: `0x${DEPLOYER_NONCE.toString(16)}`,
                  blockNumber: `0x${DEPLOYMENT_BLOCK.toString(16)}`,
                }
              : script.transaction,
          );
        case 'eth_getTransactionReceipt':
          return Promise.resolve(
            script.receipt === undefined
              ? {
                  status: '0x1',
                  contractAddress: REGISTRY,
                  blockNumber: `0x${DEPLOYMENT_BLOCK.toString(16)}`,
                  blockHash: `0x${word(DEPLOYMENT_BLOCK + 0xabcdn)}`,
                }
              : script.receipt,
          );
      }
    },
  };
}
