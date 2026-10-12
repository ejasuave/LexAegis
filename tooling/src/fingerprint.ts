import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'out',
  'cache',
  'broadcast',
  'coverage',
  '.git',
  '.tools',
  '.private',
  '.turbo',
  '.vite',
]);
const SKIP_FILES = new Set(['tsconfig.tsbuildinfo', 'next-env.d.ts']);

/** Directories and files whose content defines "the source and configuration" a result describes. */
export const FINGERPRINT_ROOTS = [
  'apps',
  'packages',
  'contracts',
  'fixtures',
  'tooling',
  'test-support',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'eslint.config.mjs',
  'tsconfig.base.json',
  'tsconfig.json',
  'vitest.config.mts',
] as const;

/** Generated or local-only output that must not change a fingerprint. */
function skipped(path: string): boolean {
  const parts = path.split(sep);
  return (
    parts.some((part) => SKIP_DIRS.has(part) || part.startsWith('.next-')) ||
    // A local environment file holds credentials: it must never feed a digest that reaches a report.
    (/^\.env(?:\..+)?$/.test(parts[parts.length - 1] ?? '') &&
      parts[parts.length - 1] !== '.env.example') ||
    SKIP_FILES.has(parts[parts.length - 1] ?? '') ||
    path.includes(join('contracts', 'deployments', 'local'))
  );
}

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const path = join(directory, entry.name);
    if (skipped(path)) continue;
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

/** SHA-256 over the sorted relative paths and content hashes of the source and configuration. */
export function sourceFingerprint(root: string): string {
  const hash = createHash('sha256');
  for (const name of FINGERPRINT_ROOTS) {
    const path = join(root, name);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    const files = stats.isDirectory() ? [...walk(path)] : [path];
    for (const file of files) {
      const content = createHash('sha256').update(readFileSync(file)).digest('hex');
      hash.update(`${relative(root, file).split(sep).join('/')}\0${content}\n`);
    }
  }
  return hash.digest('hex');
}
