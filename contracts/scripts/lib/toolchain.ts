/**
 * Pinned contract toolchain. Every Foundry invocation in this repository resolves its binary
 * here, so a different installed version is a hard failure instead of a silent behaviour change.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const contractsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const repoRoot = join(contractsDir, '..');

const semver = z.string().regex(/^\d+\.\d+\.\d+$/);
const gitCommit = z.string().regex(/^[0-9a-f]{40}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const toolchainSchema = z.strictObject({
  foundry: z.strictObject({
    version: semver,
    commit: gitCommit,
    archiveSha256: z.strictObject({
      linux_amd64: sha256,
      linux_arm64: sha256,
      darwin_amd64: sha256,
      darwin_arm64: sha256,
    }),
  }),
  solc: semver,
  evmVersion: z.string().regex(/^[a-z]+$/),
  openzeppelinContracts: semver,
  forgeStd: z.strictObject({ version: semver, commit: gitCommit }),
});
export type Toolchain = z.infer<typeof toolchainSchema>;
export type FoundryPlatform = keyof Toolchain['foundry']['archiveSha256'];

export function readJsonFile(path: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parsed;
}

export function readToolchain(): Toolchain {
  return toolchainSchema.parse(readJsonFile(join(contractsDir, 'toolchain.json')));
}

export const FOUNDRY_TOOLS = ['forge', 'anvil', 'cast'] as const;
export type FoundryTool = (typeof FOUNDRY_TOOLS)[number];

export function isFoundryTool(value: unknown): value is FoundryTool {
  return FOUNDRY_TOOLS.some((tool) => tool === value);
}

/** Repository-local, git-ignored install location used by `pnpm contracts:toolchain`. */
export function localToolchainDir(version: string): string {
  return join(repoRoot, '.tools', 'foundry', `v${version}`);
}

export interface FoundryBuild {
  readonly version: string;
  readonly commit: string;
}

/** Reads `Version:` and `Commit SHA:` from a Foundry binary, or null when it cannot be run. */
export function reportedBuild(binary: string): FoundryBuild | null {
  try {
    const output = execFileSync(binary, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const version = /Version: (\d+\.\d+\.\d+)/.exec(output)?.[1];
    const commit = /Commit SHA: ([0-9a-f]{40})/.exec(output)?.[1];
    return version === undefined || commit === undefined ? null : { version, commit };
  } catch {
    return null;
  }
}

export class ToolchainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolchainError';
  }
}

/**
 * Returns the path of a Foundry binary whose reported version and commit equal the pin.
 * Search order: FOUNDRY_BIN_DIR, the repository-local install, PATH, then ~/.foundry/bin.
 */
export function resolveFoundryTool(tool: FoundryTool): string {
  const { version, commit } = readToolchain().foundry;
  const directories = [
    process.env.FOUNDRY_BIN_DIR,
    localToolchainDir(version),
    ...(process.env.PATH ?? '').split(delimiter),
    join(homedir(), '.foundry', 'bin'),
  ].filter((directory): directory is string => directory !== undefined && directory !== '');

  const rejected: string[] = [];
  for (const directory of directories) {
    const candidate = join(directory, tool);
    if (!existsSync(candidate)) continue;
    const build = reportedBuild(candidate);
    if (build?.version === version && build.commit === commit) return candidate;
    rejected.push(`${candidate} (${build === null ? 'not runnable' : build.version})`);
  }
  const seen = rejected.length === 0 ? 'none found' : `found ${rejected.join(', ')}`;
  throw new ToolchainError(
    `${tool} ${version} (${commit.slice(0, 7)}) is required; ${seen}. Run "pnpm contracts:toolchain".`,
  );
}
