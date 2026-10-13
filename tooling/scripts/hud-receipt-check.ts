/**
 * pnpm exec tsx tooling/scripts/hud-receipt-check.ts [baseUrl]
 *
 * The receipt-confirmation effect on the gated synthetic fixtures page: a validated live signal
 * plays once; duplicates, history replay, other matters, hidden tabs, reduced motion and bursts do
 * not; a withdrawal leaves a persistent correction. It drives the real gate and renderer through
 * fixture buttons. The transaction controller's own verification is covered by unit tests, and
 * this is not a photosensitivity assessment.
 */
import { chromium, type Page } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3140';
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
};

interface Wash {
  receivedAtMs: number;
  firstFrameAtMs: number;
}
interface Stats {
  wash: Wash | null;
  framesDrawn: number;
}
const stats = (page: Page) =>
  page.evaluate<Stats>(`document.querySelector('.lj-art canvas').ljStats`);
const text = (page: Page, id: string) => page.getByTestId(id).innerText();
const logCount = async (page: Page) =>
  Number((await text(page, 'fixture-log')).replace(/\D+/g, ''));
const click = (page: Page, key: string) => page.getByTestId(`fx-${key}`).click();
const label = (page: Page) => page.locator('[data-testid="receipt-label"]');

/**
 * Samples the canvas on every frame for a while. The wash is measured on pixels that are pure
 * empty (transparent, unmasked) before it starts (so animated filaments cannot be mistaken for it); the reading regions
 * are measured from the seventh frame, once the measured layout has caught up with the click.
 */
const sampleEnvelope = (page: Page, ms: number) =>
  page.evaluate<{
    blackPeak: number;
    blackPoints: number;
    regionMax: number;
    frames: number;
  }>(`(async () => {
    const canvas = document.querySelector('.lj-art canvas');
    const g = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const read = () => g.getImageData(0, 0, W, H).data;
    const first = read();
    await new Promise((r) => setTimeout(r, 120));
    const second = read();
    const points = [];
    for (let y = 4; y < H; y += 23) for (let x = 4; x < W; x += 29) {
      const i = (y * W + x) * 4;
      if (first[i + 3] + second[i + 3] === 0) points.push(i);
    }
    const regions = [...document.querySelectorAll('[data-hud-quiet]')];
    const scale = W / canvas.getBoundingClientRect().width;
    const regionMax = (d) => {
      let max = 0;
      for (const el of regions) {
        const r = el.getBoundingClientRect();
        const x = Math.max(0, Math.round((r.left + 2) * scale)), y = Math.max(0, Math.round((r.top + 2) * scale));
        const w = Math.min(W - x, Math.round((r.width - 4) * scale)), h = Math.min(H - y, Math.round((r.height - 4) * scale));
        if (w <= 0 || h <= 0) continue;
        for (let yy = y; yy < y + h; yy += 3) for (let xx = x; xx < x + w; xx += 3) {
          const i = (yy * W + xx) * 4; const a = d[i + 3] / 255;
          max = Math.max(max, d[i] * a, d[i + 1] * a, d[i + 2] * a);
        }
      }
      return max;
    };
    let blackPeak = 0, rmax = 0, frames = 0;
    const end = performance.now() + ${String(ms)};
    await new Promise((resolve) => {
      const step = () => {
        const d = read();
        // The median over the known-black pixels: a filament drifting over one cannot move it.
        const values = points.map((i) => { const a = d[i + 3] / 255; return Math.max(d[i], d[i + 1], d[i + 2]) * a; }).sort((x, y) => x - y);
        blackPeak = Math.max(blackPeak, values[Math.floor(values.length / 2)] ?? 0);
        if (frames >= 6) rmax = Math.max(rmax, regionMax(d));
        frames++;
        if (performance.now() < end) requestAnimationFrame(step); else resolve(null);
      };
      requestAnimationFrame(step);
    });
    return { blackPeak, blackPoints: points.length, regionMax: rmax, frames };
  })()`);

const browser = await chromium.launch();

