import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { keccak256, type Hex } from 'viem';
import { z } from 'zod';
import type { BuildInput } from './verify';
import { collectImmutableNames, compiledSchema } from './runtime';

/*
 * Rebuilds the registry from the pinned source with the project's own foundry.toml (compiler,
 * optimizer, EVM target, metadata settings, remappings, dependency tree), into a temporary output
 * directory. The tracked artifact and contracts/out are never written. `--ast` adds the syntax tree
 * so each immutable range can be named; it does not change the bytecode.
 */

const buildRecordSchema = z.looseObject({
  schema: z.literal('lexaegis.registry-build.v1'),
  bytecode: z.looseObject({ creationCodeKeccak256: z.string().regex(/^0x[0-9a-f]{64}$/) }),
  compiler: z.looseObject({
    solc: z.string(),
    evmVersion: z.string(),
    optimizer: z.looseObject({ enabled: z.boolean(), runs: z.number() }),
    viaIR: z.boolean(),
    bytecodeHash: z.string(),
  }),
  eip712: z.looseObject({ domain: z.strictObject({ name: z.string(), version: z.string() }) }),
});

export interface Rebuild {
  readonly build: BuildInput | 'missing' | 'invalid';
  readonly detail: string;
  /** SHA-256 over the Solidity sources and pinned build inputs that were compiled. */
  readonly sources: { sha256: string; files: number } | null;
  readonly forgeVersion: string | null;
}

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory).sort()) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** Only public Solidity sources and build settings: no environment file, key or broadcast log. */
export function sourceIdentity(contractsDir: string): { sha256: string; files: number } {
  const files = [
    ...walk(join(contractsDir, 'src')),
    join(contractsDir, 'foundry.toml'),
    join(contractsDir, 'toolchain.json'),
  ];
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(contractsDir, file));
    hash.update('\0');
    hash.update(createHash('sha256').update(readFileSync(file)).digest());
  }
  return { sha256: hash.digest('hex'), files: files.length };
}

export function rebuildRegistry(options: {
  readonly root: string;
  readonly forge: string;
}): Rebuild {
  const contractsDir = join(options.root, 'contracts');
  const recordPath = join(contractsDir, 'artifacts', 'registry-v1.json');
  if (!existsSync(options.forge))
    return {
      build: 'missing',
      detail: 'the pinned Foundry is not installed',
      sources: null,
      forgeVersion: null,
    };
  if (!existsSync(recordPath))
    return {
      build: 'missing',
      detail: 'the tracked build record is missing',
      sources: null,
      forgeVersion: null,
    };
  const record = buildRecordSchema.safeParse(JSON.parse(readFileSync(recordPath, 'utf8')));
  if (!record.success)
    return {
      build: 'invalid',
      detail: 'the tracked build record is not valid',
      sources: null,
      forgeVersion: null,
    };

  const sources = sourceIdentity(contractsDir);
  const versionText = spawnSync(options.forge, ['--version'], { encoding: 'utf8' }).stdout;
  const forgeVersion = /Version: (\S+)/.exec(versionText)?.[1] ?? null;
  const work = mkdtempSync(join(tmpdir(), 'lexaegis-rebuild-'));
  try {
    const result = spawnSync(
      options.forge,
      [
        'build',
        '--root',
        contractsDir,
        '--out',
        join(work, 'out'),
        '--cache-path',
        join(work, 'cache'),
        '--ast',
        '--force',
        '--skip',
        './test/**',
        '--skip',
        './script/**',
      ],
      { encoding: 'utf8', timeout: 5 * 60_000 },
    );
    const artifactPath = join(
      work,
      'out',
      'ProofOfReviewRegistry.sol',
      'ProofOfReviewRegistry.json',
    );
    if (result.status !== 0 || !existsSync(artifactPath)) {
      return {
        build: 'missing',
        detail: 'the registry could not be rebuilt from the pinned source',
        sources,
        forgeVersion,
      };
    }
    const compiled = compiledSchema.safeParse(JSON.parse(readFileSync(artifactPath, 'utf8')));
    if (!compiled.success)
      return {
        build: 'invalid',
        detail: 'the rebuilt artifact is not readable',
        sources,
        forgeVersion,
      };
    // The rebuild must be the build the tracked record describes, or it is not the deployment build.
    if (
      keccak256(compiled.data.bytecode.object as Hex) !== record.data.bytecode.creationCodeKeccak256
    ) {
      return {
        build: 'invalid',
        detail: 'the rebuild does not reproduce the tracked build record',
        sources,
        forgeVersion,
      };
    }
    const asts: unknown[] = [];
    for (const file of walk(join(work, 'out'))) {
      if (!file.endsWith('.json') || file.includes(join('out', 'build-info'))) continue;
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { ast?: unknown };
      if (parsed.ast !== undefined) asts.push(parsed.ast);
    }
    const { compiler, eip712 } = record.data;
    return {
      build: {
        compiled: compiled.data,
        immutableNames: collectImmutableNames(asts),
        eip712: eip712.domain,
        expectedSettings: {
          solc: compiler.solc,
          evmVersion: compiler.evmVersion,
          optimizerEnabled: compiler.optimizer.enabled,
          optimizerRuns: compiler.optimizer.runs,
          viaIR: compiler.viaIR,
          bytecodeHash: compiler.bytecodeHash,
        },
      },
      detail: 'rebuilt from the pinned source',
      sources,
      forgeVersion,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
