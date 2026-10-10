/**
 * pnpm test:history:browser
 *
 * Chapter 7 review history in real headless Chromium on the production build. The history API
 * routes run for real against the real Alchemy endpoint (live checkpoint and canonical block
 * hashes); the Envio GraphQL service is a LOCAL LOOPBACK FIXTURE that serves rows carrying real
 * canonical block hashes. It is NOT evidence of live Envio ingestion: it shows only that the
 * routes, client and interface behave correctly when an Envio-shaped service answers.
 *
 * Needs ALCHEMY_MONAD_RPC_URL; without it the check reports "blocked" and exits non-zero.
 */
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { Pool } from 'pg';
import { migrate } from '../../apps/web/src/server/db/migrate';
import { startLocalPostgres } from '../../test-support/embedded-pg';
import { chromium, type Page } from 'playwright';
import { ROOT } from './lib';

const PORT = 3107;
const ORIGIN = `http://localhost:${String(PORT)}`;
const WEB = join(ROOT, 'apps', 'web');
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
};

const rpc = process.env['ALCHEMY_MONAD_RPC_URL'];
if (rpc === undefined || rpc === '') {
  console.error('blocked: ALCHEMY_MONAD_RPC_URL is required for canonical block hashes');
  process.exit(3);
}

const deployment = JSON.parse(
  (await import('node:fs')).readFileSync(
    join(ROOT, 'contracts/deployments/monad-testnet.json'),
    'utf8',
  ),
) as { registryAddress: string; genesisHash: string; blockNumber: string };
const START = BigInt(deployment.blockNumber);
const REGISTRY = deployment.registryAddress;
const GENESIS = deployment.genesisHash;
const ALICE = `0x${'a11ce'.padStart(40, '0')}`;
const h = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const KEY = `10143:${GENESIS}:${REGISTRY}`;
const TOTAL = 25;

const client = createPublicClient({ transport: http(rpc) });
const hashes = new Map<number, string>();
for (let n = 0; n < TOTAL; n += 1) {
  const block = await client.getBlock({ blockNumber: START + 1n + BigInt(n) });
  hashes.set(n, block.hash);
}

type Mode = 'normal' | 'down';
let mode: Mode = 'normal';
let generation = 'gen-aaaaaaaa';
const graphqlBodies: string[] = [];

const actionRow = (n: number) => ({
  id: `${KEY}:${ALICE}:${n}`,
  reviewer: ALICE,
  kind: n === 7 ? 'SUPERSEDE' : n === 12 ? 'REVOKE' : n === 20 ? 'INVALIDATE_NONCE' : 'ISSUE',
  consumedNonce: String(n),
  nextNonce: String(n + 1),
  commitment: n === 20 ? null : h(0xc000 + n),
  relatedCommitment: n === 7 ? h(0xd000 + n) : null,
  transactionHash: h(0x7000 + n),
  executor: n === 3 ? `0x${'fee'.padStart(40, '0')}` : ALICE,
  blockNumber: String(START + 1n + BigInt(n)),
  blockHash: hashes.get(n) ?? h(0),
  timestamp: String(1_790_000_000 + n),
  firstEventId: `ev-${n}-a`,
  lastEventId: `ev-${n}-${n === 7 ? 'b' : 'a'}`,
  firstLogIndex: 0,
  lastLogIndex: n === 7 ? 1 : 0,
  eventCount: n === 7 ? 2 : 1,
});

const state = () => ({
  id: KEY,
  chainId: '10143',
  genesisHash: GENESIS,
  registryAddress: REGISTRY,
  configFingerprint: h(0xf1),
  generation,
  projectionVersion: 'lexaegis.history-projection.v1',
  startBlock: String(START),
  rawEventCount: TOTAL + 1,
  actionCount: TOTAL,
  pendingSupersessions: 0,
  lastEventId: 'ev-24-a',
  lastEventBlockNumber: String(START + BigInt(TOTAL)),
  lastEventBlockHash: hashes.get(TOTAL - 1) ?? h(0),
  lastEventLogIndex: 0,
});

