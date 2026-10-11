/**
 * pnpm test:verifier:browser: the independent verifier in a fresh Chromium context with no LexAegis
 * cookies, account, passkey, provider credential or backend.
 *
 * It takes the readable export and the public reference produced by the ACTUAL Chapter 10 flow
 * (pnpm test:hud:browser with HUD_EXPORT_OUT), then:
 *   A. checks them locally with every non-asset request blocked;
 *   B. checks the registry through an independent, scripted JSON-RPC endpoint (local loopback, test
 *      only) and proves nothing private is sent and no malicious artifact URL is requested;
 *   C. performs bounded READ-ONLY reads of the genuine Monad Testnet deployment for the lifecycle
 *      example recorded by the Chapter 6 live run. It never broadcasts, signs or creates a receipt.
 * Imports no workspace package.
 */
import { execFileSync, spawn } from 'node:child_process';
import { keccak_256 } from '@noble/hashes/sha3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { recordEvidence } from '../src/evidence-writer';
import { ROOT, stamp } from './lib';

interface Check {
  name: string;
  ok: boolean;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok });
  console.log(
    `${ok ? 'pass' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail.slice(0, 200)})`}`,
  );
}

const VERIFIER_DIR = join(ROOT, 'apps', 'verifier');
const SHOTS = join(ROOT, 'docs', 'evidence', 'chapter11');
const shots: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'lexaegis-verifier-check-'));

const hex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString('hex')}`;
const keccak = (text: string) => keccak_256(new TextEncoder().encode(text));
const selector = (signature: string) => hex(keccak(signature).slice(0, 4));
const word = (value: bigint | string) =>
  (typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '')).padStart(64, '0');
const SELECTORS = {
  protocolVersion: selector('protocolVersion()'),
  nonceOf: selector('nonceOf(address)'),
  getReceipt: selector('getReceipt(address,bytes32)'),
};
const CODE = '0x6001600155';
const blockHash = (n: bigint) => `0x${word(n)}`;

async function serve(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, port: typeof address === 'object' && address !== null ? address.port : 0 };
}

function staticServer(dir: string) {
  return serve((request, response) => {
    const url = (request.url ?? '/').split('?')[0] ?? '/';
    const path = join(dir, url === '/' ? 'index.html' : url);
    if (!path.startsWith(dir) || !existsSync(path)) {
      response.writeHead(404).end();
      return;
    }
    const type = path.endsWith('.js')
      ? 'text/javascript'
      : path.endsWith('.css')
        ? 'text/css'
        : path.endsWith('.json')
          ? 'application/json'
          : 'text/html';
    response.writeHead(200, { 'content-type': type }).end(readFileSync(path));
  });
}

interface RpcLog {
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/** A scripted registry behind JSON-RPC. TEST ONLY: loopback, deterministic, not a chain. */
async function scriptedRpc(
  reference: { chainId: string; reviewerAddress: string; commitment: string },
  origin: () => string,
) {
  const log: RpcLog[] = [];
  const started = await serve((request, response) => {
    const cors = {
      'access-control-allow-origin': origin(),
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors).end();
      return;
    }
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      log.push({ body, headers: request.headers });
      const { id, method, params } = JSON.parse(body) as {
        id: number;
        method: string;
        params: unknown[];
      };
      const reply = (result: unknown) =>
        response
          .writeHead(200, { ...cors, 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      if (method === 'eth_chainId') return reply(`0x${BigInt(reference.chainId).toString(16)}`);
      if (method === 'eth_getBlockByNumber') {
        const tag = params[0] as string;
        const number = tag === 'finalized' ? 100n : BigInt(tag);
        return reply({
          number: `0x${number.toString(16)}`,
          hash: blockHash(number),
          timestamp: '0x64',
        });
      }
      if (method === 'eth_getCode') return reply(CODE);
      const data = (params[0] as { data: string }).data;
      if (data.startsWith(SELECTORS.protocolVersion)) return reply(`0x${word(1n)}`);
      if (data.startsWith(SELECTORS.nonceOf)) return reply(`0x${word(2n)}`);
      const wanted =
        data.includes(reference.commitment.slice(2)) &&
        data.includes(reference.reviewerAddress.slice(2));
      // Active, issued at one time, never changed since.
      return reply(
        `0x${wanted ? [word(1n), word(0n), word(0n), word(1_800_000_001n), word(1_800_000_001n)].join('') : [0n, 0n, 0n, 0n, 0n].map(word).join('')}`,
      );
    });
  });
  return { log, ...started };
}

