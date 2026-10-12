import type { ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import { gzipSync } from 'node:zlib';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  attributesOf,
  packageBytes,
  pageHtml,
  startEmbedFixture,
  type EmbedFixture,
} from './embed-fixture';

/*
 * LOCAL COMPATIBILITY EVIDENCE ONLY. Optional package-integrity mode of the BUILT widget in real
 * Chromium: exact match, altered bytes, missing evidence, a wrong expected reference, malformed and
 * oversized responses, an unsupported export, a refused redirect, a disallowed origin, a CORS
 * failure and a timeout, plus the separation of the two status lines. The packages are deliberately
 * public SYNTHETIC exports served by a local test server. Not live evidence.
 */

let fixture: EmbedFixture;
let browser: Browser;
let page: Page;
let pageCounter = 0;
const requests: string[] = [];
const consoleMessages: string[] = [];

const element = (): Locator => page.locator('proof-of-review-status').first();
const status = (): Locator => element().locator('.line', { hasText: 'Receipt status' });
const files = (): Locator => element().locator('.line', { hasText: 'File integrity' });
const shows = (locator: Locator, text: string, timeout = 20_000): Promise<void> =>
  expect.poll(() => locator.innerText(), { timeout }).toContain(text);
const settled = (): Promise<void> =>
  expect
    .poll(() => element().locator('.root').getAttribute('aria-busy'), { timeout: 20_000 })
    .toBe('false');
const checkFiles = (): Promise<void> =>
  element()
    .getByRole('button', { name: /Check files/ })
    .click();

async function open(
  reference: ReceiptReferenceV1,
  packageUrl: string,
  config: unknown = fixture.hostConfig(),
): Promise<void> {
  pageCounter += 1;
  const path = `/p${String(pageCounter)}.html`;
  fixture.pages.set(
    path,
    pageHtml(
      config,
      `<proof-of-review-status ${attributesOf(reference, `package-url="${packageUrl}"`)}></proof-of-review-status>`,
    ),
  );
  await page.goto(`${fixture.pageOrigin}${path}`);
  await settled();
}

const json = (value: unknown): string => JSON.stringify(value);
const exportOf = (
  key: keyof EmbedFixture['receipts'],
): { schema: string; artifacts: { artifactId: string; bytes: string }[]; [k: string]: unknown } =>
  JSON.parse(new TextDecoder().decode(packageBytes(fixture.receipts[key]))) as never;

beforeAll(async () => {
  fixture = await startEmbedFixture();
  browser = await chromium.launch();
  const { active } = fixture.receipts;
  fixture.packages.set('/pkg/active.json', { body: packageBytes(active) });
  const altered = exportOf('active');
  const first = altered.artifacts[0];
  if (first === undefined) throw new Error('fixture');
  first.bytes = `${first.bytes.startsWith('A') ? 'B' : 'A'}${first.bytes.slice(1)}`;
  fixture.packages.set('/pkg/altered.json', { body: json(altered) });
  const missing = exportOf('active');
  missing.artifacts.pop();
  fixture.packages.set('/pkg/missing.json', { body: json(missing) });
  fixture.packages.set('/pkg/malformed.json', { body: '{"schema": "lexaegis.review-export.v1", ' });
  fixture.packages.set('/pkg/encrypted.json', {
    body: json({ schema: 'lexaegis.encrypted-review-export.v1' }),
  });
  fixture.packages.set('/pkg/oversize.json', {
    body: Buffer.alloc(49 * 1024 * 1024, 0x20),
    chunked: true,
  });
  // A small compressed body that inflates past the limit: decompressed bytes are what is counted.
  fixture.packages.set('/pkg/gzip-bomb.json', {
    body: gzipSync(Buffer.alloc(49 * 1024 * 1024, 0x20)),
    headers: { 'content-encoding': 'gzip' },
  });
  fixture.packages.set('/pkg/redirect.json', {
    body: '',
    redirectTo: `${fixture.otherOrigin}/pkg/active.json`,
  });
  fixture.packages.set('/pkg/missing-404.json', { body: 'nope', status: 404 });
  fixture.packages.set('/pkg/no-cors.json', { body: packageBytes(active), noCors: true });
}, 180_000);

afterAll(async () => {
  await browser.close();
  await fixture.stop();
});

beforeEach(async () => {
  fixture.rpcMode = 'pass';
  fixture.rpcRecords.length = 0;
  fixture.packageRequests.length = 0;
  requests.length = 0;
  consoleMessages.length = 0;
  const context = await browser.newContext();
  await context.addCookies([{ name: 'session', value: 'host-cookie', url: fixture.pageOrigin }]);
  page = await context.newPage();
  page.on('request', (request) => requests.push(request.url()));
  page.on('console', (message) => consoleMessages.push(message.text()));
});