function answer(operation: string, variables: Record<string, unknown>): unknown {
  switch (operation) {
    case 'HistoryMeta':
      return {
        _meta: {
          chainId: '10143',
          startBlock: String(START),
          progressBlock: String(START + BigInt(TOTAL)),
          sourceBlock: String(START + BigInt(TOTAL)),
          isReady: true,
          eventsProcessed: String(TOTAL + 1),
        },
        RegistryState: [state()],
      };
    case 'ReviewerSummary':
      return {
        ReviewerSummary_by_pk: {
          id: `${KEY}:${ALICE}`,
          reviewer: ALICE,
          nextNonce: String(TOTAL),
          totalReceipts: TOTAL,
          activeReceipts: TOTAL - 3,
          revokedReceipts: 1,
          supersededReceipts: 1,
          actionCount: TOTAL,
        },
      };
    case 'ReviewerActions': {
      const upper = Number(variables['upper']);
      const limit = Number(variables['limit']);
      const rows: unknown[] = [];
      for (let n = Math.min(upper, TOTAL - 1); n >= 0 && rows.length < limit; n -= 1)
        rows.push(actionRow(n));
      return { IndexedAction: rows };
    }
    case 'ActionAnchors': {
      const ids = variables['ids'] as string[];
      return {
        IndexedAction: ids
          .map((id) => Number(id.split(':').at(-1)))
          .filter((n) => n >= 0 && n < TOTAL)
          .map(actionRow),
      };
    }
    default: {
      const id = String(variables['id']);
      const commitment = id.split(':').at(-1) ?? '';
      const n = Number.parseInt(commitment.slice(-4), 16) - 0xc000;
      if (!(n >= 0 && n < TOTAL)) return { IndexedReceipt_by_pk: null };
      return {
        IndexedReceipt_by_pk: {
          id,
          reviewer: ALICE,
          commitment,
          status: n === 7 ? 'SUPERSEDED' : n === 12 ? 'REVOKED' : 'ACTIVE',
          predecessor: n === 8 ? h(0xc007) : h(0),
          successor: n === 7 ? h(0xd007) : n === 8 ? h(0xc009) : h(0),
          issuedAt: String(1_790_000_000 + n),
          updatedAt: String(1_790_000_000 + n),
          issuingActionId: `${KEY}:${ALICE}:${n}`,
          latestActionId: `${KEY}:${ALICE}:${n}`,
        },
      };
    }
  }
}

const fixture: Server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
  request.on('end', () => {
    graphqlBodies.push(body);
    if (mode === 'down') {
      response.writeHead(503).end();
      return;
    }
    const parsed = JSON.parse(body) as {
      operationName: string;
      variables: Record<string, unknown>;
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: answer(parsed.operationName, parsed.variables) }));
  });
});
await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const fixturePort = (fixture.address() as { port: number }).port;

const postgres = await startLocalPostgres();
const pool = new Pool({ connectionString: postgres.url });
pool.on('connect', (c) => c.on('error', () => undefined));
pool.on('error', () => undefined);
await migrate(pool);

const env = {
  DATABASE_URL: postgres.url,
  NEXT_DIST_DIR: '.next-history-check',
  NEXT_TELEMETRY_DISABLED: '1',
  NEXT_PUBLIC_APP_ORIGIN: ORIGIN,
  NEXT_PUBLIC_WEBAUTHN_RP_ID: 'localhost',
  NEXT_PUBLIC_CHAIN_ID: '10143',
  ALCHEMY_MONAD_RPC_URL: rpc,
  ENVIO_GRAPHQL_URL: `http://127.0.0.1:${String(fixturePort)}/v1/graphql`,
  ENVIO_API_TOKEN: 'fixture-token-not-a-secret',
  WEB_PORT: String(PORT),
};
let server: ChildProcess | null = null;
const browser = await chromium.launch({ headless: true });

const text = async (page: Page): Promise<string> =>
  (await page.locator('main').innerText()).replace(/\s+/g, ' ');

