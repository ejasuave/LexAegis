/**
 * pnpm exec tsx tooling/scripts/hud-command-check.ts [baseUrl]
 *
 * Keyboard and focus behaviour of the command palette and dock on the empty workbench (no
 * account, no assistant). It proves focus, containment, restoration, draft preservation and
 * routing; it does not exercise a model run, an approval or a signature.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3140';
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
};

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(`${BASE}/review`, { waitUntil: 'networkidle' });

const active = () =>
  page.evaluate<string>(
    `(() => { const a = document.activeElement; return a === null ? '' : (a.getAttribute('data-testid') || a.getAttribute('role') || a.tagName); })()`,
  );
const open = () => page.locator('[role="dialog"][aria-label="Command palette"]').count();

// Time from keydown to a focused input, over repeated opens.
await page.evaluate(`(() => {
  window.__t = { down: 0, deltas: [] };
  document.addEventListener('keydown', (e) => { if (e.key === 'k') window.__t.down = performance.now(); }, true);
  document.addEventListener('focusin', (e) => { if (e.target.getAttribute && e.target.getAttribute('role') === 'combobox') window.__t.deltas.push(performance.now() - window.__t.down); }, true);
})()`);
for (let i = 0; i < 20; i++) {
  await page.keyboard.press('Control+k');
  await page.waitForSelector('[role="combobox"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="dialog"]', { state: 'detached' });
}
const deltas = await page.evaluate<number[]>('window.__t.deltas');
const sorted = [...deltas].sort((a, b) => a - b);
const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? Infinity;
check(
  'Ctrl+K moves focus to the input within 100 ms (p95)',
  deltas.length >= 20 && p95 <= 100,
  `p95 ${p95.toFixed(1)} ms over ${String(deltas.length)}`,
);

// Opener restoration and draft preservation.
await page.getByTestId('aegis-input').fill('my unsent draft');
await page.getByTestId('aegis-input').focus();
await page.keyboard.press('Control+k');
check(
  'palette opens as a modal combobox/listbox',
  (await open()) === 1 &&
    (await page.locator('[role="combobox"][aria-expanded="true"]').count()) === 1 &&
    (await page.locator('[role="dialog"][aria-modal="true"] [role="listbox"]').count()) === 1,
);
check('input is focused', (await active()) === 'combobox');
check(
  'background is inert while open',
  await page.evaluate<boolean>(
    `document.querySelector('.lj-ceiling').closest('[inert]') !== null && document.querySelector('[data-testid="aegis-input"]').closest('[inert]') !== null`,
  ),
);
const first = await page.locator('[role="combobox"]').getAttribute('aria-activedescendant');
await page.keyboard.press('ArrowDown');
const second = await page.locator('[role="combobox"]').getAttribute('aria-activedescendant');
check(
  'ArrowDown moves the announced active option without submitting',
  first !== null && second !== null && first !== second && (await open()) === 1,
);
for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
check(
  'Tab stays inside the modal',
  await page.evaluate<boolean>(`document.activeElement.closest('[role="dialog"]') !== null`),
);
await page.keyboard.press('Escape');
check(
  'Escape closes and restores focus to the dock input',
  (await open()) === 0 && (await active()) === 'aegis-input',
);
check(
  'the unsent draft survives open and close',
  (await page.getByTestId('aegis-input').inputValue()) === 'my unsent draft',
);
await page.keyboard.press('Control+k');
await page.keyboard.press('Control+k');
check('Ctrl+K toggles the palette closed', (await open()) === 0);

// Free text goes to the editable dock; it is not executed.
await page.getByTestId('aegis-input').fill('');
await page.keyboard.press('Control+k');
await page.keyboard.type('what does this clause mean in practice');
await page.keyboard.press('Enter');
await page.waitForSelector('[role="dialog"]', { state: 'detached' });
check(
  'free text moves to the dock for review and is focused there',
  (await page.getByTestId('aegis-input').inputValue()) ===
    'what does this clause mean in practice' && (await active()) === 'aegis-input',
);

// An unknown command suggests, never executes.
await page.getByTestId('aegis-input').fill('');
await page.keyboard.press('Control+k');
await page.keyboard.type('/expain');
await page.keyboard.press('Enter');
await page.waitForSelector('[role="dialog"]', { state: 'detached' });
await page
  .waitForFunction(
    `document.querySelector('[data-testid="aegis-notice"]').innerText.includes('Unknown command')`,
    undefined,
    { timeout: 2000 },
  )
  .catch(() => undefined);
const noticeText = await page.getByTestId('aegis-notice').innerText();
check(
  'unknown command shows a suggestion',
  noticeText.includes('Did you mean /explain'),
  noticeText,
);

// Approval and signing words never become commands.
await page.keyboard.press('Control+k');
await page.keyboard.type('/approve');
const options = await page.locator('[role="option"]').allInnerTexts();
check(
  'no approve or sign command is offered',
  options.every((o) => !/approve|sign/i.test(o.split('\n')[0] ?? '')),
);
await page.keyboard.press('Escape');

// /stop in the dock is accepted even though no run is active, and does not need the assistant.
await page.getByTestId('aegis-input').fill('/stop');
await page.getByTestId('aegis-input').press('Enter');
check(
  '/stop typed in the dock is taken up directly',
  (await page.getByTestId('aegis-input').inputValue()) === '',
);

// Stop control stays visible and large enough.
const stop = await page.getByTestId('aegis-stop').boundingBox();
check(
  'Stop is visible and at least 44x44',
  stop !== null && stop.width >= 44 && stop.height >= 44,
  JSON.stringify(stop),
);

await browser.close();
console.log(failed === 0 ? 'command checks passed' : `${String(failed)} command check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