describe('package integrity mode', () => {
  it('fetches nothing before Check files and shows the line as not checked', async () => {
    await open(fixture.receipts.active.reference, `${fixture.pageOrigin}/pkg/active.json`);
    await shows(status(), 'active');
    await shows(files(), 'not checked');
    await page.waitForTimeout(300);
    expect(fixture.packageRequests).toHaveLength(0);
    expect(requests.some((url) => url.includes('/pkg/'))).toBe(false);
  });

  it('reports an exact match, with a request that carries no cookie or referrer', async () => {
    await open(fixture.receipts.active.reference, `${fixture.pageOrigin}/pkg/active.json`);
    await checkFiles();
    await shows(files(), 'matching');
    await shows(status(), 'active');
    expect(fixture.packageRequests).toHaveLength(1);
    const headers = fixture.packageRequests[0]?.headers ?? {};
    expect(headers.cookie).toBeUndefined();
    expect(headers.referer).toBeUndefined();
    expect(headers['cache-control']).toBe('no-cache');
  });

  it.each([
    ['altered bytes', 'altered', 'mismatched'],
    ['missing evidence', 'missing', 'incomplete'],
    ['an unsupported (encrypted) export', 'encrypted', 'unsupported'],
    ['a malformed response', 'malformed', 'unavailable'],
    ['a missing file (404)', 'missing-404', 'unavailable'],
    ['a refused cross-origin redirect', 'redirect', 'unavailable'],
  ] as const)('reports %s as %s and never as a match', async (_name, file, word) => {
    await open(fixture.receipts.active.reference, `${fixture.pageOrigin}/pkg/${file}.json`);
    await checkFiles();
    await shows(files(), word);
    expect((await files().innerText()).toLowerCase()).not.toContain('matching');
    // The separately observed chain status is untouched by the package result.
    await shows(status(), 'active');
  });

  it('reports a CORS failure as unavailable, never as a match', async () => {
    const config = fixture.hostConfig({
      packageOrigins: [fixture.pageOrigin, fixture.otherOrigin],
    });
    await open(
      fixture.receipts.active.reference,
      `${fixture.otherOrigin}/pkg/no-cors.json`,
      config,
    );
    await checkFiles();
    await shows(files(), 'unavailable');
    await shows(files(), 'CORS');
    expect((await files().innerText()).toLowerCase()).not.toContain('matching');
    await shows(status(), 'active');
  });

  it('compares against the host-supplied reference, not the file declaration', async () => {
    await open(fixture.receipts.revoked.reference, `${fixture.pageOrigin}/pkg/active.json`);
    await checkFiles();
    await shows(files(), 'mismatched');
    await shows(status(), 'revoked');
  });

  it.each(['oversize', 'gzip-bomb'])('stops reading an oversized response (%s)', async (file) => {
    await open(fixture.receipts.active.reference, `${fixture.pageOrigin}/pkg/${file}.json`);
    await checkFiles();
    await shows(files(), 'unavailable', 30_000);
    await shows(files(), 'larger than the allowed size');
    expect((await files().innerText()).toLowerCase()).not.toContain('matching');
  });

  it('refuses a package-url on an origin the host did not approve, without a request', async () => {
    await open(fixture.receipts.active.reference, `${fixture.otherOrigin}/pkg/active.json`);
    await shows(files(), 'not on an origin the host approved');
    expect(
      await element()
        .getByRole('button', { name: /Check files/ })
        .count(),
    ).toBe(0);
    expect(requests.some((url) => url.startsWith(`${fixture.otherOrigin}/pkg/`))).toBe(false);
    await shows(status(), 'active');
  });

  it('times out a stalled download after thirty seconds', async () => {
    fixture.packages.set('/pkg/stalled.json', {
      body: packageBytes(fixture.receipts.active),
      delayMs: 120_000,
    });
    await page.clock.install();
    await open(fixture.receipts.active.reference, `${fixture.pageOrigin}/pkg/stalled.json`);
    await checkFiles();
    await shows(files(), 'checking');
    await page.clock.fastForward(31_000);
    await shows(files(), 'took too long');
    await shows(files(), 'unavailable');
  });

  it('keeps a completed local check when the RPC fails afterwards', async () => {
    await open(fixture.receipts.active.reference, `${fixture.pageOrigin}/pkg/active.json`);
    await checkFiles();
    await shows(files(), 'matching');
    fixture.rpcMode = 'down';
    await element().getByRole('button', { name: 'Refresh receipt status' }).click();
    await shows(status(), 'unknown');
    await shows(files(), 'matching');
    await shows(status(), 'Historical only');
  });

  it('sends no package data to the RPC and exposes none in the DOM, events or console', async () => {
    await open(fixture.receipts.active.reference, `${fixture.pageOrigin}/pkg/active.json`);
    await checkFiles();
    await shows(files(), 'matching');
    const manifest = fixture.receipts.active.opening.manifest;
    const secrets = [
      ...manifest.artifacts.map((artifact) => artifact.sha256),
      ...manifest.artifacts.map((artifact) => artifact.label),
      fixture.receipts.active.opening.blindingNonce,
    ].filter((value): value is string => typeof value === 'string' && value.length > 4);
    const rpcText = fixture.rpcRecords.map((record) => record.body).join('\n');
    const dom = await page.evaluate(() => {
      const host = document.querySelector('proof-of-review-status');
      return `${document.documentElement.outerHTML}${host?.shadowRoot?.innerHTML ?? ''}${[...(host?.getAttributeNames() ?? [])].join(' ')}`;
    });
    for (const secret of secrets) {
      expect(rpcText).not.toContain(secret);
      expect(dom).not.toContain(secret);
      expect(consoleMessages.join('\n')).not.toContain(secret);
    }
    expect(secrets.length).toBeGreaterThan(0);
  });
});
