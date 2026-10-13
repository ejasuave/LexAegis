/**
 * pnpm exec tsx tooling/scripts/hud-canvas-check.ts [baseUrl]
 *
 * Canvas lifecycle and contrast on the empty workbench: tier, frame cap, hidden-page and
 * reduced-motion behaviour, Effects Off and forced colours, the quiet-zone mask measured on the
 * canvas's own pixels, and repeated resize and mode switching without a growing loop. It does not
 * test a running or alert scene (those need synthetic fixtures) and is not a flash-safety audit.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { ROOT } from './lib';

const BASE = process.argv[2] ?? 'http://localhost:3140';
const OUT = join(ROOT, 'docs', 'evidence', 'ui-blueprint');
mkdirSync(OUT, { recursive: true });

interface Stats {
  framesDrawn: number;
  loopRunning: boolean;
  tier: string;
  filaments: number;
  liveParticles: number;
  mode: string;
  backingPixels: number;
  lastP95Ms: number | null;
}

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
};

const stats = (page: Page) =>
  page.evaluate<Stats | null>(
    `(() => { const c = document.querySelector('.lj-art canvas'); return c === null ? null : c.ljStats; })()`,
  );
const canvases = (page: Page) => page.locator('.lj-art canvas').count();
const wait = (page: Page, ms: number) => page.waitForTimeout(ms);

async function open(
  browser: Browser,
  options: {
    width?: number;
    height?: number;
    path?: string;
    reducedMotion?: 'reduce';
    forcedColors?: 'active';
  } = {},
) {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    reducedMotion: options.reducedMotion,
    forcedColors: options.forcedColors,
  });
  const page = await context.newPage();
  await page.goto(`${BASE}${options.path ?? '/review'}`, { waitUntil: 'networkidle' });
  await wait(page, 400);
  return { context, page };
}

const browser = await chromium.launch();

const FIXTURE = (state: string) => `/hud-fixtures?state=${state}`;

/** Brightest composited channel inside every registered reading region, from the canvas's own pixels. */
const regionWorst = (page: Page) =>
  page.evaluate<{ max: number; regions: number; amberInside: number }>(`(() => {
    const canvas = document.querySelector('.lj-art canvas');
    const g = canvas.getContext('2d');
    const scale = canvas.width / canvas.getBoundingClientRect().width;
    let max = 0;
    let amberInside = 0;
    const regions = document.querySelectorAll('[data-hud-quiet]');
    for (const el of regions) {
      const r = el.getBoundingClientRect();
      const x = Math.max(0, Math.round((r.left + 2) * scale));
      const y = Math.max(0, Math.round((r.top + 2) * scale));
      const w = Math.min(canvas.width - x, Math.round((r.width - 4) * scale));
      const h = Math.min(canvas.height - y, Math.round((r.height - 4) * scale));
      if (w <= 0 || h <= 0) continue;
      const d = g.getImageData(x, y, w, h).data;
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3] / 255;
        const R = d[i] * a, G = d[i + 1] * a, B = d[i + 2] * a;
        max = Math.max(max, R, G, B);
        if (R > 120 && G > 90 && B < 90) amberInside++;
      }
    }
    return { max, regions: regions.length, amberInside };
  })()`);

/** Amber pixels anywhere on the canvas: proof an alert branch was drawn at all. */
const amberPixels = (page: Page) =>
  page.evaluate<number>(`(() => {
    const canvas = document.querySelector('.lj-art canvas');
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128 && d[i] > 180 && d[i + 1] > 140 && d[i + 2] < 90) n++;
    return n;
  })()`);

