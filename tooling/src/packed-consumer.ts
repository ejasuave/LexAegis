import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Packs workspace packages into real tarballs and installs them into a clean, separate consumer
 * directory. The consumer has its own node_modules, no workspace links, no TypeScript path aliases
 * and no repository source: an undeclared dependency or a missing file fails to resolve. Third-party
 * packages come from the repository's offline pnpm store. Nothing is published. Imports no
 * workspace package: it only runs pnpm, tar and node.
 */

export const PACKABLE = ['protocol', 'sdk', 'cli'] as const;
export type PackableName = (typeof PACKABLE)[number];

export interface PackedPackage {
  readonly name: PackableName;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Every path in the tarball, `package/`-prefixed. */
  readonly entries: readonly string[];
}

export function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return execFileSync(command, [...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export const tarballName = (name: PackableName): string => `lexaegis-${name}-0.1.0.tgz`;

export function listTarball(root: string, file: string): string[] {
  return run('tar', ['-tzf', file], root)
    .split('\n')
    .filter((line) => line !== '');
}

/** Builds (unless `build` is false) and packs the named packages into `destination`. */
export function packPackages(
  root: string,
  destination: string,
  names: readonly PackableName[] = PACKABLE,
  build = true,
): Record<PackableName, PackedPackage | undefined> {
  if (build) run('pnpm', ['packages:build'], root);
  const packed: Partial<Record<PackableName, PackedPackage>> = {};
  for (const name of names) {
    run('pnpm', ['pack', '--pack-destination', destination], join(root, 'packages', name));
    const file = join(destination, tarballName(name));
    packed[name] = {
      name,
      file,
      bytes: statSync(file).size,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      entries: listTarball(root, file),
    };
  }
  return packed as Record<PackableName, PackedPackage | undefined>;
}

/**
 * Installs the packed tarballs into `consumer`. The transitive dependencies between the packages
 * resolve to the packed tarballs too (an override), never to a registry and never to this repository.
 */
export function installConsumer(
  root: string,
  consumer: string,
  packed: Partial<Record<PackableName, PackedPackage>>,
): void {
  const files = Object.values(packed).map((item) => item.file);
  if (files.length === 0) throw new Error('nothing to install');
  const dependencies = {
    ...Object.fromEntries(
      Object.values(packed).map((item) => [`@lexaegis/${item.name}`, `file:${item.file}`]),
    ),
    // The wallet library a caller brings: the lifecycle example is written against viem clients.
    viem: '2.57.3',
  };
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify(
      { name: 'clean-consumer', private: true, type: 'module', dependencies },
      null,
      2,
    ),
  );
  const overrides = Object.values(packed)
    .filter((item) => item.name !== 'cli')
    .map((item) => `  '@lexaegis/${item.name}': file:${item.file}`)
    .join('\n');
  writeFileSync(join(consumer, 'pnpm-workspace.yaml'), `overrides:\n${overrides}\n`);
  const store = run('pnpm', ['store', 'path'], root).trim();
  run('pnpm', ['install', '--offline', '--no-frozen-lockfile', '--store-dir', store], consumer);
}

/** The installed `proof-of-review` executable inside a consumer. */
export const consumerBinary = (consumer: string): string =>
  join(consumer, 'node_modules', '.bin', 'proof-of-review');
