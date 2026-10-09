/**
 * Writes (or with --check, verifies) everything derived from the compiled registry:
 *
 *   packages/sdk/src/registry/generated/registry-abi.ts   typed ABI consumed by the SDK
 *   contracts/artifacts/registry-v1.json                  EIP-712, selector and build metadata
 *   contracts/deployments/template.json                   not-yet-deployed record for Chapter 6
 *
 * The contract is recompiled from scratch first, so the output always describes the current
 * sources. Nothing is taken from the SDK: the ABI is the compiler's, and the EIP-712 strings
 * are checked against the independent literals in fixtures/registry-v1/vectors.json.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { keccak256, toBytes } from 'viem';
import { z } from 'zod';
import {
  contractsDir,
  readJsonFile,
  readToolchain,
  repoRoot,
  resolveFoundryTool,
} from './lib/toolchain';

const CONTRACT = 'ProofOfReviewRegistry';
const SOURCE = `src/${CONTRACT}.sol`;

// ---- Compiler output ---------------------------------------------------------------------------

interface AbiParameter {
  name: string;
  type: string;
  internalType?: string | undefined;
  indexed?: boolean | undefined;
  components?: AbiParameter[] | undefined;
}

const abiParameterSchema: z.ZodType<AbiParameter> = z.lazy(() =>
  z.strictObject({
    name: z.string(),
    type: z.string().min(1),
    internalType: z.string().optional(),
    indexed: z.boolean().optional(),
    components: z.array(abiParameterSchema).optional(),
  }),
);

const abiItemSchema = z.strictObject({
  type: z.enum(['function', 'event', 'error']),
  name: z.string().min(1),
  inputs: z.array(abiParameterSchema),
  outputs: z.array(abiParameterSchema).optional(),
  stateMutability: z.enum(['pure', 'view', 'nonpayable']).optional(),
  anonymous: z.literal(false).optional(),
});
type AbiItem = z.infer<typeof abiItemSchema>;

const bytecodeSchema = z.string().regex(/^0x(?:[0-9a-f]{2})+$/);
const noLinkReferences = z.strictObject({});

/** The Foundry artifact. No payable entry point, constructor argument or linked library is allowed. */
const artifactSchema = z.strictObject({
  abi: z.array(abiItemSchema),
  bytecode: z.strictObject({
    object: bytecodeSchema,
    sourceMap: z.string(),
    linkReferences: noLinkReferences,
  }),
  deployedBytecode: z.strictObject({
    object: bytecodeSchema,
    sourceMap: z.string(),
    linkReferences: noLinkReferences,
    immutableReferences: z.record(z.string(), z.unknown()),
  }),
  methodIdentifiers: z.record(z.string(), z.string().regex(/^[0-9a-f]{8}$/)),
  rawMetadata: z.string(),
  metadata: z.strictObject({
    compiler: z.strictObject({ version: z.string().regex(/^\d+\.\d+\.\d+\+commit\.[0-9a-f]{8}$/) }),
    language: z.literal('Solidity'),
    output: z.unknown(),
    settings: z.strictObject({
      remappings: z.array(z.string()),
      optimizer: z.strictObject({ enabled: z.boolean(), runs: z.int().min(0) }),
      metadata: z.strictObject({ useLiteralContent: z.boolean(), bytecodeHash: z.string() }),
      compilationTarget: z.record(z.string(), z.string()),
      evmVersion: z.string(),
      libraries: z.strictObject({}),
      viaIR: z.boolean().optional(),
    }),
    sources: z.record(z.string(), z.unknown()),
    version: z.literal(1),
  }),
  id: z.int(),
});

const packageVersionSchema = z.looseObject({ version: z.string() });

const vectorsSchema = z.looseObject({
  eip712: z.strictObject({
    domain: z.strictObject({ name: z.string(), version: z.string() }),
    domainTypeString: z.string(),
    domainTypeHash: z.string(),
    primaryType: z.string(),
    typeString: z.string(),
    typeHash: z.string(),
  }),
  actionCodes: z.strictObject({
    ISSUE: z.literal(0),
    REVOKE: z.literal(1),
    SUPERSEDE: z.literal(2),
  }),
});

