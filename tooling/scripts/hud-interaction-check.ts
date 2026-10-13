/**
 * pnpm exec tsx tooling/scripts/hud-interaction-check.ts [baseUrl]
 *
 * Interaction layer on the empty workbench: cursors (pointer on controls, not-allowed on disabled
 * ones, text on inputs), hover only inside (hover: hover), pointerdown press feedback, the visible
 * focus ring, and that reduced motion and Effects Off remove transforms and animation while
 * hover and focus stay. Nothing positive or pending shows on a fresh load (no replay, no fake
 * loading). It does not drive real pending work or a verified event: those need a live vault.
 */
import { chromium, type Browser, type Page } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3140';
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
};

const style = (page: Page, selector: string, property: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

async function open(browser: Browser, reducedMotion?: 'reduce') {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion,
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/review`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  return { context, page };
}

/** The transform a button has while the pointer is held down on it. */
async function pressedTransform(page: Page): Promise<string> {
  const target = page
    .locator('button:not(:disabled, [aria-disabled=true])', { hasText: 'Review' })
    .first();
  const box = await target.boundingBox();
  if (box === null) return 'no-box';
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(250);
  const transform = await target.evaluate((el) => getComputedStyle(el).transform);
  await page.mouse.up();
  return transform;
}

const browser = await chromium.launch();
try {
  const { context, page } = await open(browser);
  check(
    'data-effects is full by default',
    parseFloat(await style(page, '.lj-app', '--lj-fx-press-scale')) === 0.98,
  );
  check(
    'button cursor is pointer',
    (await style(page, 'button:not(:disabled, [aria-disabled=true])', 'cursor')) === 'pointer',
  );
  check('select cursor is pointer', (await style(page, 'select', 'cursor')) === 'pointer');
  check('nav link cursor is pointer', (await style(page, 'a[href]', 'cursor')) === 'pointer');
  check(
    'summary or tab cursor is pointer',
    (await page.locator('summary, [role=tab]').count()) === 0 ||
      (await style(page, 'summary, [role=tab]', 'cursor')) === 'pointer',
  );
  const disabled = await page.locator('button:is(:disabled, [aria-disabled=true])').count();
  check('a disabled control exists to test', disabled > 0);
  if (disabled > 0) {
    check(
      'disabled cursor is not-allowed',
      (await style(page, 'button:is(:disabled, [aria-disabled=true])', 'cursor')) === 'not-allowed',
    );
    check(
      'disabled is dimmed',
      Number(await style(page, 'button:is(:disabled, [aria-disabled=true])', 'opacity')) < 1,
    );
  }
  const textField = await page.locator('textarea, input[type=text], input:not([type])').count();
  if (textField > 0) {
    check(
      'text field cursor is text',
      (await style(page, 'textarea, input[type=text], input:not([type])', 'cursor')) === 'text',
    );
  }
  check(
    'no cursor:progress on the page when nothing is pending',
    (await page.locator('[aria-busy=true]').count()) === 0,
  );

  const hoverOutside = await page.evaluate<string[]>(`(() => {
    const bad = [];
    const visit = (rules, inHover) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSMediaRule) {
          visit(rule.cssRules, inHover || /hover:\\s*hover/.test(rule.conditionText));
        } else if (rule instanceof CSSStyleRule) {
          if (rule.selectorText.includes(':hover') && !inHover) bad.push(rule.selectorText);
        } else if ('cssRules' in rule) {
          visit(rule.cssRules, inHover);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try { visit(sheet.cssRules, false); } catch (e) {}
    }
    return bad;
  })()`);
  check(
    'every :hover rule sits inside @media (hover: hover)',
    hoverOutside.length === 0,
    hoverOutside.slice(0, 3).join(' | '),
  );

  const pressed = await pressedTransform(page);
  check('press scales the control on pointerdown', pressed.startsWith('matrix(0.98'), pressed);

  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const ring = await page.evaluate<{ style: string; width: string } | null>(
    `(() => { const el = document.activeElement; if (el === null) return null; const s = getComputedStyle(el); return { style: s.outlineStyle, width: s.outlineWidth }; })()`,
  );
  check(
    'focus-visible ring is drawn',
    ring !== null && ring.style === 'solid' && parseFloat(ring.width) >= 2,
    JSON.stringify(ring),
  );

  check(
    'no positive label on a fresh load (no replay)',
    (await page.locator('[data-testid=positive-label]').count()) === 0,
  );
  check(
    'no loading status on a fresh load (no fake loading)',
    (await page.locator('[data-testid=loading-status]').count()) === 0,
  );

  // Effects Off through the real control.
  await page
    .locator('select')
    .filter({ has: page.locator('option[value=off]') })
    .selectOption('off');
  await page.waitForTimeout(200);
  check(
    'Effects Off sets data-effects=off',
    (await page.locator('.lj-app').getAttribute('data-effects')) === 'off',
  );
  check('Effects Off removes the canvas', (await page.locator('.lj-art canvas').count()) === 0);
  const offPress = await pressedTransform(page);
  check(
    'Effects Off: no press transform',
    offPress === 'none' || offPress === 'matrix(1, 0, 0, 1, 0, 0)',
    offPress,
  );
  check(
    'Effects Off: pointer cursor stays',
    (await style(page, 'button:not(:disabled, [aria-disabled=true])', 'cursor')) === 'pointer',
  );
  await context.close();

  const reduced = await open(browser, 'reduce');
  check(
    'reduced motion sets data-effects=reduced',
    (await reduced.page.locator('.lj-app').getAttribute('data-effects')) === 'reduced',
  );
  const reducedPress = await pressedTransform(reduced.page);
  check('reduced motion: no press transform', reducedPress === 'none', reducedPress);
  check(
    'reduced motion: transitions are off',
    (
      await style(
        reduced.page,
        'button:not(:disabled, [aria-disabled=true])',
        'transition-duration',
      )
    )
      .split(',')
      .every((d) => parseFloat(d) === 0),
  );
  check(
    'reduced motion: cursor stays pointer',
    (await style(reduced.page, 'button:not(:disabled, [aria-disabled=true])', 'cursor')) ===
      'pointer',
  );
  await reduced.context.close();
} finally {
  await browser.close();
}
console.log(failed === 0 ? '\nall passed' : `\n${String(failed)} failed`);
process.exit(failed === 0 ? 0 : 1);
