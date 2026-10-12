import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SKIP = new Set([
  'node_modules',
  '.next',
  'dist',
  'out',
  'cache',
  'broadcast',
  '.git',
  '.tools',
  '.private',
  'coverage',
]);

/** Paths allowed to hold a synthetic secret, each with the reason. */
export const SECRET_ALLOWLIST: Readonly<Record<string, string>> = {
  'fixtures/registry-v1/vectors.json':
    'published synthetic test signing key, labelled as such in the file',
  'fixtures/registry-v1/generate.mjs': 'derives that synthetic key from a label',
  'docs/build-state.json': 'prose that names key types without holding one',
  'apps/web/src/config/public.test.ts':
    'deliberately credential-bearing URLs as invalid-input cases',
  'apps/web/src/server/env.test.ts': 'deliberately credential-bearing URLs as invalid-input cases',
  'packages/agent/src/server/qwen-client.test.ts':
    'deliberately credential-bearing URLs as invalid-input cases',
  'apps/web/src/server/readiness.test.ts':
    'deliberately credential-bearing URLs as invalid-input cases',
  'apps/verifier/src/controller.test.ts':
    'deliberately credential-bearing RPC URL as an invalid-input case',
  'packages/sdk/src/registry/rpc-client.test.ts':
    'deliberately credential-bearing RPC URLs as invalid-input cases',
  'tests/system/harness/harness.test.ts':
    'deliberately credential-bearing database URLs as invalid-input cases',
  'tooling/src/exclusion.test.ts': 'fake credentials the scanner must detect (negative controls)',
  'tooling/src/readiness.test.ts': 'fake credentials the redactor must remove',
  'tooling/src/validation.test.ts':
    'a deliberately credential-bearing URL the report sanitiser must flag (negative control)',
};

const PATTERNS: readonly { rule: string; pattern: RegExp }[] = [
  { rule: 'PRIVATE_KEY_BLOCK', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    rule: 'KEY_ASSIGNMENT',
    pattern:
      /(?:private[_-]?key|secret|api[_-]?key|access[_-]?token|password)["']?\s*[:=]\s*["']?(?:0x)?[0-9a-fA-F]{32,}/i,
  },
  { rule: 'URL_CREDENTIALS', pattern: /:\/\/[^\s/@:]+:[^\s/@]+@(?!127\.0\.0\.1|localhost)/ },
  { rule: 'PROVIDER_KEY_URL', pattern: /https:\/\/[a-z0-9.-]+\/v\d\/[A-Za-z0-9_-]{24,}/ },
  { rule: 'API_KEY_LITERAL', pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
];

export interface SecretFinding {
  readonly file: string;
  readonly rule: string;
}

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // Build output, including the per-check Next.js directories (.next-vault-check and so on).
    if (SKIP.has(entry.name) || /^\.next-[a-z-]+$/.test(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

/** Finds likely credentials in the named files (paths relative to `root`). Values are never returned. */
export function scanSecretFiles(
  root: string,
  names: readonly string[],
  allowlist: Readonly<Record<string, string>> = SECRET_ALLOWLIST,
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const name of names) {
    if (name === 'pnpm-lock.yaml' || name in allowlist) continue;
    const file = join(root, name);
    if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size > 2 * 1024 * 1024)
      continue;
    const text = readFileSync(file, 'utf8');
    for (const { rule, pattern } of PATTERNS)
      if (pattern.test(text)) findings.push({ file: name, rule });
  }
  return findings;
}

/** Files git would commit: tracked, plus untracked and not ignored. Null when `root` is not a work tree. */
function committableFiles(root: string): string[] | null {
  try {
    const listed = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    // A directory that is not itself a repository root must not borrow an enclosing one.
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (relative(top, root) !== '') return null;
    return listed.split('\0').filter((name) => name !== '');
  } catch {
    return null;
  }
}

/**
 * Finds likely credentials in source and configuration. Values are never returned. In a git work tree
 * only what could be COMMITTED is scanned: a git-ignored local `.env` is by design where credentials
 * live, and git (not this scanner) keeps it out of the repository. Elsewhere every file is scanned.
 */
export function scanSecrets(
  root: string,
  allowlist: Readonly<Record<string, string>> = SECRET_ALLOWLIST,
): SecretFinding[] {
  const names =
    committableFiles(root) ??
    [...walk(root)].map((file) => relative(root, file).split(sep).join('/'));
  return scanSecretFiles(root, names, allowlist);
}
