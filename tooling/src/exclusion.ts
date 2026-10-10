import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/*
 * Production-exclusion guards (Chapter 14.3). A dormant runtime branch is not isolation: test
 * adapters, replay data and test keys must be absent from what ships, and from what production
 * entry points can import.
 */

/** Every test-only module must carry this marker so a built artifact that contains it is caught. */
export const TEST_MARKER = 'lexaegis-test-only';

/** Public development keys and phrases that must never appear in a shipped artifact. */
export const KNOWN_TEST_SECRETS = [
  'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // Anvil account 0
  '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // Anvil account 1
  'test test test test test test test test test test test junk',
] as const;

const FORBIDDEN_TEXT = [
  TEST_MARKER,
  'test-support/',
  // Chapter 9: the scripted provider and in-memory run store exist for tests only.
  'createScriptedProvider',
  'createMemoryRunStore',
  'startScriptedQwenServer',
  'replay-provider',
  'ReplayProvider',
  'TestSigner',
  'test-signer',
  'addVirtualAuthenticator',
  'virtual-authenticator',
] as const;

const TEST_FILE =
  /(?:\.test|\.spec|\.t)\.[cm]?[tj]sx?$|(?:^|[\\/])test-(?:helpers|support)(?:[\\/.])|[\\/]packages[\\/]agent[\\/]src[\\/]testing[\\/]/;

export interface Finding {
  readonly file: string;
  readonly rule:
    | 'TEST_MARKER_TEXT'
    | 'TEST_SECRET_LITERAL'
    | 'TEST_ARTIFACT_PATH'
    | 'TEST_IMPORT'
    | 'TEST_MODULE_REACHABLE';
}

function* files(root: string): Generator<string> {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}

export interface ArtifactScanOptions {
  /** Extra literals (for example the registry fixture key) read at scan time, never printed. */
  readonly extraSecrets?: readonly string[];
  /** Relative paths classified as required production demo documents, not test fixtures. */
  readonly allowedPaths?: readonly string[];
}

/** Scans built output (web client/server, verifier, containers, distributables). */
export function scanArtifacts(
  roots: readonly string[],
  options: ArtifactScanOptions = {},
): Finding[] {
  const secrets = [...KNOWN_TEST_SECRETS, ...(options.extraSecrets ?? [])].map((value) =>
    value.replace(/^0x/, '').toLowerCase(),
  );
  const allowed = new Set(options.allowedPaths ?? []);
  const findings: Finding[] = [];
  for (const root of roots) {
    for (const file of files(root)) {
      const name = relative(root, file);
      if (allowed.has(name)) continue;
      if (TEST_FILE.test(name) || /(^|[\\/])(fixtures|test-support|__tests__)[\\/]/.test(name)) {
        findings.push({ file: name, rule: 'TEST_ARTIFACT_PATH' });
      }
      if (statSync(file).size > 20 * 1024 * 1024) continue;
      const text = readFileSync(file, 'utf8');
      const lower = text.toLowerCase();
      if (FORBIDDEN_TEXT.some((needle) => text.includes(needle))) {
        findings.push({ file: name, rule: 'TEST_MARKER_TEXT' });
      }
      if (secrets.some((secret) => lower.includes(secret))) {
        findings.push({ file: name, rule: 'TEST_SECRET_LITERAL' });
      }
    }
  }
  return findings;
}

const IMPORT =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const FORBIDDEN_SPECIFIER =
  /test-support|@lexaegis\/tooling|[\\/]tooling[\\/]|contracts[\\/](integration|scripts)|replay|test-signer|virtual-authenticator|@lexaegis\/agent\/testing|(?:^|[\\/])testing(?:[\\/]|$)/i;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs'];

function specifiers(source: string): string[] {
  return [...source.matchAll(IMPORT)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

function resolveRelative(
  from: string,
  specifier: string,
  alias: ReadonlyMap<string, string>,
): string | null {
  let base: string;
  if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else {
    const prefix = [...alias.keys()].find((key) => specifier.startsWith(key));
    if (prefix === undefined) return null;
    base = join(alias.get(prefix) ?? '', specifier.slice(prefix.length));
  }
  for (const candidate of [
    base,
    ...EXTENSIONS.map((ext) => `${base}${ext}`),
    ...EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export interface GraphScanOptions {
  readonly entries: readonly string[];
  /** Import prefixes mapped to directories, for example "@/" to apps/web/src. */
  readonly alias?: ReadonlyMap<string, string>;
  readonly root: string;
}

/** Walks the production import graph from its entry points and reports any test-only reach. */
export function scanImportGraph(options: GraphScanOptions): Finding[] {
  const alias = options.alias ?? new Map<string, string>();
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const queue = [...options.entries];
  const name = (file: string) => relative(options.root, file).split(sep).join('/');
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    if (TEST_FILE.test(file)) findings.push({ file: name(file), rule: 'TEST_MODULE_REACHABLE' });
    const source = readFileSync(file, 'utf8');
    for (const specifier of specifiers(source)) {
      if (FORBIDDEN_SPECIFIER.test(specifier))
        findings.push({ file: name(file), rule: 'TEST_IMPORT' });
      const next = resolveRelative(file, specifier, alias);
      if (next !== null) queue.push(next);
    }
  }
  return findings;
}