try {
  const build = await new Promise<number>((resolve) => {
    const child = spawn('pnpm', ['exec', 'next', 'build'], {
      cwd: WEB,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
  check('production build', build === 0);
  server = spawn('pnpm', ['exec', 'next', 'start', '--port', String(PORT)], {
    cwd: WEB,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${ORIGIN}/api/health`)).ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  const context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const seen: { url: string; auth: boolean }[] = [];
  page.on('request', (request) => {
    seen.push({ url: request.url(), auth: request.headers()['authorization'] !== undefined });
  });

  await page.goto(`${ORIGIN}/history`);
  await page.getByRole('heading', { name: 'Review history' }).waitFor();
  check(
    'prompts for an address without an account',
    (await text(page)).includes('enter a reviewer address'),
  );

  await page.getByLabel('Reviewer address').fill(ALICE.toUpperCase().replace('0X', '0x'));
  await page.getByRole('button', { name: 'Show history' }).click();
  try {
    await page.locator('ol > li').first().waitFor({ timeout: 20_000 });
  } catch (error) {
    console.error('DIAGNOSTIC page text:', (await text(page)).slice(0, 400));
    console.error(
      'DIAGNOSTIC api:',
      await page.evaluate(async (reviewer: string) => {
        const r = await fetch(`/api/history/reviewers/${reviewer}`);
        return `${String(r.status)} ${(await r.text()).slice(0, 600)}`;
      }, ALICE),
    );
    throw error;
  }
  check('first page holds 20 rows', (await page.locator('ol > li').count()) === 20);
  const firstRow = await page.locator('ol > li').first().innerText();
  check(
    'newest action first',
    firstRow.includes(`Block ${String(START + BigInt(TOTAL))}`),
    firstRow.slice(0, 60),
  );
  check('provisional state is stated in text', /provisional|Catching up/i.test(await text(page)));
  check(
    'index state is labelled in words, and is not caught up while the source is behind live',
    /Catching up \(\d+ blocks behind\)/.test(await text(page)),
  );

  await page.getByRole('button', { name: 'Load more' }).click();
  await page.locator('ol > li').nth(24).waitFor({ timeout: 20_000 });
  check(
    'load more appends the remaining 5 rows without duplicates',
    (await page.locator('ol > li').count()) === 25,
  );
  check(
    'replacement renders as one row with both commitments',
    (await text(page)).includes('Receipt replaced by a newer version'),
  );
  check(
    'executor is shown when it differs from the reviewer',
    await (async () => {
      await page.locator('ol > li').nth(21).locator('summary').click();
      return (await page.locator('ol > li').nth(21).innerText()).includes('Submitted by');
    })(),
  );

  // Select a receipt: indexed and live readings are separate and not merged into one verdict.
  await page.locator('ol > li').nth(15).getByRole('button', { name: 'View receipt' }).click();
  await page.getByRole('region', { name: 'Selected receipt' }).waitFor({ timeout: 20_000 });
  const detail = await page.getByRole('region', { name: 'Selected receipt' }).innerText();
  check(
    'detail separates indexed history from live registry',
    detail.includes('Indexed history') && detail.includes('Live registry'),
  );
  check('different blocks are not compared', /different blocks/.test(detail));
  check('no combined validity claim', !/\bvalid\b|verified human|legally/i.test(detail));
  check(
    'Previous and Next are offered by link state',
    (await page.getByRole('button', { name: 'Next review' }).count()) === 1,
  );

  // Public reads: no credentials anywhere.
  check(
    'no cookies and no authorisation header were needed',
    (await context.cookies()).length === 0 && seen.every((r) => !r.auth),
  );

  // history_reset_required after a rebuild.
  generation = 'gen-bbbbbbbb';
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page
    .getByText(/History changed|No indexed history|shown/)
    .first()
    .waitFor({ timeout: 20_000 });
  // The first page after a rebuild is read fresh; a continuation under the old cursor is not.
  // The first read after a rebuild may report "recovering"; poll until a coherent page has a cursor.
  const cursorBefore = await page.evaluate(async (reviewer: string) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const r = await fetch(`/api/history/reviewers/${reviewer}?limit=5`);
      const body = (await r.json()) as { nextCursor?: string | null };
      if (typeof body.nextCursor === 'string') return body.nextCursor;
    }
    return '';
  }, ALICE);
  generation = 'gen-cccccccc';
  const reset = await page.evaluate(
    async ([reviewer, cursor]: [string, string]) => {
      const r = await fetch(`/api/history/reviewers/${reviewer}?limit=5&cursor=${cursor}`);
      return { status: r.status, body: (await r.json()) as { status: string; reason: string } };
    },
    [ALICE, cursorBefore] as [string, string],
  );
  check(
    'a rebuilt generation returns 409 history_reset_required',
    reset.status === 409 &&
      reset.body.status === 'history_reset_required' &&
      reset.body.reason === 'GENERATION_CHANGED',
    JSON.stringify(reset).slice(0, 200),
  );
  check(
    'tampered cursor is rejected the same way',
    await page.evaluate(
      async (reviewer: string) =>
        (await fetch(`/api/history/reviewers/${reviewer}?cursor=AAAA`)).status === 409,
      ALICE,
    ),
  );
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.locator('ol > li').first().waitFor({ timeout: 20_000 });
  check('refresh recovers after the rebuild', (await page.locator('ol > li').count()) === 20);

  // Index outage: history says so, live verification keeps working.
  mode = 'down';
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page
    .getByText(/History is unavailable/)
    .first()
    .waitFor({ timeout: 20_000 });
  check(
    'an unreachable index is stated, not shown as empty',
    !(await text(page)).includes('No indexed history'),
  );
  const liveStatus = await page.evaluate(async (reviewer: string) => {
    const r = await fetch(`/api/chain/receipts/${reviewer}/0x${'ab'.repeat(32)}`);
    return { status: r.status, body: (await r.json()) as { status: string } };
  }, ALICE);
  check(
    'live receipt reads still answer while the index is down',
    liveStatus.status === 200 && liveStatus.body.status.length > 0,
    liveStatus.body.status,
  );
  mode = 'normal';

  // Keyboard: Refresh reachable and operable without a pointer.
  await page.getByRole('button', { name: 'Refresh' }).focus();
  await page.keyboard.press('Enter');
  await page.locator('ol > li').first().waitFor({ timeout: 20_000 });
  check('keyboard activates Refresh', (await page.locator('ol > li').count()) >= 20);
  check(
    'status announcements use a polite live region',
    (await page.locator('[role="status"][aria-live="polite"]').count()) >= 1,
  );
  check(
    'reduced motion leaves no running animation',
    (await page.evaluate(() => document.getAnimations().length)) === 0,
  );

  await page.setViewportSize({ width: 390, height: 800 });
  check(
    'no horizontal scroll at 390 px',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  );

  // Only whitelisted operations with identifier variables reach the index.
  const allowed = new Set([
    'HistoryMeta',
    'ReviewerSummary',
    'ReviewerActions',
    'ActionAnchors',
    'ReceiptDetail',
    'ReceiptLink',
  ]);
  const operations = graphqlBodies
    .filter((b) => b !== '')
    .map((b) => JSON.parse(b) as { operationName: string; variables: Record<string, unknown> });
  check(
    'only named read operations reached the index',
    operations.length > 0 && operations.every((o) => allowed.has(o.operationName)),
  );
  check(
    'the index received identifiers only',
    operations.every((o) =>
      Object.values(o.variables).every(
        (v) => typeof v === 'string' || typeof v === 'number' || Array.isArray(v),
      ),
    ),
  );
  check(
    'every browser request stayed on the application origin',
    seen.every((r) => r.url.startsWith(ORIGIN) || r.url.startsWith('data:')),
  );
} finally {
  await browser.close();
  if (server?.pid !== undefined) {
    try {
      process.kill(-server.pid);
    } catch {
      /* already stopped */
    }
  }
  fixture.close();
  await pool.end().catch(() => undefined);
  await postgres.stop();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${String(checks.length - failed.length)} of ${String(checks.length)} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
