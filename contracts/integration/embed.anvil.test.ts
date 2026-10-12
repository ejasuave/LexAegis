import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { attributesOf, pageHtml, startEmbedFixture, type EmbedFixture } from './embed-fixture';

/*
 * LOCAL COMPATIBILITY EVIDENCE ONLY. The BUILT widget bundle runs in real headless Chromium from a
 * plain HTML page, with no LexAegis application, login, Mera, Qwen or indexer. Registry reads go to
 * the unchanged compiled registry on a throwaway Anvil chain through a recording proxy; the active,
 * revoked, superseded and not-found receipts come from real local transactions. Failure cases
 * (unavailable RPC, wrong network, untrusted deployment) are labelled fault injection. Not a Monad
 * deployment and not live evidence.
 */

let fixture: EmbedFixture;
let browser: Browser;
let page: Page;
let pageCounter = 0;
const requests: string[] = [];

const element = (index = 0): Locator => page.locator('proof-of-review-status').nth(index);
const status = (index = 0): Locator =>
  element(index).locator('.line', { hasText: 'Receipt status' });
const files = (index = 0): Locator =>
  element(index).locator('.line', { hasText: 'File integrity' });

const shows = (locator: Locator, text: string): Promise<void> =>
  expect.poll(() => locator.innerText(), { timeout: 20_000 }).toContain(text);
const lacks = async (locator: Locator, text: string): Promise<void> => {
  expect(await locator.innerText()).not.toContain(text);
};
const attr = (locator: Locator, name: string, value: string): Promise<void> =>
  expect.poll(() => locator.getAttribute(name), { timeout: 20_000 }).toBe(value);
const visible = (locator: Locator): Promise<void> =>
  expect.poll(() => locator.isVisible(), { timeout: 20_000 }).toBe(true);

async function open(markup: string, config: unknown = fixture.hostConfig()): Promise<void> {
  pageCounter += 1;
  const path = `/t${String(pageCounter)}.html`;
  fixture.pages.set(path, pageHtml(config, markup));
  await page.goto(`${fixture.pageOrigin}${path}`);
}

const settled = async (index = 0): Promise<void> => {
  await expect
    .poll(async () => (await element(index).locator('.root').getAttribute('aria-busy')) ?? 'x', {
      timeout: 20_000,
    })
    .toBe('false');
};

beforeAll(async () => {
  fixture = await startEmbedFixture();
  browser = await chromium.launch();
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
  page = await (await browser.newContext()).newPage();
  page.on('request', (request) => requests.push(request.url()));
});

describe('widget lifecycle states (real local transactions)', () => {
  it.each([
    ['active', 'active'],
    ['revoked', 'revoked'],
    ['superseded', 'superseded'],
    ['notFound', 'not found'],
  ] as const)('%s receipt renders "%s"', async (key, word) => {
    await open(
      `<proof-of-review-status ${attributesOf(fixture.receipts[key].reference)}></proof-of-review-status>`,
    );
    await settled();
    await shows(status(), word);
    await shows(files(), 'not checked — no package supplied');
    // Never an overall verdict, whatever the lifecycle.
    const text = (await element().innerText()).toLowerCase();
    for (const forbidden of ['valid', 'verified', 'trusted', 'approved'])
      expect(text).not.toContain(forbidden);
  });

  it('shows an Active record as a current observation, with block context', async () => {
    await open(
      `<proof-of-review-status ${attributesOf(fixture.receipts.active.reference)}></proof-of-review-status>`,
    );
    await settled();
    await shows(status(), 'Observed');
    await shows(status(), 'at block');
    await shows(status(), 'not a check of the files');
  });
});

