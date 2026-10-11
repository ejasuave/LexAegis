import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceDir = dirname(fileURLToPath(import.meta.url));
const production = readdirSync(sourceDir).filter(
  (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('test-helpers.ts'),
);
const importsOf = (text: string): string[] =>
  [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');

describe('CLI dependency boundaries', () => {
  it('has production sources', () => {
    expect(production.length).toBeGreaterThan(6);
  });

  it('imports only node built-ins, its own files and the SDK public entry points', () => {
    for (const name of production) {
      for (const specifier of importsOf(readFileSync(join(sourceDir, name), 'utf8'))) {
        const allowed =
          specifier.startsWith('node:') ||
          specifier.startsWith('./') ||
          /^@lexaegis\/sdk(\/(registry|verify|offline|portable|agent-identity))?$/.test(specifier);
        expect(allowed, `${name} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('never reads a key, mnemonic, signer or wallet, and uses no application, model or indexer code', () => {
    for (const name of production) {
      const text = readFileSync(join(sourceDir, name), 'utf8');
      for (const forbidden of [
        /privateKey/i,
        /mnemonic/i,
        /signTypedData/,
        /signTransaction/,
        /sendTransaction/,
        /eth_send/,
        /eth_sign/,
        /eth_accounts/,
        /\bQwen\b/i,
        /\bMera\b/,
        /\bEnvio\b/i,
        /lexaegis\/(web|agent|vault|verifier)/,
        /process\.env\b(?!\s*[,)])/,
      ]) {
        // The environment is only ever read through the injected `env` parameter.
        expect(forbidden.test(text), `${name} matches ${String(forbidden)}`).toBe(false);
      }
    }
  });

  it('does not use the registry action builders: the CLI is read-only', () => {
    for (const name of production) {
      const text = readFileSync(join(sourceDir, name), 'utf8');
      expect(
        /build(Issue|Revoke|Supersede)Action|buildTypedData|toEip712ReviewAction/.test(text),
      ).toBe(false);
    }
  });
});
