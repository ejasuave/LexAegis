import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KNOWN_TEST_SECRETS, TEST_MARKER, scanArtifacts, scanImportGraph } from './exclusion';
import { scanSecrets } from './secrets';

/*
 * Negative controls run on isolated temporary trees. Nothing here touches the user's checkout,
 * switches a branch or publishes anything, and no key value is printed.
 */

const dirs: string[] = [];
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'lj-exclusion-'));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('artifact scan', () => {
  it('passes a clean candidate', () => {
    const root = tree({ 'dist/app.js': 'export const x = 1;', 'dist/index.html': '<p>hello</p>' });
    expect(scanArtifacts([join(root, 'dist')])).toEqual([]);
  });

  it.each([
    ['the test-only marker', `// ${TEST_MARKER}\nexport {}`, 'TEST_MARKER_TEXT'],
    ['a replay provider', 'import "./replay-provider";', 'TEST_MARKER_TEXT'],
    ['a test signer identifier', 'const s = new TestSigner();', 'TEST_MARKER_TEXT'],
    [
      'a test-support path in a source map',
      '{"sources":["../test-support/signer.ts"]}',
      'TEST_MARKER_TEXT',
    ],
    [
      'a virtual authenticator call',
      'cdp.send("WebAuthn.addVirtualAuthenticator")',
      'TEST_MARKER_TEXT',
    ],
    [
      'a known development private key',
      `const k="0x${KNOWN_TEST_SECRETS[0]}";`,
      'TEST_SECRET_LITERAL',
    ],
    ['the development mnemonic', `const m="${KNOWN_TEST_SECRETS[2]}";`, 'TEST_SECRET_LITERAL'],
  ])('rejects %s', (_label, content, rule) => {
    const root = tree({ 'dist/chunk.js': content });
    expect(scanArtifacts([join(root, 'dist')]).map((f) => f.rule)).toContain(rule);
  });

  it('rejects an injected test artifact in a distributable', () => {
    const root = tree({
      'dist/app.js': 'ok',
      'dist/signer.test.js': 'ok',
      'dist/fixtures/a.json': '{}',
    });
    const rules = scanArtifacts([join(root, 'dist')]).map((f) => `${f.rule}:${f.file}`);
    expect(rules).toEqual([
      'TEST_ARTIFACT_PATH:fixtures/a.json',
      'TEST_ARTIFACT_PATH:signer.test.js',
    ]);
  });

  it('catches a caller-supplied literal such as the registry fixture key, without echoing it', () => {
    const key = 'cd'.repeat(32);
    const root = tree({ 'dist/a.js': `x="0x${key}"` });
    const findings = scanArtifacts([join(root, 'dist')], { extraSecrets: [`0x${key}`] });
    expect(findings).toEqual([{ file: 'a.js', rule: 'TEST_SECRET_LITERAL' }]);
    expect(JSON.stringify(findings)).not.toContain(key);
  });

  it('classifies required demo documents explicitly instead of banning the word fixture', () => {
    const root = tree({ 'dist/fixtures/demo-agreement.pdf': 'demo' });
    expect(scanArtifacts([join(root, 'dist')]).length).toBe(1);
    expect(
      scanArtifacts([join(root, 'dist')], { allowedPaths: ['fixtures/demo-agreement.pdf'] }),
    ).toEqual([]);
  });
});

describe('public interoperability vectors (Chapter 15)', () => {
  // The published asset is read as bytes from the repository; tooling imports no package code.
  const published = readFileSync(
    join(
      import.meta.dirname,
      '..',
      '..',
      'packages',
      'protocol',
      'test-vectors',
      'protocol-v1.json',
    ),
    'utf8',
  );

  it('permits the public synthetic vectors in a distributable', () => {
    const root = tree({
      'package/dist/index.js': 'export {};',
      'package/test-vectors/protocol-v1.json': published,
      'package/test-vectors/README.md': '# vectors',
    });
    expect(scanArtifacts([join(root, 'package')])).toEqual([]);
  });

  it('still rejects test signers, replays and development keys beside the vectors', () => {
    const root = tree({
      'package/test-vectors/protocol-v1.json': published,
      'package/test-vectors/signer.json': `{"key":"0x${KNOWN_TEST_SECRETS[0]}"}`,
      'package/test-vectors/replay.json': '{"provider":"ReplayProvider"}',
    });
    const found = scanArtifacts([join(root, 'package')]);
    expect(found.map((f) => `${f.rule}:${f.file}`).sort()).toEqual([
      'TEST_MARKER_TEXT:test-vectors/replay.json',
      'TEST_SECRET_LITERAL:test-vectors/signer.json',
    ]);
  });

  it('still classifies the signed registry fixtures as test artifacts', () => {
    const root = tree({ 'package/fixtures/registry-v1/vectors.json': '{}' });
    expect(scanArtifacts([join(root, 'package')]).map((f) => f.rule)).toEqual([
      'TEST_ARTIFACT_PATH',
    ]);
  });
});

