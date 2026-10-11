import { getContractAddress, keccak256, type Hex } from 'viem';
import { z } from 'zod';
import { RpcUnavailable, type RpcReader } from './rpc';
import {
  buildExpectedRuntime,
  compareRuntime,
  type Comparison,
  type Compiled,
  type DeploymentContext,
  type ImmutableName,
} from './runtime';

/*
 * The read-only deployment check: does the code at the recorded registry address, on the recorded
 * chain, at one canonical checkpoint, equal what the pinned source compiles to under the recorded
 * settings? Every trusted input (deployment record, build, network identity, endpoint) comes from
 * the caller. Nothing here reads a review package, loads a key, signs or sends.
 */

const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const decimal = z.string().regex(/^(0|[1-9]\d*)$/);

/** The deployed form of `lexaegis.registry-deployment.v1` (contracts/deployments/*.json). */
export const deployedRecordSchema = z.strictObject({
  schema: z.literal('lexaegis.registry-deployment.v1'),
  environment: z.enum(['local', 'testnet', 'mainnet']),
  network: z.string().min(1).max(60),
  contract: z.literal('ProofOfReviewRegistry'),
  build: z.strictObject({
    solc: z.string().regex(/^\d+\.\d+\.\d+\+commit\.[0-9a-f]{8}$/),
    evmVersion: z.string().regex(/^[a-z]+$/),
    creationCodeKeccak256: hex32,
  }),
  status: z.literal('deployed'),
  chainId: decimal,
  registryAddress: address,
  transactionHash: hex32,
  blockNumber: decimal,
  runtimeCodeKeccak256: hex32,
  genesisHash: hex32,
});
export type DeployedRecord = z.infer<typeof deployedRecordSchema>;

/** Monad executes a proposed block a few blocks later; reads use finalized minus this delay. */
export const EXECUTION_DELAY_BLOCKS = 3n;

export const ISSUE_CLASSES = { MISMATCH: 10, INVALID: 11, UNAVAILABLE: 12 } as const;
export const EXIT = { MATCH: 0, USAGE: 2, ...ISSUE_CLASSES } as const;

const ISSUES = {
  // The observed deployment is not the expected one.
  WRONG_CHAIN: 'MISMATCH',
  GENESIS_MISMATCH: 'MISMATCH',
  NO_RUNTIME_CODE: 'MISMATCH',
  EXECUTABLE_MISMATCH: 'MISMATCH',
  IMMUTABLE_MISMATCH: 'MISMATCH',
  LINK_MISMATCH: 'MISMATCH',
  METADATA_ONLY_MATCH_UNDER_EXACT_POLICY: 'MISMATCH',
  COMPILER_VERSION_IN_TRAILER_DIFFERS: 'MISMATCH',
  CODE_PIN_MISMATCH: 'MISMATCH',
  DEPLOYMENT_TX_INCONSISTENT: 'MISMATCH',
  // The trusted inputs cannot support a comparison.
  RECORD_INVALID: 'INVALID',
  RECORD_NOT_EXPECTED_NETWORK: 'INVALID',
  ARTIFACT_MISSING: 'INVALID',
  ARTIFACT_INVALID: 'INVALID',
  BUILD_NOT_REPRODUCIBLE: 'INVALID',
  BUILD_SETTINGS_MISMATCH: 'INVALID',
  UNRESOLVED_IMMUTABLE: 'INVALID',
  UNRESOLVED_LINK: 'INVALID',
  // The network gave no usable evidence.
  RPC_ENDPOINT_INVALID: 'UNAVAILABLE',
  RPC_UNAVAILABLE: 'UNAVAILABLE',
  RPC_MALFORMED: 'UNAVAILABLE',
  BUDGET_EXCEEDED: 'UNAVAILABLE',
  NO_FINALIZED_BLOCK: 'UNAVAILABLE',
  CHECKPOINT_BEFORE_DEPLOYMENT: 'UNAVAILABLE',
  CHECKPOINT_INCONSISTENT: 'UNAVAILABLE',
  DEPLOYMENT_TX_UNAVAILABLE: 'UNAVAILABLE',
} as const;
export type IssueCode = keyof typeof ISSUES;

