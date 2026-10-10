import { readFileSync, readdirSync, statSync } from 'node:fs';
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
  'tooling/src/exclusion.test.ts': 'fake credentials the scanner must detect (negative controls)',
  'tooling/src/readiness.test.ts': 'fake credentials the redactor must remove',
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

/** Finds likely credentials in source and configuration. Values are never returned. */
export function scanSecrets(
  root: string,
  allowlist: Readonly<Record<string, string>> = SECRET_ALLOWLIST,
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of walk(root)) {
    const name = relative(root, file).split(sep).join('/');
    if (name === 'pnpm-lock.yaml' || name in allowlist) continue;
    if (statSync(file).size > 2 * 1024 * 1024) continue;
    const text = readFileSync(file, 'utf8');
    for (const { rule, pattern } of PATTERNS)
      if (pattern.test(text)) findings.push({ file: name, rule });
  }
  return findings;
}