function build(outDir: string, mode: string, env: Record<string, string>): void {
  execFileSync(
    join(VERIFIER_DIR, 'node_modules', '.bin', 'vite'),
    ['build', '--mode', mode, '--outDir', outDir, '--emptyOutDir'],
    { cwd: VERIFIER_DIR, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
  shots.push(`docs/evidence/chapter11/${name}.png`);
}

const text = async (page: Page, testId: string) =>
  (await page.getByTestId(testId).innerText()).replace(/\s+/g, ' ').trim();

async function main(): Promise<void> {
  // ---- The package, exported through the actual Chapter 10 flow -------------------------------
  let exportDir = process.env.VERIFIER_EXPORT_DIR ?? '';
  if (exportDir === '') {
    exportDir = join(scratch, 'export');
    console.log('running the Chapter 10 flow to produce a real export (pnpm test:hud:browser)…');
    const child = spawn('pnpm', ['test:hud:browser'], {
      cwd: ROOT,
      env: { ...process.env, HUD_EXPORT_OUT: exportDir },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    check(
      'the Chapter 10 flow produced the export (pnpm test:hud:browser)',
      code === 0,
      `exit ${String(code)}`,
    );
  }
  const exportPath = join(exportDir, 'review-export.json');
  const referenceText = readFileSync(join(exportDir, 'receipt-reference.json'), 'utf8');
  const exported = readFileSync(exportPath);
  const reference = JSON.parse(referenceText) as {
    chainId: string;
    registryAddress: string;
    reviewerAddress: string;
    commitment: string;
  };
  const bundle = JSON.parse(exported.toString('utf8')) as {
    opening: {
      blindingNonce: string;
      manifest: { artifacts: { sha256: string; label: string | null }[] };
    };
    receiptReference: unknown;
  };
  check(
    'the app copied exactly the public reference the export declares',
    JSON.stringify(Object.entries(reference).sort()) ===
      JSON.stringify(Object.entries(bundle.receiptReference as object).sort()),
  );
  check(
    'the export is the real readable file (opening, nonce and artifacts present)',
    bundle.opening.blindingNonce.startsWith('0x'),
  );

  // ---- Builds and servers ----------------------------------------------------------------------
  let verifierOrigin = '';
  const rpc = await scriptedRpc(reference, () => verifierOrigin);
  const rpcOrigin = `http://127.0.0.1:${String(rpc.port)}`;
  const policy = {
    id: 'test.scripted-registry',
    chainId: reference.chainId,
    genesisHash: blockHash(0n),
    registryAddress: reference.registryAddress,
    protocolVersion: '1',
    deploymentBlock: '1',
    deploymentTransactionHash: `0x${'11'.repeat(32)}`,
    runtimeCodeKeccak256: hex(keccak_256(Buffer.from(CODE.slice(2), 'hex'))),
    executionDelayBlocks: 3,
    executionDelayRevision: 'test-scripted',
  };
  const distA = join(scratch, 'dist-scripted');
  build(distA, 'loopback-test', {
    VITE_REGISTRY_POLICY_JSON: JSON.stringify(policy),
    VITE_RPC_URL: `${rpcOrigin}/`,
    VITE_RPC_ALLOWED_ORIGINS: rpcOrigin,
  });
  const distB = join(scratch, 'dist-production');
  build(distB, 'production', {});
  const serverA = await staticServer(distA);
  const serverB = await staticServer(distB);
  verifierOrigin = `http://127.0.0.1:${String(serverA.port)}`;
  const productionOrigin = `http://127.0.0.1:${String(serverB.port)}`;
  const trapHits: string[] = [];
  const trap = await serve((request, response) => {
    trapHits.push(request.url ?? '');
    response.writeHead(204).end();
  });
  const trapOrigin = `http://127.0.0.1:${String(trap.port)}`;

  const production = readFileSync(join(distB, 'index.html'), 'utf8');
  check(
    'the production build pins registry reads to the public Monad Testnet endpoint in its Content-Security-Policy',
    /connect-src 'self' https:\/\/testnet-rpc\.monad\.xyz;/.test(
      production.replaceAll('&#39;', "'"),
    ),
  );
  const bundleText = [join(distB, 'assets')]
    .flatMap((dir) =>
      execFileSync('ls', [dir], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map((f) => readFileSync(join(dir, f), 'utf8')),
    )
    .join('\n');
  check(
    'the built verifier contains no backend, provider or credential reference',
    !/\/api\/|ALCHEMY|qwen|envio|NEXT_PUBLIC|DATABASE_URL|localStorage|sessionStorage|indexedDB/i.test(
      bundleText,
    ),
  );

  const browser = await chromium.launch();
  const attempted: string[] = [];
  const blocked: string[] = [];
  let allowed: ReadonlySet<string> = new Set([verifierOrigin]);
  const newContext = async (): Promise<BrowserContext> => {
    const context = await browser.newContext({
      reducedMotion: 'reduce',
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
    });
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      attempted.push(route.request().url());
      if (allowed.has(url.origin)) await route.continue();
      else {
        blocked.push(route.request().url());
        await route.abort();
      }
    });
    return context;
  };

  try {
    // ---- A. Local verification with all non-asset traffic blocked ------------------------------
    const context = await newContext();
    const page = await context.newPage();
    const violations: string[] = [];
    page.on('console', (message) => {
      if (/Content Security Policy|Refused to/i.test(message.text()))
        violations.push(message.text());
    });
    await page.goto(verifierOrigin);
    check(
      'fresh context holds no cookies and no stored data',
      (await context.cookies()).length === 0 &&
        (await page.evaluate(() => localStorage.length + sessionStorage.length)) === 0,
    );
    check(
      'no LexAegis account, passkey or wallet is required (page has no sign-in)',
      (await page.getByText(/sign in|connect wallet|create account/i).count()) === 0,
    );
    check(
      'nothing has been checked and the page says so',
      (await text(page, 'no-results')).includes('Nothing has been checked'),
    );
    check(
      'no fake demo success is shown before any input',
      (await page.getByTestId('panel-manifest').count()) === 0,
    );

    await page.getByTestId('file-input').setInputFiles(exportPath);
    await page.getByTestId('panel-manifest').waitFor({ timeout: 30_000 });
    check(
      'file selection checks the exact exported bytes locally',
      /Files match the reference declared inside the file/.test(await text(page, 'label-manifest')),
      await text(page, 'label-manifest'),
    );
    check(
      'artifacts match',
      /Every committed artifact matches/.test(await text(page, 'label-artifacts')),
    );
    check(
      'registry identity is unverified and not asserted before any registry check',
      /Registry identity unverified/.test(await text(page, 'label-registry')),
    );
    check(
      'registry status is unknown and signer is not evaluated',
      /Registry status unknown/.test(await text(page, 'label-lifecycle')) &&
        /Signer not evaluated/.test(await text(page, 'label-signer')),
    );
    check(
      'a file-declared reference is flagged as not independent',
      (await page.getByTestId('origin-warning').count()) === 1 &&
        /Not independently supplied/.test(await text(page, 'reference-origin')),
    );
    const card = await text(page, 'reference-card');
    check(
      'the whole chain, registry, reviewer and commitment reference is shown',
      [
        reference.chainId,
        reference.registryAddress,
        reference.reviewerAddress,
        reference.commitment,
      ].every((value) => card.includes(value)),
    );
    check(
      'copy controls exist for each reference part and the whole reference',
      (await page.getByTestId('reference-card').getByRole('button', { name: /^Copy/ }).count()) ===
        5,
    );
    check(
      'declared profile shown and content explicitly not evaluated',
      /Content not evaluated/.test(await text(page, 'semantics')),
    );
    check(
      'no single combined valid badge exists',
      (await page.getByText(/^\s*valid\s*$/i).count()) === 0,
    );
    check(
      'the page made no request outside its own origin',
      blocked.length === 0,
      blocked.join(','),
    );
    await shot(page, '01-local-check-1280');

    // Independent reference: separate input; a wrong one is a mismatch that the file cannot resolve.
    await page.getByTestId('reference-input').fill(referenceText);
    await page.getByTestId('check-files').click();
    await page.getByText('Files match the reference you supplied').waitFor({ timeout: 30_000 });
    check(
      'an independently supplied reference is identified as such',
      /Supplied independently by you/.test(await text(page, 'reference-origin')),
    );
    const wrong = JSON.stringify({
      ...reference,
      commitment: `0x${reference.commitment.slice(2).replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))}`,
    });
    await page.getByTestId('reference-input').fill(wrong);
    await page.getByTestId('check-files').click();
    await page.getByText('Files do not match the expected reference').waitFor({ timeout: 30_000 });
    check(
      'a substituted expectation is a mismatch and is never silently replaced by the file’s reference',
      (await page.getByTestId('declared-conflict').count()) === 1 &&
        (await text(page, 'reference-card')).includes(reference.commitment),
    );
    await shot(page, '02-substituted-reference-1280');
    await page.getByTestId('reference-input').fill(referenceText);
    await page.getByTestId('check-files').click();
    await page.getByText('Files match the reference you supplied').waitFor();

    // Registry check: an explicit action that names the receiving origin first.
    check(
      'the receiving RPC origin is named before any request',
      (await text(page, 'disclosure')).includes(rpcOrigin),
    );
    check(
      'the signer panel reads "No signer policy selected" when absent',
      (await page.getByTestId('no-signer-policy').count()) === 1,
    );
    const beforeLive = rpc.log.length;
    check('no registry request was made before the explicit action', beforeLive === 0);

    // B1. RPC unreachable: honest configuration error, local results retained.
    await page.getByTestId('check-registry').click();
    await page
      .getByTestId('issues')
      .getByText(/RPC endpoint could not be reached/)
      .waitFor({ timeout: 30_000 });
    check(
      'an unreachable endpoint is reported honestly and local results stay',
      /Every committed artifact matches/.test(await text(page, 'label-artifacts')) &&
        /Registry status unknown/.test(await text(page, 'label-lifecycle')),
    );

    // B2. Allow only the configured RPC; the LexAegis backend, Qwen and Envio are not reachable at all.
    allowed = new Set([verifierOrigin, rpcOrigin]);
    await page.getByTestId('signer-input').fill(reference.reviewerAddress);
    await page.getByTestId('check-registry').click();
    await page
      .getByText(/Active at block/)
      .first()
      .waitFor({ timeout: 30_000 });
    check(
      'live status is read directly through the selected RPC',
      /Active at block 97/.test(await text(page, 'label-lifecycle')) &&
        /Receipt binds to the verified files/.test(await text(page, 'label-lifecycle')),
    );
    check(
      'the registry identity matches the configured deployment',
      /matches the configured deployment/.test(await text(page, 'label-registry')),
    );
    check(
      'the signer meets the rule the recipient typed, not anything the file says',
      /Signer meets your selected rule/.test(await text(page, 'label-signer')),
    );
    check(
      'actual block and checkpoint are displayed',
      /Read at block 97 \(finalized height 100/.test(await text(page, 'checkpoint')),
    );
    const sent = rpc.log.map((entry) => entry.body).join('\n');
    const secrets = [
      bundle.opening.blindingNonce,
      ...bundle.opening.manifest.artifacts.map((artifact) => artifact.sha256),
      'review-export.json',
      'GBP',
      'artifacts',
      'manifest',
      'label',
    ];
    check(
      'live checking sent no opening nonce, artifact hash, file name or case text',
      secrets.every((secret) => !sent.includes(secret)),
      secrets.find((secret) => sent.includes(secret)) ?? '',
    );
    const methods = new Set(
      rpc.log.map((entry) => (JSON.parse(entry.body) as { method: string }).method),
    );
    check(
      'only the four public RPC methods were used',
      [...methods].every((method) =>
        ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'].includes(method),
      ),
      [...methods].join(','),
    );
    check(
      'no cookie or authorisation header accompanied any request',
      rpc.log.every(
        (entry) => entry.headers.cookie === undefined && entry.headers.authorization === undefined,
      ),
    );
    check(
      'every attempted request went only to the verifier origin or the selected RPC',
      attempted.every((url) => url.startsWith(verifierOrigin) || url.startsWith(rpcOrigin)) &&
        blocked.every((url) => url.startsWith(rpcOrigin)),
      blocked.join(','),
    );
    check(
      'the LexAegis backend, Qwen and Envio were never contacted',
      attempted.every((url) => !/:3000\b|\/api\/|qwen|envio|hypersync|alchemy/i.test(url)),
    );
    await shot(page, '03-live-status-scripted-rpc-1280');

    // A refresh failure keeps the last good status "as of".
    allowed = new Set([verifierOrigin]);
    await page.getByTestId('check-registry').click();
    await page.getByTestId('as-of').waitFor({ timeout: 30_000 });
    check(
      'a failed refresh keeps the last good status labelled as of its own time',
      /last status read was Active at block 97, as of/.test(await text(page, 'as-of')),
    );
    allowed = new Set([verifierOrigin, rpcOrigin]);

    // Policy change invalidates the live result.
    await page.getByTestId('signer-input').fill(`0x${'55'.repeat(20)}`);
    await page.getByTestId('no-checkpoint').waitFor();
    check(
      'a signer-rule change invalidates the registry result and applies the new rule',
      /Signer does not meet your selected rule/.test(await text(page, 'label-signer')),
    );

    // Download: the explicit public projection only.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download').click(),
    ]);
    const projection = readFileSync(await download.path(), 'utf8');
    check(
      'the download uses a generic filename',
      download.suggestedFilename() === 'proof-of-review-verification-result.json',
      download.suggestedFilename(),
    );
    check(
      'the download is an unsigned observation holding only public fields',
      /Unsigned observation/.test(projection) &&
        !/blindingNonce|sha256|"label"|artifactId|127\.0\.0\.1|review-export/.test(projection) &&
        !projection.includes(bundle.opening.manifest.artifacts[0]?.sha256 ?? 'x'),
    );
    check(
      'the download names the verification schema, not a review package',
      projection.includes('"lexaegis.verification-result.v1"'),
    );

    // Clear removes everything; nothing was persisted.
    await page.getByTestId('clear').click();
    await page.getByTestId('no-results').waitFor();
    check(
      'Clear removes the file, the reference and every result from the page',
      !(await page.content()).includes(reference.commitment) &&
        (await page.getByTestId('file-summary').count()) === 0,
    );
    check(
      'nothing was stored by the page',
      (await page.evaluate(() => localStorage.length + sessionStorage.length)) === 0 &&
        (await context.cookies()).length === 0,
    );

    // Keyboard operation: reference-only inspection with only the keyboard.
    await page.getByTestId('reference-input').fill(referenceText);
    await page.getByTestId('inspect-reference').focus();
    await page.keyboard.press('Enter');
    await page.getByText('Files not supplied').waitFor();
    const outline = await page.evaluate(
      () =>
        getComputedStyle(document.querySelector('[data-testid="inspect-reference"]') as Element)
          .outlineStyle,
    );
    check(
      'reference-only inspection works from the keyboard and never claims file verification',
      /Artifacts not supplied/.test(await text(page, 'label-artifacts')) && outline !== 'none',
      outline,
    );
    await page.getByTestId('file-input').focus();
    check(
      'the file control is reachable and shows a visible focus outline',
      (await page.evaluate(
        () => getComputedStyle(document.activeElement as Element).outlineStyle,
      )) !== 'none',
    );
    await page.getByTestId('clear').click();

    // Cancellation of a long local job: the worker is terminated, not raced.
    const huge = Buffer.from(
      `{"schema":"lexaegis.review-export.v1","pad":"${'A'.repeat(46 * 1024 * 1024)}"}`,
    );
    let cancelled = false;
    for (let attempt = 0; attempt < 3 && !cancelled; attempt += 1) {
      await page
        .getByTestId('file-input')
        .setInputFiles({ name: 'big.json', mimeType: 'application/json', buffer: huge });
      await page
        .getByTestId('cancel')
        .click({ timeout: 5000 })
        .catch(() => undefined);
      cancelled = await page
        .getByText('The check was cancelled.')
        .isVisible()
        .catch(() => false);
      if (!cancelled) {
        await page.getByTestId('progress').waitFor();
        await page.getByTestId('clear').click();
      }
    }
    check('Cancel stops a long local check and says so', cancelled);
    await page.getByTestId('clear').click();

    // Wrong formats get actionable messages, by content.
    await page.getByTestId('file-input').setInputFiles({
      name: 'backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"schema":"lexaegis.encrypted-review-export.v1"}'),
    });
    await page.getByTestId('failure').waitFor();
    check(
      'an encrypted backup gets an actionable wrong-format message',
      /encrypted backup/.test(await text(page, 'failure')),
    );
    await page.getByTestId('file-input').setInputFiles({
      name: 'notes.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"schema":"lexaegis.matter-context-export.v1"}'),
    });
    await page.getByText(/saved matter context/).waitFor();
    check('a context-only export gets an actionable wrong-format message', true);
    await page.getByTestId('clear').click();

    // Malicious artifact URLs and markup are inert.
    const hostile = JSON.parse(exported.toString('utf8')) as typeof bundle & {
      opening: { manifest: { artifacts: { label: string | null }[] } };
    };
    const first = hostile.opening.manifest.artifacts[0];
    if (first !== undefined)
      first.label = `<img src="${trapOrigin}/label.png"><a href="${trapOrigin}/click">click me</a>`;
    writeFileSync(join(scratch, 'hostile.json'), JSON.stringify(hostile));
    await page.getByTestId('file-input').setInputFiles(join(scratch, 'hostile.json'));
    await page.getByTestId('panel-artifacts').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(500);
    check(
      'a hostile label is shown as escaped text, never rendered',
      (await page.getByTestId('artifact-label').first().innerText()).includes('<img src=') &&
        (await page.locator('img, a[href^="http"]').count()) === 0,
    );
    check(
      'a malicious URL in the file never triggered a request',
      trapHits.length === 0 && attempted.every((url) => !url.startsWith(trapOrigin)),
      trapHits.join(','),
    );
    check(
      'no Content Security Policy violation occurred',
      violations.length === 0,
      violations[0] ?? '',
    );
    await page.getByTestId('clear').click();

    // Mobile and narrow layouts.
    for (const [width, height] of [
      [390, 844],
      [320, 640],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.getByTestId('file-input').setInputFiles(exportPath);
      await page.getByTestId('panel-manifest').waitFor({ timeout: 30_000 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      check(`no horizontal scroll at ${String(width)}px`, overflow <= 0, String(overflow));
      const small = await page.evaluate(() =>
        [...document.querySelectorAll('button, input, textarea, summary, a')]
          .filter((el) => {
            const box = el.getBoundingClientRect();
            return (
              box.width > 0 &&
              (box.height < 44 || box.width < 44) &&
              !(el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox'))
            );
          })
          .map((el) => `${el.tagName}:${(el.textContent ?? '').trim().slice(0, 20)}`),
      );
      check(
        `touch controls are at least 44px at ${String(width)}px`,
        small.length === 0,
        small.slice(0, 4).join(' | '),
      );
      await shot(page, `04-local-check-${String(width)}`);
      await page.getByTestId('clear').click();
    }
    await context.close();

    // ---- C. Genuine Monad Testnet, bounded read-only reads of the recorded lifecycle -----------
    const live: Record<string, unknown> = {
      chain: 'Monad Testnet 10143',
      endpoint: 'https://testnet-rpc.monad.xyz (public, no credentials)',
      provenance:
        'References come from the earlier Chapter 6 live run (docs/evidence/chapter06-live-2026-10-09.json). This check only reads; it broadcast nothing and created no receipt.',
    };
    let liveOutcome: 'pass' | 'unknown' = 'unknown';
    try {
      allowed = new Set([productionOrigin, 'https://testnet-rpc.monad.xyz']);
      const liveStart = attempted.length;
      const liveContext = await newContext();
      const livePage = await liveContext.newPage();
      await livePage.goto(productionOrigin);
      const policyText = await text(livePage, 'policy');
      check(
        'the default policy shown comes from the recorded deployment, not from any file',
        policyText.includes('0x453bfd1602d8a8666f55bf9a8d87b127cb94048f') &&
          /lexaegis\.monad-testnet\.registry-v1 \(default\)/.test(policyText),
      );
      const recorded = {
        schema: 'lexaegis.receipt-ref.v1',
        chainId: '10143',
        registryAddress: '0x453bfd1602d8a8666f55bf9a8d87b127cb94048f',
        reviewerAddress: '0x076815e4c5fa1048db77d533c2e05f18a5ca89d5',
        commitment: '0xa98a4088de298d89160b975e907325554e2560f9a36a899188da29bb4cd58216',
      };
      await livePage.getByTestId('reference-input').fill(JSON.stringify(recorded));
      await livePage.getByTestId('inspect-reference').click();
      await livePage.getByText('Files not supplied').waitFor();
      await livePage.getByTestId('check-registry').click();
      await livePage
        .getByText(/Superseded at block/)
        .first()
        .waitFor({ timeout: 45_000 });
      const lifecycle = await text(livePage, 'label-lifecycle');
      const history = await text(livePage, 'history');
      const checkpoint = await text(livePage, 'checkpoint');
      check(
        'LIVE (read-only): the recorded original is Superseded on Monad Testnet',
        /Superseded at block \d+/.test(lifecycle),
        lifecycle,
      );
      check(
        'LIVE (read-only): its replacement is read separately and is Revoked, never relabelling the original',
        /revoked/.test(history) && /Superseded/.test(lifecycle),
        history,
      );
      check(
        'LIVE (read-only): the registry identity matches the configured deployment',
        /matches the configured deployment/.test(await text(livePage, 'label-registry')),
      );
      await shot(livePage, '05-live-testnet-superseded-1280');
      live.original = { reference: recorded, lifecycle, checkpoint };
      live.history = history;

      const absent = { ...recorded, commitment: `0x${'ee'.repeat(32)}` };
      await livePage.getByTestId('reference-input').fill(JSON.stringify(absent));
      await livePage.getByTestId('inspect-reference').click();
      await livePage.getByTestId('check-registry').click();
      await livePage
        .getByText(/Receipt not found at block/)
        .first()
        .waitFor({ timeout: 45_000 });
      check(
        'LIVE (read-only): an unissued commitment is Receipt not found after a verified read',
        true,
      );
      live.notFound = {
        commitment: absent.commitment,
        lifecycle: await text(livePage, 'label-lifecycle'),
      };
      const download = await Promise.all([
        livePage.waitForEvent('download'),
        livePage.getByTestId('download').click(),
      ]);
      const projectionLive = readFileSync(await download[0].path(), 'utf8');
      check(
        'LIVE: the downloaded result carries the checkpoint and no endpoint or credential',
        /"blockNumber"/.test(projectionLive) &&
          !/testnet-rpc|authorization|apikey/i.test(projectionLive),
      );
      check(
        'LIVE: only the verifier origin and the public RPC were contacted',
        attempted
          .slice(liveStart)
          .filter((url) => !url.startsWith(verifierOrigin))
          .every(
            (url) =>
              url.startsWith(productionOrigin) || url.startsWith('https://testnet-rpc.monad.xyz'),
          ),
      );
      liveOutcome = 'pass';
      await liveContext.close();
    } catch (error) {
      live.failure = error instanceof Error ? error.message.slice(0, 200) : 'failed';
      console.log(`live Monad Testnet read did not complete: ${String(live.failure)}`);
    }
    live.activeExample =
      'UNVERIFIED: no Active receipt exists among the recorded lifecycle examples; none was created for this check.';

    const ok = checks.every((item) => item.ok);
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(
      join(ROOT, 'docs', 'evidence', `chapter11-verifier-live-${date}.json`),
      `${JSON.stringify({ observedOn: date, evidenceClass: 'live_testnet', outcome: liveOutcome, ...live }, null, 2)}\n`,
    );
    await recordEvidence({
      root: ROOT,
      results: [
        stamp({
          id: `verifier-browser-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
          subject: 'verifier-browser-check',
          command: 'pnpm test:verifier:browser',
          evidenceClass: 'virtual_authenticator',
          outcome: ok ? 'pass' : 'fail',
          evidenceRefs: shots.map((value) => ({ type: 'path' as const, value })),
          reasonCodes: [
            'EXPORT_FROM_CHAPTER10_FLOW',
            'SYNTHETIC_DOCUMENTS_ONLY',
            'SCRIPTED_RPC_LOOPBACK_FOR_PRIVACY_CHECK',
            ...(ok ? [] : ['CHECKS_FAILED']),
          ],
          facts: {
            browser: `chromium ${browser.version()}`,
            checksPassed: String(checks.filter((item) => item.ok).length),
            checksTotal: String(checks.length),
            liveReadOutcome: liveOutcome,
            realDeviceEvidence: false,
          },
        }),
      ],
    });
    console.log(
      `\n${String(checks.filter((item) => item.ok).length)} of ${String(checks.length)} checks passed.`,
    );
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close();
    for (const { server } of [rpc, serverA, serverB, trap]) server.close();
  }
}

try {
  await main();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