// ---- Live confirmation, duplicates, bursts, replays, other matters, withdrawal ----------------
{
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  await page.goto(`${BASE}/hud-fixtures?state=idle`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  check(
    'nothing plays or is labelled on first load',
    (await stats(page)).wash === null && (await label(page).count()) === 0,
  );

  const sampling = sampleEnvelope(page, 1100);
  await page.waitForTimeout(250);
  await click(page, 'live');
  const env = await sampling;
  const s1 = await stats(page);
  check('a validated live confirmation plays once', s1.wash !== null);
  check(
    'the effect starts on the next rendered frame (client timing only)',
    s1.wash !== null &&
      s1.wash.firstFrameAtMs >= s1.wash.receivedAtMs &&
      s1.wash.firstFrameAtMs - s1.wash.receivedAtMs < 100,
    s1.wash === null ? '' : `${(s1.wash.firstFrameAtMs - s1.wash.receivedAtMs).toFixed(1)} ms`,
  );
  check(
    'the wash is visible but within about 0.06 of full brightness (at most 16 levels)',
    env.blackPoints > 100 && env.blackPeak >= 6 && env.blackPeak <= 16,
    `peak channel ${String(env.blackPeak)} over ${String(env.blackPoints)} black pixels, ${String(env.frames)} frames`,
  );
  check(
    'reading regions stay at or below #0D1117 throughout the effect',
    env.regionMax <= 0x17,
    `max ${env.regionMax.toFixed(1)}`,
  );
  const after = await sampleEnvelope(page, 150);
  check(
    'the wash is gone after the envelope',
    after.blackPeak === 0,
    `peak ${String(after.blackPeak)}`,
  );
  check(
    'a persistent label and one announcement carry the meaning',
    (await label(page).innerText()).startsWith('Receipt confirmed on') &&
      (await text(page, 'receipt-announcement')).startsWith('Receipt confirmed on'),
  );
  check('the real event is recorded', (await logCount(page)) === 1);

  const first = s1.wash?.receivedAtMs;
  await click(page, 'dup');
  check(
    'a duplicate delivery changes nothing',
    (await logCount(page)) === 1 && (await stats(page)).wash?.receivedAtMs === first,
  );
  await click(page, 'b');
  check(
    'a second confirmation inside the window is logged but plays no second effect',
    (await logCount(page)) === 2 && (await stats(page)).wash?.receivedAtMs === first,
  );
  await click(page, 'hydrate');
  check('replayed history is silent', (await logCount(page)) === 2);
  await page.waitForTimeout(2200);
  await click(page, 'other');
  check(
    'another matter updates the log and label but shows no effect',
    (await logCount(page)) === 3 && (await stats(page)).wash?.receivedAtMs === first,
  );
  await click(page, 'invalidate');
  check(
    'a withdrawal leaves a persistent correction and is announced',
    (await label(page).getAttribute('data-kind')) === 'correction' &&
      (await text(page, 'receipt-announcement')).startsWith('Correction'),
  );
  check('the correction is logged', (await logCount(page)) === 4);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  check(
    'a reload replays nothing',
    (await stats(page)).wash === null && (await label(page).count()) === 0,
  );
  await page.context().close();
}

// ---- Reduced motion and hidden tab ----------------------------------------------------------
{
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/hud-fixtures?state=idle`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const frames = (await stats(page)).framesDrawn;
  await click(page, 'live');
  await page.waitForTimeout(800);
  const s = await stats(page);
  check(
    'reduced motion: the label and announcement appear with no flash and no frames',
    s.wash === null &&
      s.framesDrawn - frames <= 1 &&
      (await label(page).count()) === 1 &&
      (await text(page, 'receipt-announcement')) !== '',
    `${String(s.framesDrawn - frames)} frames`,
  );
  await context.close();
}
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/hud-fixtures?state=idle`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.evaluate(
    `(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); })()`,
  );
  await click(page, 'live');
  await page.waitForTimeout(300);
  check(
    'a hidden tab gets the label and log but no effect',
    (await stats(page)).wash === null &&
      (await label(page).count()) === 1 &&
      (await logCount(page)) === 1,
  );
  await context.close();
}
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/hud-fixtures?state=idle`, { waitUntil: 'networkidle' });
  await page.getByLabel('Effects').selectOption('off');
  await page.waitForTimeout(300);
  await click(page, 'live');
  check(
    'Effects Off: no canvas, but the label and announcement still appear',
    (await page.locator('.lj-art canvas').count()) === 0 &&
      (await label(page).count()) === 1 &&
      (await text(page, 'receipt-announcement')) !== '',
  );
  await context.close();
}

await browser.close();
console.log(failed === 0 ? 'receipt checks passed' : `${String(failed)} receipt check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