describe('import graph scan', () => {
  const entry = (root: string) => join(root, 'src', 'index.ts');

  it('passes a clean production graph', () => {
    const root = tree({
      'src/index.ts': 'import { a } from "./a"; export { a };',
      'src/a.ts': 'export const a = 1;',
    });
    expect(scanImportGraph({ root, entries: [entry(root)] })).toEqual([]);
  });

  it('rejects a production entry that imports the test signer or the replay provider', () => {
    const root = tree({
      'src/index.ts': 'import { signer } from "../test-support/test-signer"; export { signer };',
      'test-support/test-signer.ts': 'export const signer = 1;',
    });
    const rules = scanImportGraph({ root, entries: [entry(root)] }).map((f) => f.rule);
    expect(rules).toContain('TEST_IMPORT');
    expect(rules).toContain('TEST_MODULE_REACHABLE');

    const replay = tree({
      'src/index.ts': 'import "./replay-provider"; export {};',
      'src/replay-provider.ts': 'export {};',
    });
    expect(
      scanImportGraph({ root: replay, entries: [entry(replay)] }).map((f) => f.rule),
    ).toContain('TEST_IMPORT');
  });

  it('finds a test module reached through an intermediate production file and through an alias', () => {
    const root = tree({
      'src/index.ts': 'import { b } from "@/b"; export { b };',
      'src/b.ts': 'import { h } from "./helpers.test"; export const b = h;',
      'src/helpers.test.ts': 'export const h = 1;',
    });
    const findings = scanImportGraph({
      root,
      entries: [entry(root)],
      alias: new Map([['@/', join(root, 'src')]]),
    });
    expect(findings.map((f) => f.file)).toContain('src/helpers.test.ts');
  });

  it('handles dynamic imports and ignores specifiers that look similar but are fine', () => {
    const bad = tree({ 'src/index.ts': 'export const load = () => import("../tooling/x");' });
    expect(scanImportGraph({ root: bad, entries: [entry(bad)] }).map((f) => f.rule)).toContain(
      'TEST_IMPORT',
    );
    const fine = tree({ 'src/index.ts': 'import { z } from "zod"; export { z };' });
    expect(scanImportGraph({ root: fine, entries: [entry(fine)] })).toEqual([]);
  });
});

describe('secret scan', () => {
  it('flags credentials but not empty placeholders, and honours the documented allowlist', () => {
    const key = 'ab'.repeat(32);
    const root = tree({
      '.env.example': 'QWEN_API_KEY=\nAUTH_SESSION_SECRET=\n',
      'src/leak.ts': `const privateKey = "0x${key}";`,
      'src/url.ts': 'const u = "https://user:pass@example.com/x";',
      'src/pem.txt': '-----BEGIN EC PRIVATE KEY-----',
      'src/rpc.ts': 'const r = "https://monad-testnet.example.io/v2/abcdefghijklmnopqrstuvwx";',
      'vectors.json': `{"privateKey":"0x${key}"}`,
    });
    const findings = scanSecrets(root, { 'vectors.json': 'synthetic test key' });
    expect(findings.map((f) => `${f.file}:${f.rule}`).sort()).toEqual([
      'src/leak.ts:KEY_ASSIGNMENT',
      'src/pem.txt:PRIVATE_KEY_BLOCK',
      'src/rpc.ts:PROVIDER_KEY_URL',
      'src/url.ts:URL_CREDENTIALS',
    ]);
    expect(JSON.stringify(findings)).not.toContain(key);
  });
});
