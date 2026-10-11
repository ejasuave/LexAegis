import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packagesDir = fileURLToPath(new URL('../../', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [path] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'test-helpers.ts'
      ? [path]
      : [];
  });
}

const productionFiles = (pkg: 'protocol' | 'sdk') =>
  sources(join(packagesDir, pkg, 'src')).flatMap((path) =>
    statSync(path).isDirectory() ? sources(path) : [path],
  );

const importsOf = (text: string): string[] =>
  [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');

const FORBIDDEN_IMPORT =
  /^(?:node:|next(?:\/|$)|react|server-only|@lexaegis\/(?:web|verifier|agent|vault)|@category-labs\/|@scure\/|ws$|undici)/;

/** Globals whose use would be an ambient side effect: environment, storage, wallet or timers. */
const AMBIENT = [
  /\bprocess\.env\b/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /\bdocument\.cookie\b/,
  /\bwindow\.ethereum\b/,
  /\bnavigator\.credentials\b/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bBroadcastChannel\b/,
];

/** The only production file allowed to call the network: the explicit JSON-RPC transport. */
const NETWORK_FILES = new Set(['registry/rpc-client.ts']);

describe('protocol and sdk dependency boundaries', () => {
  for (const pkg of ['protocol', 'sdk'] as const) {
    const files = productionFiles(pkg);

    it(`${pkg}: has production sources to check`, () => {
      expect(files.length).toBeGreaterThan(5);
    });

    it(`${pkg}: imports no framework, Node built-in, hosted-backend, account or model module`, () => {
      for (const file of files) {
        for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
          expect(
            FORBIDDEN_IMPORT.test(specifier),
            `${relative(packagesDir, file)} imports ${specifier}`,
          ).toBe(false);
        }
      }
    });

    it(`${pkg}: reads no environment, storage, cookie or wallet at import time`, () => {
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const pattern of AMBIENT) {
          expect(pattern.test(text), `${relative(packagesDir, file)} matches ${pattern}`).toBe(
            false,
          );
        }
      }
    });

    it(`${pkg}: calls fetch only from the explicit RPC transport`, () => {
      for (const file of files) {
        const name = relative(join(packagesDir, pkg, 'src'), file).replaceAll('\\', '/');
        const uses = /(?<![.\w])fetch\s*\(/.test(readFileSync(file, 'utf8'));
        if (uses) expect(NETWORK_FILES.has(name), `${pkg}/${name} calls fetch`).toBe(true);
      }
    });

    it(`${pkg}: reaches no monorepo-only path`, () => {
      for (const file of files) {
        for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
          expect(
            /(?:^|\/)(?:apps|contracts|tooling|fixtures|test-support)\/|\/packages\//.test(
              specifier,
            ),
            `${relative(packagesDir, file)} imports ${specifier}`,
          ).toBe(false);
        }
      }
    });
  }

  it('the protocol imports no workspace package, chain library or wallet library', () => {
    for (const file of productionFiles('protocol')) {
      for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
        expect(/^(?:@lexaegis\/|viem|@noble\/|ethers)/.test(specifier), specifier).toBe(false);
      }
    }
  });
});
