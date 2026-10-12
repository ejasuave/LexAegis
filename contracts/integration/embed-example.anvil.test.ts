import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  generateEmbedExample,
  serveDirectory,
  type GeneratedExample,
} from '../scripts/embed-example';

/*
 * LOCAL COMPATIBILITY EVIDENCE ONLY. The committed template examples/embed/index.html, filled in by
 * the real setup (throwaway Anvil chain, unchanged registry, real local transactions), works as a
 * plain page with only its own static assets and the local RPC: no LexAegis application, login,
 * Mera, Qwen or indexer. Not a live deployment.
 */

let example: GeneratedExample;
let browser: Browser;
let page: Page;
let scratch: string;
let origin: string;
let close: () => void;
const requests: string[] = [];

const widgets = () => page.locator('proof-of-review-status');
const text = (index: number) => widgets().nth(index).locator('.root').innerText();

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'embed-example-'));
  const outDir = join(scratch, 'generated');
  const served = await serveDirectory(outDir);
  origin = served.origin;
  close = () => served.server.closeAllConnections();
  example = await generateEmbedExample({ origin, outDir });
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`${origin}/index.html`);
}, 180_000);

afterAll(async () => {
  await browser.close();
  close();
  await example.stop();
  rmSync(scratch, { recursive: true, force: true });
});

const settledAll = () =>
  expect
    .poll(
      async () => {
        const states = await widgets().evaluateAll((nodes) =>
          nodes.map((node) => node.shadowRoot?.querySelector('.root')?.getAttribute('aria-busy')),
        );
        return states.every((state) => state === 'false');
      },
      { timeout: 30_000 },
    )
    .toBe(true);

describe('examples/embed (plain HTML, generated from real setup output)', () => {
  it('shows the lifecycle states from the real local registry, with no application', async () => {
    await settledAll();
    expect(await widgets().count()).toBe(5);
    expect(await text(0)).toContain('Receipt status: active');
    expect(await text(0)).toContain('not checked — no package supplied');
    expect(await text(1)).toContain('Receipt status: active');
    expect(await text(2)).toContain('Receipt status: revoked');
    expect(await text(3)).toContain('Receipt status: superseded');
    expect(await text(4)).toContain('Receipt status: not found');
  });

  it('checks the deliberately published synthetic package only when asked', async () => {
    expect(requests.some((url) => url.includes('/packages/'))).toBe(false);
    await widgets()
      .nth(1)
      .getByRole('button', { name: /Check files/ })
      .click();
    await expect.poll(() => text(1), { timeout: 20_000 }).toContain('File integrity: matching');
    expect(requests.filter((url) => url.includes('/packages/'))).toEqual([
      `${origin}/packages/active.json`,
    ]);
  });

  it('contacts only its own static origin and the local RPC', () => {
    const origins = new Set(requests.map((url) => new URL(url).origin));
    expect([...origins].sort()).toEqual([origin, example.chain.local.rpcUrl].sort());
  });

  it('ships a bundle without signer, key or application code', async () => {
    const response = await page.request.get(`${origin}/proof-of-review-embed.min.js`);
    const body = await response.text();
    for (const forbidden of [
      'mnemonicToAccount',
      'privateKeyToAccount',
      'test test test test',
      'eth_sendRawTransaction',
      'eth_requestAccounts',
      'next/',
      'react-dom',
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });
});
