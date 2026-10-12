/** pnpm logo:render: exports submission/assets/logo.svg to submission/assets/logo.png with the repository's Chromium. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from './lib';

const svg = readFileSync(join(ROOT, 'submission/assets/logo.svg'), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 400 } });
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  writeFileSync(join(ROOT, 'submission/assets/logo.png'), await page.screenshot({ type: 'png' }));
} finally {
  await browser.close();
}
console.log('wrote submission/assets/logo.png');