export type Policy = 'exact' | 'metadata-insensitive';

export interface BuildInput {
  readonly compiled: Compiled;
  readonly immutableNames: ReadonlyMap<string, ImmutableName>;
  /** EIP-712 name and version, from the tracked build record generated from the pinned source. */
  readonly eip712: { readonly name: string; readonly version: string };
  /** Settings the deployment build must have used, from the tracked build record. */
  readonly expectedSettings: {
    readonly solc: string;
    readonly evmVersion: string;
    readonly optimizerEnabled: boolean;
    readonly optimizerRuns: number;
    readonly viaIR: boolean;
    readonly bytecodeHash: string;
  };
}

export interface DeploymentReport {
  readonly schema: 'lexaegis.deployment-verification.v1';
  readonly outcome: 'match' | 'mismatch' | 'invalid' | 'unavailable';
  readonly exitCode: number;
  readonly issues: IssueCode[];
  readonly policy: Policy;
  readonly record: {
    network: string;
    chainId: string;
    registryAddress: string;
    deploymentBlock: string;
  } | null;
  readonly endpoint: string | null;
  readonly methods: string[];
  readonly network: { chainId: string; genesisHash: string } | null;
  readonly checkpoint: {
    blockNumber: string;
    blockHash: string;
    finalizedBlock: string;
    rechecked: boolean;
  } | null;
  readonly build: {
    compiler: string;
    creationCodeKeccak256: string;
    reproducesRecordedCreationCode: boolean;
    metadataAppended: boolean;
    immutables: { label: string; value: string; occurrences: number }[];
    links: number;
  } | null;
  readonly comparison: Comparison | null;
  /** Result level, stated separately from the exit code. */
  readonly codeMatch: 'exact_match' | 'metadata_only_match' | 'mismatch' | 'not_compared';
  readonly codePin: { recorded: string; observed: string; equal: boolean } | null;
  readonly deploymentTransaction: {
    status: 'consistent' | 'inconsistent' | 'unavailable';
    sender: string | null;
    senderNonce: string | null;
    creation: 'CREATE by an externally owned transaction (to = null)' | 'not established';
    blockNumber: string | null;
    blockHash: string | null;
    /** The deployment block's own timestamp (UTC), as the endpoint reported it. */
    blockTimestamp: string | null;
    canonical: boolean | null;
    checks: Record<string, boolean>;
  } | null;
}

function finish(
  partial: Omit<DeploymentReport, 'schema' | 'outcome' | 'exitCode'>,
): DeploymentReport {
  const classes = new Set(partial.issues.map((issue) => ISSUES[issue]));
  // A definite mismatch outranks an input problem, which outranks missing evidence.
  const outcome = classes.has('MISMATCH')
    ? 'mismatch'
    : classes.has('INVALID')
      ? 'invalid'
      : classes.has('UNAVAILABLE')
        ? 'unavailable'
        : 'match';
  const exitCode =
    outcome === 'match'
      ? EXIT.MATCH
      : outcome === 'mismatch'
        ? EXIT.MISMATCH
        : outcome === 'invalid'
          ? EXIT.INVALID
          : EXIT.UNAVAILABLE;
  return { schema: 'lexaegis.deployment-verification.v1', outcome, exitCode, ...partial };
}

const blockSchema = z.looseObject({
  number: z.string().regex(/^0x[0-9a-f]+$/),
  hash: hex32,
  timestamp: z
    .string()
    .regex(/^0x[0-9a-f]+$/)
    .optional(),
});
const codeSchema = z.string().regex(/^0x(?:[0-9a-f]{2})*$/);
const transactionSchema = z.looseObject({
  from: address,
  to: address.nullable(),
  input: z.string().regex(/^0x(?:[0-9a-f]{2})*$/),
  nonce: z.string().regex(/^0x[0-9a-f]+$/),
  blockNumber: z
    .string()
    .regex(/^0x[0-9a-f]+$/)
    .nullable(),
});
const receiptSchema = z.looseObject({
  status: z.string().regex(/^0x[01]$/),
  contractAddress: address.nullable(),
  blockNumber: z.string().regex(/^0x[0-9a-f]+$/),
  blockHash: hex32,
});

