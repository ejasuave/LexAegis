import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/*
 * Browser helpers. The authenticator is a CDP VIRTUAL authenticator with PRF enabled: it supplies
 * credential behaviour only and never manufactures human-review state. Everything is labelled
 * simulated wherever it is reported.
 */

export async function launch(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

export async function addVirtualAuthenticator(context: BrowserContext, page: Page) {
  await page.addInitScript('window.__name = (target) => target;');
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    } as never,
  });
  return { cdp, authenticatorId };
}

export const has = (page: Page, text: string | RegExp, timeout = 20_000): Promise<boolean> =>
  page
    .getByText(text)
    .first()
    .waitFor({ timeout })
    .then(
      () => true,
      () => false,
    );

export async function waitForTestId(
  page: Page,
  id: string,
  expected: string | RegExp,
  timeout = 20_000,
): Promise<boolean> {
  try {
    await page
      .locator(`[data-testid="${id}"]`)
      .filter({ hasText: expected })
      .first()
      .waitFor({ timeout });
    return true;
  } catch {
    return false;
  }
}

/** Selects a quotation inside the extracted-text region exactly as a reviewer's drag would. */
export const selectQuote = (page: Page, quote: string): Promise<boolean> =>
  page.evaluate((q) => {
    const region = document.querySelector('[aria-label^="Extracted text"]');
    if (region === null) return false;
    const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      const at = text.data.indexOf(q);
      if (at >= 0) {
        const range = document.createRange();
        range.setStart(text, at);
        range.setEnd(text, at + q.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        region.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return true;
      }
    }
    return false;
  }, quote);

export async function confirmFact(
  page: Page,
  field: string,
  slot: string,
  quote: string,
): Promise<boolean> {
  await page.getByLabel(/^Field/).selectOption({ label: field });
  await page.getByLabel(/^Slot/).fill(slot);
  const selected = await selectQuote(page, quote);
  await page.getByRole('button', { name: 'Confirm fact' }).click();
  return selected && (await has(page, 'Fact confirmed'));
}

export const noHorizontalScroll = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

export const SYNTHETIC_FACTS = [
  ['Payment total (pence)', 'total', '24,000'],
  ['Payment instalment (pence)', 'i1', '10,000'],
  ['Payment instalment (pence)', 'i2', '12,000'],
  ['Payment basis (gross or net)', 'basis', 'gross'],
] as const;