// ---- Derivation --------------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(`generate-artifacts: ${message}`);
}

function canonicalType(parameter: AbiParameter): string {
  if (!parameter.type.startsWith('tuple')) return parameter.type;
  const members = (parameter.components ?? []).map(canonicalType).join(',');
  return `(${members})${parameter.type.slice('tuple'.length)}`;
}

function signature(item: AbiItem): string {
  return `${item.name}(${item.inputs.map(canonicalType).join(',')})`;
}

function selectors(abi: readonly AbiItem[], type: AbiItem['type'], bytes: 4 | 32) {
  const entries = abi
    .filter((item) => item.type === type)
    .map((item): [string, string] => {
      const text = signature(item);
      return [text, keccak256(toBytes(text)).slice(0, 2 + bytes * 2)];
    });
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** `ReviewAction(address reviewer,...)`, read from the struct the compiler put in the ABI. */
function reviewActionType(abi: readonly AbiItem[]) {
  const [parameter] = abi.find((item) => item.name === 'hashAction')?.inputs ?? [];
  const components = parameter?.components;
  if (parameter?.type !== 'tuple' || components === undefined)
    fail('hashAction has no struct input');
  if (parameter.internalType !== 'struct IProofOfReviewRegistry.ReviewAction') {
    fail('hashAction does not take IProofOfReviewRegistry.ReviewAction');
  }
  const fields = components.map(({ name, type }) => ({ name, type }));
  const typeString = `ReviewAction(${fields.map(({ name, type }) => `${type} ${name}`).join(',')})`;
  return { fields, typeString };
}

function installedVersion(packageName: string): string {
  const path = join(contractsDir, 'node_modules', packageName, 'package.json');
  return packageVersionSchema.parse(readJsonFile(path)).version;
}

function build() {
  const toolchain = readToolchain();
  execFileSync(resolveFoundryTool('forge'), ['build', '--force'], {
    cwd: contractsDir,
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const artifact = artifactSchema.parse(
    readJsonFile(join(contractsDir, 'out', `${CONTRACT}.sol`, `${CONTRACT}.json`)),
  );
  const { abi, metadata } = artifact;
  const { settings } = metadata;

  // Pins: the build must be exactly what toolchain.json promises.
  if (!metadata.compiler.version.startsWith(`${toolchain.solc}+`)) fail('unexpected solc version');
  if (settings.evmVersion !== toolchain.evmVersion) fail('unexpected EVM version');
  if (settings.compilationTarget[SOURCE] !== CONTRACT) fail('unexpected compilation target');
  if (installedVersion('@openzeppelin/contracts') !== toolchain.openzeppelinContracts) {
    fail('installed OpenZeppelin Contracts differs from toolchain.json');
  }
  if (installedVersion('forge-std') !== toolchain.forgeStd.version) {
    fail('installed forge-std differs from toolchain.json');
  }

  // Surface: only these two functions may change state, and nothing accepts value.
  const mutating = abi
    .filter((item) => item.type === 'function' && item.stateMutability === 'nonpayable')
    .map((item) => item.name)
    .sort();
  if (mutating.join(',') !== 'execute,invalidateNonce') fail('unexpected state-changing surface');

  // EIP-712: the compiled struct must spell the independent specification literal.
  const vectors = vectorsSchema.parse(
    readJsonFile(join(repoRoot, 'fixtures', 'registry-v1', 'vectors.json')),
  );
  const { fields, typeString } = reviewActionType(abi);
  if (typeString !== vectors.eip712.typeString)
    fail('compiled ReviewAction differs from the vectors');
  const typeHash = keccak256(toBytes(typeString));
  if (typeHash !== vectors.eip712.typeHash) fail('type hash differs from the vectors');
  if (!artifact.deployedBytecode.object.includes(typeHash.slice(2))) {
    fail('runtime code does not contain the ReviewAction type hash');
  }

  const descriptor = {
    schema: 'lexaegis.registry-build.v1',
    contract: CONTRACT,
    source: SOURCE,
    protocolVersion: '1',
    eip712: {
      domain: vectors.eip712.domain,
      domainTypeString: vectors.eip712.domainTypeString,
      primaryType: 'ReviewAction',
      typeString,
      typeHash,
      fields,
    },
    actionCodes: vectors.actionCodes,
    receiptStatus: ['NotFound', 'Active', 'Revoked', 'Superseded'],
    supersessionEventOrder: ['ReceiptIssued', 'ReceiptSuperseded'],
    selectors: {
      functions: selectors(abi, 'function', 4),
      events: selectors(abi, 'event', 32),
      errors: selectors(abi, 'error', 4),
    },
    compiler: {
      solc: metadata.compiler.version,
      evmVersion: settings.evmVersion,
      optimizer: settings.optimizer,
      viaIR: settings.viaIR ?? false,
      bytecodeHash: settings.metadata.bytecodeHash,
    },
    dependencies: {
      foundry: toolchain.foundry.version,
      foundryCommit: toolchain.foundry.commit,
      openzeppelinContracts: toolchain.openzeppelinContracts,
      forgeStd: toolchain.forgeStd.version,
      forgeStdCommit: toolchain.forgeStd.commit,
    },
    bytecode: {
      // The constructor takes no arguments, so this is the exact deployment transaction input.
      creationCodeKeccak256: keccak256(artifact.bytecode.object as `0x${string}`),
      creationCodeBytes: (artifact.bytecode.object.length - 2) / 2,
      // Runtime code embeds chain- and address-specific immutables, so its hash is only ever
      // an observation of a real deployment and is not predicted here.
      runtimeCodeBytes: (artifact.deployedBytecode.object.length - 2) / 2,
    },
  };

  const template = {
    schema: 'lexaegis.registry-deployment.v1',
    status: 'not_deployed',
    environment: 'testnet',
    network: 'monad-testnet',
    intendedChainId: '10143',
    contract: CONTRACT,
    build: {
      solc: descriptor.compiler.solc,
      evmVersion: descriptor.compiler.evmVersion,
      creationCodeKeccak256: descriptor.bytecode.creationCodeKeccak256,
    },
  };

  const abiSource = [
    '// GENERATED by contracts/scripts/generate-artifacts.ts from the compiled',
    `// ${CONTRACT} artifact. Do not edit: run "pnpm contracts:artifacts".`,
    '',
    `export const proofOfReviewRegistryAbi = ${JSON.stringify(abi)} as const;`,
    '',
  ].join('\n');

  return [
    {
      path: join(repoRoot, 'packages', 'sdk', 'src', 'registry', 'generated', 'registry-abi.ts'),
      content: abiSource,
    },
    {
      path: join(contractsDir, 'artifacts', 'registry-v1.json'),
      content: JSON.stringify(descriptor),
    },
    { path: join(contractsDir, 'deployments', 'template.json'), content: JSON.stringify(template) },
  ];
}

// ---- Write or check ----------------------------------------------------------------------------

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

const check = process.argv.includes('--check');
let stale = 0;

for (const { path, content } of build()) {
  // Formatted with the repository's Prettier configuration so `pnpm format:check` accepts it.
  const expected = await format(content, { ...(await resolveConfig(path)), filepath: path });
  const label = relative(repoRoot, path);
  if (!check) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, expected);
    console.log(`wrote ${label}`);
  } else if (readOrNull(path) !== expected) {
    stale += 1;
    console.error(`STALE ${label}: run "pnpm contracts:artifacts"`);
  }
}

if (check) {
  if (stale > 0) process.exit(1);
  console.log('generated registry artifacts are up to date');
}