describe('unknown is never not found (fault injection)', () => {
  it('reports unknown when the RPC is unavailable', async () => {
    fixture.rpcMode = 'down';
    await open(
      `<proof-of-review-status ${attributesOf(fixture.receipts.notFound.reference)}></proof-of-review-status>`,
    );
    await settled();
    await shows(status(), 'unknown');
    await lacks(status(), 'not found');
  });

  it('reports unknown on the wrong network', async () => {
    fixture.rpcMode = 'wrong-chain';
    await open(
      `<proof-of-review-status ${attributesOf(fixture.receipts.active.reference)}></proof-of-review-status>`,
    );
    await settled();
    await shows(status(), 'unknown');
    await lacks(status(), 'active');
  });

  it('reports unknown when the registry is not a trusted deployment', async () => {
    const config = fixture.hostConfig();
    await open(
      `<proof-of-review-status ${attributesOf({ ...fixture.receipts.active.reference, registryAddress: '0x9999999999999999999999999999999999999999' })}></proof-of-review-status>`,
      config,
    );
    await settled();
    await shows(status(), 'unknown');
    await shows(status(), 'not a deployment the host trusts');
    expect(fixture.rpcRecords).toHaveLength(0);
  });

  it('reports unknown with a configuration reason when the host configured nothing', async () => {
    await open(
      `<proof-of-review-status ${attributesOf(fixture.receipts.active.reference)}></proof-of-review-status>`,
      {},
    );
    await settled();
    await shows(status(), 'unknown');
    await shows(status(), 'configuration');
    expect(fixture.rpcRecords).toHaveLength(0);
  });
});

describe('interaction, accessibility and layout', () => {
  it('refreshes from the keyboard with a visible focus indicator', async () => {
    await open(
      `<proof-of-review-status ${attributesOf(fixture.receipts.active.reference)}></proof-of-review-status>`,
    );
    await settled();
    const before = fixture.rpcRecords.length;
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const host = document.querySelector('proof-of-review-status');
      const active = host?.shadowRoot?.activeElement;
      return active === null || active === undefined
        ? null
        : { tag: active.tagName, text: active.textContent };
    });
    expect(focused).toEqual({ tag: 'BUTTON', text: 'Refresh' });
    const outline = await page.evaluate(() => {
      const button = document.querySelector('proof-of-review-status')?.shadowRoot?.activeElement;
      return button === null || button === undefined ? '' : getComputedStyle(button).outlineStyle;
    });
    expect(outline).not.toBe('none');
    await page.keyboard.press('Enter');
    await expect.poll(() => fixture.rpcRecords.length).toBeGreaterThan(before);
    await settled();
    await shows(status(), 'active');
  });

  it('exposes a polite live region and aria-busy while checking', async () => {
    fixture.rpcMode = 'slow-first';
    await open(
      `<proof-of-review-status ${attributesOf(fixture.receipts.active.reference)}></proof-of-review-status>`,
    );
    await attr(element().locator('.root'), 'aria-busy', 'true');
    await shows(status(), 'checking');
    await settled();
    const region = element().locator('[role="status"]');
    await attr(region, 'aria-live', 'polite');
    await shows(region, 'Receipt status: active');
  });

  it('keeps the reference and controls visible at 320 CSS pixels, with reduced motion', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 320, height: 640 });
    await open(
      `<proof-of-review-status ${attributesOf(fixture.receipts.active.reference)}></proof-of-review-status>`,
    );
    await settled();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await visible(element().getByRole('button', { name: 'Refresh receipt status' }));
    await shows(element().locator('dl.ref'), fixture.receipts.active.reference.commitment);
    const transition = await page.evaluate(() => {
      const button = document
        .querySelector('proof-of-review-status')
        ?.shadowRoot?.querySelector('button');
      return button === null || button === undefined
        ? ''
        : getComputedStyle(button).transitionDuration;
    });
    expect(transition).toBe('0s');
  });
});