const toBytes = (value: string): Uint8Array => {
  const out = new Uint8Array((value.length - 2) / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(value.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
};
const quantity = (value: bigint): string => `0x${value.toString(16)}`;

export async function verifyDeployment(input: {
  /** The raw deployment record, validated here. */
  readonly record: unknown;
  /** The chain this check is for. A record for any other chain is refused before any request. */
  readonly expectedChainId: string;
  /** Null when the reproducible build is missing or could not be read. */
  readonly build: BuildInput | 'missing' | 'invalid';
  readonly rpc: RpcReader;
  readonly policy: Policy;
  /** Library addresses by "<source file>:<library>" if the build links any. */
  readonly libraries?: Readonly<Record<string, Hex>>;
}): Promise<DeploymentReport> {
  const issues: IssueCode[] = [];
  const base = {
    policy: input.policy,
    record: null,
    endpoint: input.rpc.endpoint,
    methods: input.rpc.methods,
    network: null,
    checkpoint: null,
    build: null,
    comparison: null,
    codeMatch: 'not_compared' as const,
    codePin: null,
    deploymentTransaction: null,
  };

  const parsedRecord = deployedRecordSchema.safeParse(input.record);
  if (!parsedRecord.success) return finish({ ...base, issues: ['RECORD_INVALID'] });
  const record = parsedRecord.data;
  const recordView = {
    network: record.network,
    chainId: record.chainId,
    registryAddress: record.registryAddress,
    deploymentBlock: record.blockNumber,
  };
  if (record.chainId !== input.expectedChainId) {
    return finish({ ...base, record: recordView, issues: ['RECORD_NOT_EXPECTED_NETWORK'] });
  }
  if (input.build === 'missing' || input.build === 'invalid') {
    return finish({
      ...base,
      record: recordView,
      issues: [input.build === 'missing' ? 'ARTIFACT_MISSING' : 'ARTIFACT_INVALID'],
    });
  }
  const build = input.build;

  // ---- The reproducible build, before any request: provenance is separate from the byte comparison.
  const settings = build.compiled.metadata.settings;
  const compiler = build.compiled.metadata.compiler.version;
  const creationCodeKeccak256 = keccak256(build.compiled.bytecode.object as Hex);
  const reproduces = creationCodeKeccak256 === record.build.creationCodeKeccak256;
  if (!reproduces) issues.push('BUILD_NOT_REPRODUCIBLE');
  const expected = build.expectedSettings;
  if (
    compiler !== record.build.solc ||
    compiler !== expected.solc ||
    settings.evmVersion !== record.build.evmVersion ||
    settings.evmVersion !== expected.evmVersion ||
    (settings.optimizer.enabled ?? false) !== expected.optimizerEnabled ||
    (settings.optimizer.runs ?? 0) !== expected.optimizerRuns ||
    (settings.viaIR ?? false) !== expected.viaIR ||
    (settings.metadata?.bytecodeHash ?? 'ipfs') !== expected.bytecodeHash
  ) {
    issues.push('BUILD_SETTINGS_MISMATCH');
  }
  const metadataAppended = settings.metadata?.appendCBOR !== false;
  const context: DeploymentContext = {
    chainId: BigInt(record.chainId),
    address: record.registryAddress as Hex,
    eip712Name: build.eip712.name,
    eip712Version: build.eip712.version,
  };
  const runtime = buildExpectedRuntime({
    compiled: build.compiled,
    immutableNames: build.immutableNames,
    context,
    ...(input.libraries !== undefined && { libraries: input.libraries }),
  });
  const buildView = {
    compiler,
    creationCodeKeccak256,
    reproducesRecordedCreationCode: reproduces,
    metadataAppended,
    immutables: runtime.ok ? runtime.immutables : [],
    links: runtime.ok ? runtime.regions.filter((region) => region.kind === 'link').length : 0,
  };
  if (!runtime.ok) {
    issues.push(
      runtime.reason === 'UNRESOLVED_LINK' || runtime.reason === 'LINK_RANGE_INVALID'
        ? 'UNRESOLVED_LINK'
        : runtime.reason === 'ARTIFACT_BYTECODE_INVALID'
          ? 'ARTIFACT_INVALID'
          : 'UNRESOLVED_IMMUTABLE',
    );
    // Unresolved values mean the verification is incomplete. No observed byte is consulted.
    return finish({ ...base, record: recordView, build: buildView, issues });
  }
  if (issues.length > 0) return finish({ ...base, record: recordView, build: buildView, issues });

  // ---- Live, read-only.
  try {
    const call = async <T>(
      schema: z.ZodType<T>,
      method: Parameters<RpcReader['call']>[0],
      params: unknown[],
    ): Promise<T> => {
      const parsed = schema.safeParse(await input.rpc.call(method, params));
      if (!parsed.success) throw new RpcUnavailable('RPC_MALFORMED');
      return parsed.data;
    };

    const chainId = BigInt(await call(z.string().regex(/^0x[0-9a-f]+$/), 'eth_chainId', []));
    if (chainId.toString() !== record.chainId) {
      return finish({ ...base, record: recordView, build: buildView, issues: ['WRONG_CHAIN'] });
    }
    const genesis = await call(blockSchema, 'eth_getBlockByNumber', ['0x0', false]);
    const network = { chainId: chainId.toString(), genesisHash: genesis.hash };
    if (genesis.hash !== record.genesisHash) {
      return finish({
        ...base,
        record: recordView,
        build: buildView,
        network,
        issues: ['GENESIS_MISMATCH'],
      });
    }

    const finalized = await call(blockSchema.nullable(), 'eth_getBlockByNumber', [
      'finalized',
      false,
    ]);
    if (finalized === null) {
      return finish({
        ...base,
        record: recordView,
        build: buildView,
        network,
        issues: ['NO_FINALIZED_BLOCK'],
      });
    }
    const finalizedNumber = BigInt(finalized.number);
    const checkpointNumber = finalizedNumber - EXECUTION_DELAY_BLOCKS;
    if (checkpointNumber < BigInt(record.blockNumber)) {
      return finish({
        ...base,
        record: recordView,
        build: buildView,
        network,
        issues: ['CHECKPOINT_BEFORE_DEPLOYMENT'],
      });
    }
    const at = quantity(checkpointNumber);
    const block = await call(blockSchema.nullable(), 'eth_getBlockByNumber', [at, false]);
    if (block === null || BigInt(block.number) !== checkpointNumber)
      throw new RpcUnavailable('RPC_MALFORMED');
    const code = await call(codeSchema, 'eth_getCode', [record.registryAddress, at]);

    // ---- The deployment transaction, read back (not inferred).
    const transaction = await call(transactionSchema.nullable(), 'eth_getTransactionByHash', [
      record.transactionHash,
    ]);
    const receipt = await call(receiptSchema.nullable(), 'eth_getTransactionReceipt', [
      record.transactionHash,
    ]);
    let deploymentTransaction: DeploymentReport['deploymentTransaction'];
    if (transaction === null || receipt === null) {
      deploymentTransaction = {
        status: 'unavailable',
        sender: null,
        senderNonce: null,
        creation: 'not established',
        blockNumber: null,
        blockHash: null,
        blockTimestamp: null,
        canonical: null,
        checks: {},
      };
      issues.push('DEPLOYMENT_TX_UNAVAILABLE');
    } else {
      const deploymentBlock = await call(blockSchema.nullable(), 'eth_getBlockByNumber', [
        receipt.blockNumber,
        false,
      ]);
      const canonical = deploymentBlock !== null && deploymentBlock.hash === receipt.blockHash;
      const checks = {
        executionSucceeded: receipt.status === '0x1',
        isContractCreation: transaction.to === null,
        createdAddressIsTheRegistry: receipt.contractAddress === record.registryAddress,
        addressFollowsFromSenderAndNonce:
          getContractAddress({
            from: transaction.from as Hex,
            nonce: BigInt(transaction.nonce),
          }).toLowerCase() === record.registryAddress,
        blockNumberEqualsTheRecord: BigInt(receipt.blockNumber).toString() === record.blockNumber,
        blockIsCanonicalAtTheCheckpoint: canonical,
        inputIsTheRecordedCreationCode:
          keccak256(transaction.input as Hex) === record.build.creationCodeKeccak256,
      };
      const consistent = Object.values(checks).every(Boolean);
      deploymentTransaction = {
        status: consistent ? 'consistent' : 'inconsistent',
        sender: transaction.from,
        senderNonce: BigInt(transaction.nonce).toString(),
        creation: checks.isContractCreation
          ? 'CREATE by an externally owned transaction (to = null)'
          : 'not established',
        blockNumber: BigInt(receipt.blockNumber).toString(),
        blockHash: receipt.blockHash,
        blockTimestamp:
          deploymentBlock?.timestamp === undefined
            ? null
            : new Date(Number(BigInt(deploymentBlock.timestamp)) * 1000).toISOString(),
        canonical,
        checks,
      };
      if (!consistent) issues.push('DEPLOYMENT_TX_INCONSISTENT');
    }

    // ---- The checkpoint must still be the same block after every read.
    const again = await call(blockSchema.nullable(), 'eth_getBlockByNumber', [at, false]);
    const rechecked = again !== null && again.hash === block.hash;
    const checkpoint = {
      blockNumber: checkpointNumber.toString(),
      blockHash: block.hash,
      finalizedBlock: finalizedNumber.toString(),
      rechecked,
    };
    if (!rechecked) {
      return finish({
        ...base,
        record: recordView,
        build: buildView,
        network,
        checkpoint,
        deploymentTransaction,
        issues: [...issues, 'CHECKPOINT_INCONSISTENT'],
      });
    }
    const common = {
      ...base,
      record: recordView,
      build: buildView,
      network,
      checkpoint,
      deploymentTransaction,
    };
    if (code === '0x') return finish({ ...common, issues: [...issues, 'NO_RUNTIME_CODE'] });

    const observed = toBytes(code);
    const comparison = compareRuntime({
      observed,
      expected: runtime.code,
      regions: runtime.regions,
      metadataAppended,
    });
    if (comparison.status === 'mismatch') {
      const { differences } = comparison;
      if (differences.immutables.length > 0) issues.push('IMMUTABLE_MISMATCH');
      if (differences.links.length > 0) issues.push('LINK_MISMATCH');
      if (differences.executableBytes > 0 || differences.lengthDiffers)
        issues.push('EXECUTABLE_MISMATCH');
    }
    if (comparison.status === 'metadata_only_match') {
      // A normalised match is not exact source/metadata identity: it passes only when asked for.
      if (input.policy === 'exact') issues.push('METADATA_ONLY_MATCH_UNDER_EXACT_POLICY');
      const observedTrailer = comparison.trailer.observed;
      const release = /^(\d+\.\d+\.\d+)/.exec(compiler)?.[1] ?? compiler;
      if (
        typeof observedTrailer === 'object' &&
        observedTrailer.solcVersion !== null &&
        observedTrailer.solcVersion !== release
      ) {
        issues.push('COMPILER_VERSION_IN_TRAILER_DIFFERS');
      }
    }
    // The recorded code hash is a stronger pin than any normalised comparison and is kept as one.
    const observedHash = keccak256(code as Hex);
    const codePin = {
      recorded: record.runtimeCodeKeccak256,
      observed: observedHash,
      equal: observedHash === record.runtimeCodeKeccak256,
    };
    if (!codePin.equal) issues.push('CODE_PIN_MISMATCH');

    return finish({ ...common, comparison, codeMatch: comparison.status, codePin, issues });
  } catch (error) {
    const code = error instanceof RpcUnavailable ? error.code : 'RPC_UNAVAILABLE';
    return finish({ ...base, record: recordView, build: buildView, issues: [...issues, code] });
  }
}