// ---- Fixture scenes -----------------------------------------------------------------------
{
  const { context, page } = await open(browser, { path: FIXTURE('idle') });
  const s0 = await stats(page);
  check(
    'idle fixture: one canvas, standard tier, 320 filaments',
    (await canvases(page)) === 1 && s0?.tier === 'standard' && s0.filaments === 320,
    JSON.stringify(s0),
  );
  const b = (await stats(page))?.framesDrawn ?? 0;
  await wait(page, 1000);
  const a = (await stats(page))?.framesDrawn ?? 0;
  check(
    'idle drift stays at or under the 20 fps cap',
    a - b >= 8 && a - b <= 24,
    `${String(a - b)} frames in 1 s`,
  );
  await context.close();
}
for (const state of [
  'idle',
  'queued',
  'awaiting',
  'running',
  'alert',
  'stopping',
  'offline',
  'stale',
  'locked',
  'pending',
  'failed',
  'confirmed',
]) {
  const { context, page } = await open(browser, { path: FIXTURE(state) });
  await wait(page, 600);
  const worst = await regionWorst(page);
  check(
    `${state}: reading regions stay at or below #0D1117 on the composited art`,
    worst.regions >= 3 && worst.max <= 0x17,
    `max ${worst.max.toFixed(1)} over ${String(worst.regions)} regions`,
  );
  const st = await stats(page);
  if (state === 'running' || state === 'alert') {
    check(
      `${state}: inward particles only while a tool runs, within the 64 cap`,
      (st?.liveParticles ?? 0) > 0 && (st?.liveParticles ?? 0) <= 64,
      JSON.stringify(st),
    );
  }
  if (
    [
      'queued',
      'awaiting',
      'offline',
      'stale',
      'locked',
      'failed',
      'pending',
      'confirmed',
      'stopping',
    ].includes(state)
  ) {
    check(
      `${state}: no running tool, so no particles`,
      (st?.liveParticles ?? 0) === 0,
      JSON.stringify(st),
    );
  }
  if (['queued', 'awaiting', 'offline', 'stale', 'failed'].includes(state)) {
    check(
      `${state}: a static scene with no render loop`,
      st?.loopRunning === false,
      JSON.stringify(st),
    );
  }
  if (state === 'alert') {
    const amber = await amberPixels(page);
    check(
      'alert: amber branches reach the visible findings, none inside a reading region',
      amber > 40 && worst.amberInside === 0,
      `${String(amber)} amber px, ${String(worst.amberInside)} inside`,
    );
    check(
      'alert: the DOM says how many findings need a decision',
      (await page.getByTestId('fixture-unresolved').innerText()).includes('4 unresolved'),
    );
  }
  if (state === 'locked') {
    check(
      'locked: private anchors are cleared at once',
      (await amberPixels(page)) === 0 &&
        (await page.getByTestId('fixture-unresolved').innerText()).startsWith('0 unresolved'),
    );
  }
  if (state === 'running' || state === 'alert' || state === 'locked' || state === 'idle') {
    await page.screenshot({ path: join(OUT, `stage5-fixture-${state}-1440x900.png`) });
  }
  await context.close();
}
{
  const { context, page } = await open(browser, { path: FIXTURE('running') });
  await wait(page, 500);
  const f0 = (await stats(page))?.framesDrawn ?? 0;
  await wait(page, 1000);
  const f1 = (await stats(page))?.framesDrawn ?? 0;
  check(
    'running draws at no more than 60 fps',
    f1 - f0 > 10 && f1 - f0 <= 64,
    `${String(f1 - f0)} frames in 1 s`,
  );
  const p95 = (await stats(page))?.lastP95Ms ?? null;
  console.log(
    `note  canvas work p95 on this machine: ${p95 === null ? 'not yet measured' : `${p95.toFixed(2)} ms`}`,
  );
  await context.close();
}

