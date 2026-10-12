/**
 * pnpm docs:check: the documentation is generated, linked and honest.
 *
 *  - the API reference (TypeDoc, pinned) builds twice with identical output, from actual public
 *    exports, and holds no private filesystem path, secret or test-only name;
 *  - every documented import path and named import exists in the BUILT package (the packed exports);
 *  - the exit-code table in the CLI README equals the constants in the source;
 *  - every relative link and heading anchor in the repository's documentation resolves;
 *  - the root README links the specification, vectors, Python checker, quickstart, WHY and API docs;
 *  - the generated documentation and its tool never reach a web or verifier production artifact.
 * Imports no workspace package: built output is loaded as plain files.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanSecrets } from '../src/secrets';
import { ROOT } from './lib';

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
}

const run = (command: string, args: string[]): string =>
  execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

function digestTree(directory: string): string {
  const hash = createHash('sha256');
  for (const file of [...walk(directory)].sort()) {
    hash.update(relative(directory, file));
    hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}

// ---- 1. API reference: reproducible and clean ------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'lexaegis-docs-'));
try {
  const first = join(scratch, 'one');
  const second = join(scratch, 'two');
  run('pnpm', ['exec', 'typedoc', '--out', first]);
  run('pnpm', ['exec', 'typedoc', '--out', second]);
  check(
    'the API reference builds reproducibly (two builds are byte-identical)',
    digestTree(first) === digestTree(second),
  );

  const files = [...walk(first)];
  const text = files
    .filter((file) => /\.(html|js|json|css)$/.test(file) && !file.includes('/assets/search'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  check(
    'the API reference holds no private filesystem path',
    !text.includes(ROOT) && !/\/home\/[a-z]|\/Users\/[A-Za-z]|file:\/\/\//.test(text),
  );
  check('the API reference holds no secret pattern', scanSecrets(first).length === 0);
  const pages = files
    .filter((file) => file.endsWith('.html'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  check(
    'the API reference names no test support, replay or application module path',
    !/test-support|virtual-authenticator|TestSigner|createScriptedProvider|createMemoryRunStore|replay-provider|@lexaegis\/(?:agent|web|vault)\//.test(
      pages,
    ),
  );
  const modules = readdirSync(join(first, 'modules')).map((file) => file.replace(/\.html$/, ''));
  check(
    'every package entry point has a module page',
    [
      '_lexaegis_protocol',
      '_lexaegis_protocol_v1',
      '_lexaegis_protocol_portable',
      '_lexaegis_sdk',
      '_lexaegis_sdk_portable',
      '_lexaegis_sdk_offline',
      '_lexaegis_sdk_verify',
      '_lexaegis_sdk_registry',
      '_lexaegis_sdk_transactions',
      '_lexaegis_sdk_agent-identity',
    ].every((name) => modules.includes(name)),
    modules.length.toString(),
  );
  check(
    'the read-only path is documented: verifyReviewExport and verifyReceipt have pages',
    files.some((file) => file.endsWith('sdk_verify.verifyReviewExport.html')) &&
      files.some((file) => file.endsWith('sdk_verify.verifyReceipt.html')),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// ---- 2. documented imports exist in the built (packed) packages ---------------------------------
if (!existsSync(join(ROOT, 'packages', 'sdk', 'dist', 'index.js'))) run('pnpm', ['packages:build']);

interface Manifest {
  publishConfig: { exports: Record<string, string | { default: string }> };
}
const runtimeExports = new Map<string, Set<string>>();
async function exportsOf(packageName: string, subpath: string): Promise<Set<string> | null> {
  const key = `${packageName}${subpath}`;
  const known = runtimeExports.get(key);
  if (known !== undefined) return known;
  const directory = join(ROOT, 'packages', packageName);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Manifest;
  const entry = manifest.publishConfig.exports[subpath === '' ? '.' : `.${subpath}`];
  if (entry === undefined || typeof entry === 'string') return null;
  const loaded = (await import(pathToFileURL(join(directory, entry.default)).href)) as Record<
    string,
    unknown
  >;
  const names = new Set(Object.keys(loaded));
  runtimeExports.set(key, names);
  return names;
}

const markdownFiles = [
  join(ROOT, 'README.md'),
  ...[...walk(join(ROOT, 'docs'))].filter(
    (file) => file.endsWith('.md') && !file.includes('/api/'),
  ),
  ...['protocol', 'sdk', 'cli'].map((name) => join(ROOT, 'packages', name, 'README.md')),
  join(ROOT, 'packages', 'protocol', 'test-vectors', 'README.md'),
  join(ROOT, 'examples', 'document-review', 'README.md'),
  join(ROOT, 'examples', 'python-verify', 'README.md'),
  join(ROOT, 'examples', 'embed', 'README.md'),
  join(ROOT, 'examples', 'ai-pr-signoff', 'README.md'),
  join(ROOT, 'packages', 'verify-embed', 'README.md'),
  join(ROOT, 'contracts', 'REGISTRY_REFERENCE.md'),
].filter((file) => existsSync(file));

const sdkSources = [...walk(join(ROOT, 'packages', 'sdk', 'src'))].filter(
  (file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('test-helpers.ts'),
);
const IMPORT =
  /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'(@lexaegis\/(protocol|sdk|cli)(\/[a-z0-9-]+)?)'/g;
const problems: string[] = [];
let importsChecked = 0;
for (const file of [...markdownFiles, ...sdkSources]) {
  // In TSDoc the example lines carry a leading comment star; remove it before reading imports.
  const content = readFileSync(file, 'utf8').replace(/^\s*\* ?/gm, '');
  for (const match of content.matchAll(IMPORT)) {
    const [, typeOnly, names = '', , packageName = '', subpath = ''] = match;
    importsChecked += 1;
    const available = await exportsOf(packageName, subpath);
    if (available === null) {
      problems.push(`${relative(ROOT, file)}: no packed export "${match[3] ?? ''}"`);
      continue;
    }
    if (typeOnly !== undefined) continue;
    for (const item of names
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '')) {
      if (/^type\s/.test(item)) continue;
      const name = item.split(/\s+as\s+/)[0] ?? item;
      if (!available.has(name))
        problems.push(`${relative(ROOT, file)}: ${name} is not exported by ${match[3] ?? ''}`);
    }
  }
}
check(
  'every documented import path and named import exists in the built package exports',
  problems.length === 0 && importsChecked > 30,
  problems.length === 0 ? `${String(importsChecked)} imports` : problems.slice(0, 3).join(' | '),
);

// ---- 3. error and exit tables match the source ---------------------------------------------------------
const exitSource = readFileSync(join(ROOT, 'packages', 'cli', 'src', 'exit.ts'), 'utf8');
const exitCodes = new Set(
  [
    ...(
      /export const EXIT = Object\.freeze\(\{([\s\S]*?)\} as const\)/.exec(exitSource)?.[1] ?? ''
    ).matchAll(/:\s*(\d+),/g),
  ].map((match) => match[1] ?? ''),
);
const cliReadme = readFileSync(join(ROOT, 'packages', 'cli', 'README.md'), 'utf8');
const readmeCodes = new Set(
  [...cliReadme.matchAll(/^\|\s*`(\d+)`\s*\|/gm)].map((match) => match[1] ?? ''),
);
check(
  'the CLI README exit-code table equals the exit constants in the source',
  exitCodes.size >= 8 &&
    [...exitCodes].every((code) => readmeCodes.has(code)) &&
    [...readmeCodes].every((code) => exitCodes.has(code)),
  `${[...exitCodes].join(',')} vs ${[...readmeCodes].join(',')}`,
);
const quickstart = readFileSync(join(ROOT, 'docs', 'QUICKSTART.md'), 'utf8');
const quickstartCodes = [...quickstart.matchAll(/^\|\s*`(\d+)`\s*\|/gm)].map(
  (match) => match[1] ?? '',
);
check(
  'every exit code the quickstart documents exists in the source',
  quickstartCodes.length > 0 && quickstartCodes.every((code) => exitCodes.has(code)),
);

// ---- 4. links and anchors -----------------------------------------------------------------------------------------
const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
const anchorsOf = (file: string): Set<string> =>
  new Set(
    [...readFileSync(file, 'utf8').matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((match) =>
      slug(match[1] ?? ''),
    ),
  );
const brokenLinks: string[] = [];
let linksChecked = 0;
for (const file of markdownFiles) {
  const content = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1] ?? '';
    if (/^(?:https?:|mailto:)/.test(target)) continue;
    linksChecked += 1;
    const [path = '', anchor] = target.split('#');
    const resolved = path === '' ? file : resolve(dirname(file), path);
    // The API reference is generated on demand and never committed.
    if (relative(ROOT, resolved).startsWith(join('docs', 'api'))) continue;
    if (!existsSync(resolved)) {
      brokenLinks.push(`${relative(ROOT, file)} -> ${target}`);
    } else if (
      anchor !== undefined &&
      resolved.endsWith('.md') &&
      !anchorsOf(resolved).has(anchor)
    ) {
      brokenLinks.push(`${relative(ROOT, file)} -> ${target} (no such heading)`);
    }
  }
}
check(
  'every relative link and heading anchor in the documentation resolves',
  brokenLinks.length === 0,
  brokenLinks.length === 0 ? `${String(linksChecked)} links` : brokenLinks.slice(0, 4).join(' | '),
);

const rootReadme = readFileSync(join(ROOT, 'README.md'), 'utf8');
check(
  'the root README links the specification, vectors, Python checker, quickstart, WHY, SDK, CLI and API reference',
  [
    'docs/SPEC.md',
    'packages/protocol/test-vectors',
    'examples/python-verify',
    'docs/QUICKSTART.md',
    'docs/WHY.md',
    'packages/sdk',
    'packages/cli',
    'pnpm docs:api',
  ].every((needle) => rootReadme.includes(needle)),
);
check(
  'the widget is documented as local and unpublished: linked from the README, no hosted script anywhere',
  rootReadme.includes('packages/verify-embed') &&
    rootReadme.includes('examples/embed') &&
    /no hosted script/i.test(rootReadme) &&
    !/<script[^>]*src=["']https?:/i.test(rootReadme + quickstart),
);
check(
  'the README states the honest empty evidence: No external trials recorded yet, No entries yet',
  rootReadme.includes('No external trials recorded yet') && rootReadme.includes('No entries yet'),
);

// ---- 5. generated documentation stays out of production artifacts ----------------------------------------------
const artifactRoots = [
  join(ROOT, 'apps', 'verifier', 'dist'),
  join(ROOT, 'apps', 'web', '.next', 'static'),
];
const leaked: string[] = [];
let artifactFiles = 0;
for (const root of artifactRoots.filter((path) => existsSync(path))) {
  for (const file of walk(root)) {
    if (!/\.(js|html|css|json|map)$/.test(file)) continue;
    artifactFiles += 1;
    if (/typedoc|docs\/api/i.test(readFileSync(file, 'utf8'))) leaked.push(relative(ROOT, file));
  }
}
check(
  'no web or verifier build artifact mentions the documentation tool or output',
  leaked.length === 0,
  leaked.slice(0, 2).join(', ') || `${String(artifactFiles)} files scanned`,
);
const dependencyOwners = [
  'apps/web',
  'apps/verifier',
  'packages/protocol',
  'packages/sdk',
  'packages/cli',
].filter((directory) =>
  /typedoc/.test(readFileSync(join(ROOT, directory, 'package.json'), 'utf8')),
);
check(
  'typedoc is a root development dependency only',
  dependencyOwners.length === 0 &&
    /"typedoc"/.test(readFileSync(join(ROOT, 'package.json'), 'utf8')),
);

const ok = checks.every((item) => item.ok);
console.log(
  `\n${String(checks.filter((item) => item.ok).length)} of ${String(checks.length)} checks passed.`,
);
process.exitCode = ok ? 0 : 1;
