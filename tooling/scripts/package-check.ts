/**
 * pnpm packages:check: proves the packages are distributable, not just importable inside the
 * monorepo. It builds @lexaegis/protocol and @lexaegis/sdk, packs real tarballs, inspects their
 * contents, installs them into a clean temporary consumer (no workspace aliases, no repository
 * source imports, no inherited TypeScript paths), compiles and runs the developer example there,
 * and bundles and runs a minimal browser consumer in real Chromium. Nothing is published.
 * Imports no workspace package.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { recordEvidence } from '../src/evidence-writer';
import { ROOT, stamp } from './lib';

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

const run = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) =>
  execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function list(tarball: string): string[] {
  return run('tar', ['-tzf', tarball], ROOT)
    .split('\n')
    .filter((line) => line !== '');
}

const FORBIDDEN_IN_TARBALL = [
  /(^|\/)\.env/,
  /\.test\.(?:ts|js)/,
  /test-helpers/,
  /(^|\/)fixtures\//,
  /(^|\/)node_modules\//,
  /(^|\/)src\//,
  /\.private/,
  /secret|credential|privatekey|mnemonic/i,
  /\.map$/,
  /\.tsbuildinfo$/,
];

const scratch = mkdtempSync(join(tmpdir(), 'lexaegis-pack-'));
const tarballs = join(scratch, 'tarballs');
const consumer = join(scratch, 'consumer');
mkdirSync(tarballs);
mkdirSync(consumer);

try {
  run('pnpm', ['packages:build'], ROOT);
  check('packages build (tsc, ESM, declarations)', true);

  const packed: Record<string, { file: string; bytes: number; sha256: string; entries: string[] }> =
    {};
  for (const name of ['protocol', 'sdk'] as const) {
    run('pnpm', ['pack', '--pack-destination', tarballs], join(ROOT, 'packages', name));
    const file = join(tarballs, `lexaegis-${name}-0.1.0.tgz`);
    const entries = list(file);
    packed[name] = {
      file,
      bytes: statSync(file).size,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      entries,
    };
    check(
      `${name}: tarball contains dist, declarations and package.json`,
      ['package/package.json', 'package/dist/index.js', 'package/dist/index.d.ts'].every((entry) =>
        entries.includes(entry),
      ),
    );
    const bad = entries.filter((entry) =>
      FORBIDDEN_IN_TARBALL.some((pattern) => pattern.test(entry)),
    );
    check(
      `${name}: tarball holds no source, tests, fixtures, secrets, keys or environment files`,
      bad.length === 0,
      bad.slice(0, 3).join(', '),
    );
    const manifest = JSON.parse(run('tar', ['-xzOf', file, 'package/package.json'], ROOT)) as {
      version: string;
      dependencies: Record<string, string>;
      exports: Record<string, unknown>;
      engines: Record<string, string>;
      private?: boolean;
    };
    check(
      `${name}: exports point at dist, versions are concrete, no workspace specifier`,
      JSON.stringify(manifest.exports).includes('./dist/') &&
        !JSON.stringify(manifest.exports).includes('./src/') &&
        Object.values(manifest.dependencies).every(
          (version) => !version.startsWith('workspace:'),
        ) &&
        manifest.version === '0.1.0' &&
        manifest.engines.node === '>=24.0.0',
      Object.keys(manifest.dependencies).join(','),
    );
  }
  const schemas = (packed.protocol?.entries ?? []).filter((entry) => entry.includes('schemas/v1/'));
  check(
    'protocol: generated schemas and the compact descriptor are packed',
    ['review-export.schema.json', 'review-package.schema.json', 'protocol-descriptor.json'].every(
      (file) => schemas.some((entry) => entry.endsWith(file)),
    ),
  );
  check(
    'sdk: generated verification-report and registry-policy schemas are packed',
    (packed.sdk?.entries ?? []).filter((entry) => /verification-report|registry-policy/.test(entry))
      .length === 2,
  );

  // Clean consumer: only the two tarballs, resolved from the offline store.
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'clean-consumer',
        private: true,
        type: 'module',
        dependencies: {
          '@lexaegis/protocol': `file:${packed.protocol?.file ?? ''}`,
          '@lexaegis/sdk': `file:${packed.sdk?.file ?? ''}`,
        },
      },
      null,
      2,
    ),
  );
  // The consumer is its own root: the tarball's concrete dependency on the protocol resolves to the
  // packed protocol tarball, not to a registry and not to this repository.
  writeFileSync(
    join(consumer, 'pnpm-workspace.yaml'),
    `overrides:\n  '@lexaegis/protocol': file:${packed.protocol?.file ?? ''}\n`,
  );
  // The repository's own package store supplies third-party packages offline; the consumer still
  // gets its own node_modules, so an undeclared dependency would fail to resolve.
  const store = run('pnpm', ['store', 'path'], ROOT).trim();
  run('pnpm', ['install', '--offline', '--no-frozen-lockfile', '--store-dir', store], consumer);
  const installed = join(consumer, 'node_modules', '@lexaegis');
  check(
    'consumer installed both packages from tarballs (real directories, no workspace link)',
    ['protocol', 'sdk'].every((name) => existsSync(join(installed, name, 'dist', 'index.js'))) &&
      !existsSync(join(installed, 'sdk', 'src')),
  );

  // The developer example, compiled in the consumer against the packed declarations.
  const exampleSource = join(ROOT, 'examples', 'document-review', 'src');
  mkdirSync(join(consumer, 'example', 'src'), { recursive: true });
  for (const name of readdirSync(exampleSource).filter((file) => !/\.test\./.test(file))) {
    cpSync(join(exampleSource, name), join(consumer, 'example', 'src', name));
  }
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2023', 'DOM'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noUncheckedIndexedAccess: true,
        verbatimModuleSyntax: true,
        skipLibCheck: false,
        // Ambient Node typings only; the packages themselves resolve from the consumer's node_modules.
        typeRoots: [join(ROOT, 'node_modules', '@types')],
        types: ['node'],
        outDir: 'out',
        rootDir: 'example/src',
      },
      include: ['example/src'],
    }),
  );
  run(join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], consumer);
  check(
    'example compiles against the packed declarations (NodeNext, skipLibCheck off)',
    existsSync(join(consumer, 'out', 'cli.js')),
  );

  const REGISTRY = '0x453bfd1602d8a8666f55bf9a8d87b127cb94048f';
  const REVIEWER = '0x2222222222222222222222222222222222222222';
  const outDir = join(consumer, 'review');
  const prepared = JSON.parse(
    run(
      'node',
      [
        'out/cli.js',
        'prepare',
        '--out',
        outDir,
        '--chain-id',
        '10143',
        '--registry',
        REGISTRY,
        '--reviewer',
        REVIEWER,
        '--nonce',
        '0',
        '--deadline',
        '1900000000',
      ],
      consumer,
    ),
  ) as { status: string; reference: { commitment: string } };
  check(
    'packaged example prepares an unapproved package',
    prepared.status === 'prepared, not approved, not issued',
  );
  const typed = JSON.parse(readFileSync(join(outDir, 'issue-typed-data.json'), 'utf8')) as {
    primaryType: string;
  };
  check(
    'packaged example builds typed signing data (no signature)',
    typed.primaryType === 'ReviewAction',
  );
  const verifyArgs = [
    'out/cli.js',
    'verify',
    '--bundle',
    join(outDir, 'review-export.json'),
    '--expected-reference',
    join(outDir, 'receipt-reference.json'),
  ];
  const report = JSON.parse(
    run('node', verifyArgs, consumer, { ...process.env, REVIEW_RPC_URL: '' }),
  ) as Record<string, unknown>;
  check(
    'packaged example verifies offline: files match, chain and signer stay unknown',
    report.manifestIntegrity === 'match' &&
      report.artifactIntegrity === 'match' &&
      report.chainStatus === 'unknown' &&
      report.signerAcceptance === 'unknown' &&
      report.referenceOrigin === 'independent',
  );
  check(
    'report holds no combined valid field and no opening',
    !/"valid"|blindingNonce/.test(JSON.stringify(report)),
  );

  // A different package must not pass under the first reference.
  const outTwo = join(consumer, 'review-two');
  run(
    'node',
    [
      'out/cli.js',
      'prepare',
      '--out',
      outTwo,
      '--chain-id',
      '10143',
      '--registry',
      REGISTRY,
      '--reviewer',
      REVIEWER,
    ],
    consumer,
  );
  const swapped = JSON.parse(
    run(
      'node',
      [
        'out/cli.js',
        'verify',
        '--bundle',
        join(outTwo, 'review-export.json'),
        '--expected-reference',
        join(outDir, 'receipt-reference.json'),
      ],
      consumer,
    ),
  ) as Record<string, unknown>;
  check(
    'packaged example catches a substituted bundle with the independent reference',
    swapped.manifestIntegrity === 'mismatch',
  );

  // Minimal browser consumer: bundled from the packed packages and run with real Web Crypto.
  const web = join(consumer, 'browser');
  mkdirSync(web);
  writeFileSync(
    join(web, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>consumer</title></head><body><script type="module" src="./main.ts"></script></body></html>\n',
  );
  writeFileSync(
    join(web, 'main.ts'),
    `import { parseReviewExport } from '@lexaegis/sdk/portable';
import { verifyOffline, verificationReportV1Schema } from '@lexaegis/sdk/offline';
import { verifyReceipt } from '@lexaegis/sdk/verify';

const bundle = new Uint8Array(await (await fetch('./bundle.json')).arrayBuffer());
const expectedReference: unknown = await (await fetch('./reference.json')).json();
const decoded = parseReviewExport(bundle);
if (!decoded.ok) throw new Error(decoded.error.code);
const offline = await verifyOffline({
  mode: 'full-package',
  expectedReference,
  referenceOrigin: 'independent',
  declaredReference: decoded.data.declaredReference,
  opening: decoded.data.opening,
  artifacts: decoded.data.artifacts,
});
const receipt = await verifyReceipt({
  mode: 'full-package',
  expectedReference,
  referenceOrigin: 'independent',
  opening: decoded.data.opening,
  artifacts: decoded.data.artifacts,
});
document.body.dataset.result = JSON.stringify({
  cryptoSubtle: typeof crypto.subtle.digest,
  manifest: offline.ok ? offline.data.manifestIntegrity : 'failed',
  artifacts: offline.ok ? offline.data.artifactIntegrity : 'failed',
  reportOk: receipt.ok && verificationReportV1Schema.safeParse(receipt.data.report).success,
  chainStatus: receipt.ok ? receipt.data.report.chainStatus : 'failed',
});
`,
  );
  cpSync(join(outDir, 'review-export.json'), join(web, 'bundle.json'));
  cpSync(join(outDir, 'receipt-reference.json'), join(web, 'reference.json'));
  const vite = join(ROOT, 'apps', 'verifier', 'node_modules', '.bin', 'vite');
  writeFileSync(
    join(web, 'vite.config.mjs'),
    "export default { build: { outDir: 'dist', emptyOutDir: true }, publicDir: false };\n",
  );
  run(vite, ['build', '--config', 'vite.config.mjs'], web);
  cpSync(join(web, 'bundle.json'), join(web, 'dist', 'bundle.json'));
  cpSync(join(web, 'reference.json'), join(web, 'dist', 'reference.json'));
  const distText = readdirSync(join(web, 'dist', 'assets'))
    .map((file) => readFileSync(join(web, 'dist', 'assets', file), 'utf8'))
    .join('\n');
  check(
    'browser bundle contains no Node-only import and no environment lookup',
    !/require\("node:|from"node:|process\.env/.test(distText),
  );

  const server = createServer((request, response) => {
    const path = join(
      web,
      'dist',
      request.url === '/' ? 'index.html' : ((request.url ?? '').split('?')[0] ?? ''),
    );
    if (!path.startsWith(join(web, 'dist')) || !existsSync(path)) {
      response.writeHead(404).end();
      return;
    }
    const type = path.endsWith('.js')
      ? 'text/javascript'
      : path.endsWith('.json')
        ? 'application/json'
        : 'text/html';
    response.writeHead(200, { 'content-type': type }).end(readFileSync(path));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.goto(`http://127.0.0.1:${String(port)}/`);
    await page.waitForFunction(() => document.body.dataset.result !== undefined, undefined, {
      timeout: 30_000,
    });
    const result = JSON.parse(
      (await page.evaluate(() => document.body.dataset.result)) ?? '{}',
    ) as Record<string, unknown>;
    check(
      'browser consumer verifies offline with real Chromium Web Crypto',
      result.cryptoSubtle === 'function' &&
        result.manifest === 'match' &&
        result.artifacts === 'match' &&
        result.reportOk === true,
      JSON.stringify(result),
    );
    check(
      'browser consumer made no network request beyond its own origin',
      requests.every((url) => url.startsWith(`http://127.0.0.1:${String(port)}/`)),
    );
    check(
      'browser consumer reports chain status unknown without live options',
      result.chainStatus === 'unknown',
    );
  } finally {
    await browser.close();
    server.close();
  }

  const ok = checks.every((item) => item.ok);
  await recordEvidence({
    root: ROOT,
    results: [
      stamp({
        id: `packages-check-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
        subject: 'packaged-consumer-check',
        command: 'pnpm packages:check',
        evidenceClass: 'local_scripted',
        outcome: ok ? 'pass' : 'fail',
        reasonCodes: [
          'LOCAL_TARBALLS_NOT_PUBLISHED',
          'AUTHORED_EXAMPLE_NOT_ADOPTION',
          ...(ok ? [] : ['CHECKS_FAILED']),
        ],
        facts: {
          checksPassed: String(checks.filter((item) => item.ok).length),
          checksTotal: String(checks.length),
          protocolTarballBytes: String(packed.protocol?.bytes ?? 0),
          sdkTarballBytes: String(packed.sdk?.bytes ?? 0),
          protocolTarballSha256: packed.protocol?.sha256 ?? '',
          sdkTarballSha256: packed.sdk?.sha256 ?? '',
          protocolFiles: String(packed.protocol?.entries.length ?? 0),
          sdkFiles: String(packed.sdk?.entries.length ?? 0),
          browser: 'chromium (playwright)',
          published: false,
        },
      }),
    ],
  });
  console.log(
    `\n${String(checks.filter((item) => item.ok).length)} of ${String(checks.length)} checks passed (local tarballs, nothing published).`,
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