describe('generations, multiple elements and registration', () => {
  it('discards a stale in-flight read when attributes change', async () => {
    fixture.rpcMode = 'slow-first';
    await open(
      `<proof-of-review-status id="w" ${attributesOf(fixture.receipts.active.reference)}></proof-of-review-status>`,
    );
    await shows(status(), 'checking');
    // Change to a different receipt while the first (slow) read is still pending.
    await page.evaluate((reference) => {
      document.getElementById('w')?.setAttribute('commitment', reference);
    }, fixture.receipts.revoked.reference.commitment);
    await shows(status(), 'checking');
    await settled();
    await page.waitForTimeout(1600);
    await shows(status(), 'revoked');
    await lacks(status(), 'active');
  });

  it('clears the current result immediately when an attribute changes', async () => {
    await open(
      `<proof-of-review-status id="w" ${attributesOf(fixture.receipts.active.reference)}></proof-of-review-status>`,
    );
    await settled();
    await shows(status(), 'active');
    fixture.rpcMode = 'hang';
    await page.evaluate((reference) => {
      document.getElementById('w')?.setAttribute('commitment', reference);
    }, fixture.receipts.revoked.reference.commitment);
    await shows(status(), 'checking');
    await lacks(status(), 'active');
  });

  it('keeps several elements independent', async () => {
    await open(
      ['active', 'revoked', 'superseded']
        .map(
          (key) =>
            `<proof-of-review-status ${attributesOf(fixture.receipts[key as 'active'].reference)}></proof-of-review-status>`,
        )
        .join('\n'),
    );
    await settled(0);
    await settled(1);
    await settled(2);
    await shows(status(0), 'active');
    await shows(status(1), 'revoked');
    await shows(status(2), 'superseded');
  });

  it('cancels on disconnect and reads again on reconnect', async () => {
    await open(
      `<proof-of-review-status id="w" ${attributesOf(fixture.receipts.active.reference)}></proof-of-review-status>`,
    );
    await settled();
    await page.evaluate(() => {
      const node = document.getElementById('w') as HTMLElement;
      (window as unknown as { saved: HTMLElement }).saved = node;
      node.remove();
    });
    const before = fixture.rpcRecords.length;
    await page.waitForTimeout(300);
    expect(fixture.rpcRecords.length).toBe(before);
    await page.evaluate(() =>
      document.body.append((window as unknown as { saved: HTMLElement }).saved),
    );
    await expect.poll(() => fixture.rpcRecords.length).toBeGreaterThan(before);
    await settled();
    await shows(status(), 'active');
  });

  it('registers safely more than once and never replaces a foreign definition', async () => {
    await open(
      `<proof-of-review-status ${attributesOf(fixture.receipts.active.reference)}></proof-of-review-status>`,
    );
    await settled();
    const before = fixture.rpcRecords.length;
    const again = await page.evaluate(
      `import('/embed.js').then((module) => module.registerProofOfReviewStatus(${JSON.stringify(fixture.hostConfig())}))`,
    );
    expect(again).toMatchObject({ ok: true, alreadyRegistered: true });
    // Re-registering replaces the configuration: the connected element reads again, once defined.
    await expect.poll(() => fixture.rpcRecords.length).toBeGreaterThan(before);
    await settled();
    await shows(status(), 'active');
    // A page that defines the tag first with its own class keeps it.
    const other = await browser.newContext().then((context) => context.newPage());
    pageCounter += 1;
    const path = `/t${String(pageCounter)}.html`;
    fixture.pages.set(
      path,
      `<!doctype html><script type="module">
        customElements.define('proof-of-review-status', class extends HTMLElement {});
        const { registerProofOfReviewStatus } = await import('/embed.js');
        window.result = registerProofOfReviewStatus({});
      </script>`,
    );
    await other.goto(`${fixture.pageOrigin}${path}`);
    await other.waitForFunction(
      () => (window as unknown as { result?: unknown }).result !== undefined,
    );
    expect(await other.evaluate(() => (window as unknown as { result: unknown }).result)).toEqual({
      ok: false,
      reason: 'TAG_TAKEN_BY_OTHER_DEFINITION',
    });
  });
});

describe('network boundary', () => {
  it('makes no request before configuration is registered and none but static assets and the RPC afterwards', async () => {
    await open(
      `<proof-of-review-status ${attributesOf(fixture.receipts.active.reference)}></proof-of-review-status>`,
    );
    await settled();
    const origins = new Set(requests.map((url) => new URL(url).origin));
    expect([...origins].sort()).toEqual(
      [fixture.pageOrigin, new URL(fixture.rpcUrl).origin].sort(),
    );
    const methods = new Set(fixture.rpcRecords.map((record) => record.method));
    for (const method of methods)
      expect(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call']).toContain(method);
    expect(
      requests.every((url) => !/(qwen|envio|alchemy|analytics|font|\.png|\.svg|\.woff)/i.test(url)),
    ).toBe(true);
    const walletCalls = await page.evaluate(() => 'ethereum' in window);
    expect(walletCalls).toBe(false);
  });
});

export type { Locator };