// ---- Full effects ------------------------------------------------------------------------
{
  const { context, page } = await open(browser);
  const s0 = await stats(page);
  check(
    'one canvas, standard tier, 320 filaments',
    (await canvases(page)) === 1 && s0?.tier === 'standard' && s0.filaments === 320,
    JSON.stringify(s0),
  );
  check(
    'backing store within four million pixels',
    s0 !== null && s0.backingPixels <= 4_000_000,
    String(s0?.backingPixels),
  );
  await page.screenshot({ path: join(OUT, 'stage5-command-1440x900.png') });
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await wait(page, 400);
  await page.screenshot({ path: join(OUT, 'stage5-review-1440x900.png') });

  // Hidden page and churn use an animated scene, so a leaked loop would show.
  await page.goto(`${BASE}${FIXTURE('idle')}`, { waitUntil: 'networkidle' });
  await wait(page, 500);
  // Hidden page: the loop stops and resumes without a backlog.
  await page.evaluate(
    `(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); })()`,
  );
  await wait(page, 200);
  const h0 = (await stats(page))?.framesDrawn ?? 0;
  await wait(page, 600);
  const h1 = (await stats(page))?.framesDrawn ?? 0;
  check('no frames while the page is hidden', h1 === h0, `${String(h0)} -> ${String(h1)}`);
  await page.evaluate(
    `(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); })()`,
  );
  await wait(page, 500);
  check('drawing resumes when visible again', ((await stats(page))?.framesDrawn ?? 0) > h1);

  // Churn: effect changes and resizes must not stack loops or canvases.
  for (let i = 0; i < 12; i++) {
    await page.getByLabel('Effects').selectOption(i % 2 === 0 ? 'reduced' : 'system');
    await page.setViewportSize({ width: 1440 - (i % 3) * 120, height: 900 - (i % 2) * 80 });
  }
  await page.getByLabel('Effects').selectOption('system');
  await page.setViewportSize({ width: 1440, height: 900 });
  await wait(page, 500);
  const c0 = (await stats(page))?.framesDrawn ?? 0;
  await wait(page, 1000);
  const c1 = (await stats(page))?.framesDrawn ?? 0;
  check(
    'after repeated resize and effects changes there is still one canvas and one loop',
    (await canvases(page)) === 1 && c1 - c0 <= 24,
    `${String(c1 - c0)} frames in 1 s`,
  );

  // Effects Off removes the canvas and keeps the SVG marker; the choice persists.
  await page.getByLabel('Effects').selectOption('off');
  await wait(page, 300);
  check('Effects Off removes the canvas', (await canvases(page)) === 0);
  await page.reload({ waitUntil: 'networkidle' });
  await wait(page, 300);
  check(
    'Effects Off persists and stays off after reload',
    (await canvases(page)) === 0 && (await page.getByLabel('Effects').inputValue()) === 'off',
  );
  check(
    'the SVG status marker returns when the canvas is off',
    (await page.evaluate<string>(
      `getComputedStyle(document.querySelector('.lj-orb svg')).visibility`,
    )) === 'visible',
  );
  await page.getByLabel('Effects').selectOption('reduced');
  await wait(page, 500);
  const r = await stats(page);
  check(
    'Reduced draws a static simplified field with no loop',
    r?.mode === 'reduced' && r.filaments === 80 && !r.loopRunning,
    JSON.stringify(r),
  );
  const rf0 = r?.framesDrawn ?? 0;
  await wait(page, 600);
  check(
    'Reduced draws no further frames while nothing changes',
    ((await stats(page))?.framesDrawn ?? 0) === rf0,
  );
  await context.close();
}

// ---- Operating-system preferences ------------------------------------------------------------
{
  const { context, page } = await open(browser, { reducedMotion: 'reduce' });
  const s = await stats(page);
  check(
    'prefers-reduced-motion starts static before any animated frame',
    s?.mode === 'reduced' && !s.loopRunning,
    JSON.stringify(s),
  );
  const f0 = s?.framesDrawn ?? 0;
  await wait(page, 700);
  check(
    'reduced motion keeps no running animation loop',
    ((await stats(page))?.framesDrawn ?? 0) === f0,
  );
  await context.close();
}
{
  const { context, page } = await open(browser, { forcedColors: 'active' });
  check('forced colours remove the decorative canvas', (await canvases(page)) === 0);
  await context.close();
}

// ---- Compact tier ----------------------------------------------------------------------------
{
  const { context, page } = await open(browser, { width: 390, height: 844 });
  const s = await stats(page);
  check(
    'a phone starts on the compact tier with 80 filaments and a static idle scene',
    s?.tier === 'compact' && s.filaments === 80 && !s.loopRunning,
    JSON.stringify(s),
  );
  await context.close();
}

await browser.close();
console.log(failed === 0 ? 'canvas checks passed' : `${String(failed)} canvas check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
