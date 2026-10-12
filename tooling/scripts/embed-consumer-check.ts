/**
 * pnpm embed:check-page <url>: loads a plain HTML page that uses proof-of-review-status in headless
 * Chromium, waits for every widget to finish reading, presses Check files on a widget that offers it,
 * and prints one JSON line. It is what a person does by opening the page and pressing the button, done
 * by a script for the automated check. Imports no workspace package; reads nothing but the page.
 */
import { chromium } from 'playwright';

const url = process.argv[2];
if (url === undefined) {
  process.stderr.write('usage: pnpm embed:check-page <url>\n');
  process.exit(2);
}
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(url);
  const widgets = page.locator('proof-of-review-status');
  const lines = async (index: number): Promise<{ status: string; files: string }> => {
    const root = widgets.nth(index).locator('.root');
    const status = await root.locator('.line', { hasText: 'Receipt status' }).innerText();
    const files = await root.locator('.line', { hasText: 'File integrity' }).innerText();
    const word = (text: string): string => text.split('\n')[0]?.replace(/^[^:]+:\s*/, '') ?? '';
    return { status: word(status), files: word(files) };
  };
  const settled = async (index: number): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const busy = await widgets.nth(index).locator('.root').getAttribute('aria-busy');
      if (busy === 'false') return;
      await page.waitForTimeout(200);
    }
    throw new Error('the widget did not finish reading');
  };
  const count = await widgets.count();
  for (let index = 0; index < count; index += 1) await settled(index);
  const statusOnly = await lines(0);
  const before = requests.filter((item) => item.includes('/packages/')).length;
  const withPackage = count > 1 ? 1 : 0;
  await widgets
    .nth(withPackage)
    .getByRole('button', { name: /Check files/ })
    .click();
  await settled(withPackage);
  let checked = await lines(withPackage);
  for (let attempt = 0; attempt < 100 && checked.files === 'checking…'; attempt += 1) {
    await page.waitForTimeout(200);
    checked = await lines(withPackage);
  }
  process.stdout.write(
    `${JSON.stringify({
      statusOnly,
      checked,
      packageRequestsBeforeCheck: before,
      packageRequestsAfterCheck: requests.filter((item) => item.includes('/packages/')).length,
    })}\n`,
  );
} finally {
  await browser.close();
}
