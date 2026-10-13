/**
 * pnpm exec tsx tooling/scripts/hud-visual-check.ts [baseUrl]
 *
 * Layout and screenshot check of the empty HUD workbench at several viewports (synthetic: no
 * account, no matter, no data). It measures geometry and records pass/fail; screenshots are
 * written to docs/evidence/ui-blueprint/. It is not an accessibility or flash-safety audit.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from './lib';

const BASE = process.argv[2] ?? 'http://localhost:3140';
const OUT = join(ROOT, 'docs', 'evidence', 'ui-blueprint');
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '390x844', width: 390, height: 844 },
  { name: '320x640', width: 320, height: 640 },
] as const;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Metrics {
  scrollW: number;
  clientW: number;
  ceiling: Box | null;
  dock: Box | null;
  left: Box | null;
  stage: Box | null;
  right: Box | null;
}

interface Focus {
  hidden: boolean;
  visible: boolean;
  desc: string;
}

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
};

const browser = await chromium.launch();
for (const vp of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await context.newPage();
  await page.goto(`${BASE}/review`, { waitUntil: 'networkidle' });
  // A string, so the page never needs helpers that the TypeScript transform would inject.
  const m = await page.evaluate<Metrics>(`(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    return {
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      ceiling: rect('.lj-ceiling'),
      dock: rect('.lj-dock'),
      left: rect('.lj-rail-left'),
      stage: rect('section[aria-label="Work"]'),
      right: rect('aside[aria-label="Evidence and approval"]'),
    };
  })()`);
  check(
    `${vp.name}: no page-wide horizontal scroll`,
    m.scrollW <= m.clientW,
    `${m.scrollW}/${m.clientW}`,
  );
  check(
    `${vp.name}: ceiling is flush at the top and full width`,
    m.ceiling !== null && m.ceiling.y === 0 && Math.abs(m.ceiling.w - vp.width) < 1,
  );
  check(
    `${vp.name}: dock is at least 64px tall and full width`,
    m.dock !== null && m.dock.h >= 64 && Math.abs(m.dock.w - vp.width) < 1,
    String(m.dock?.h),
  );
  if (vp.width >= 1440) {
    check(
      '1440: left rail 240px, right rail 336px, stage 776px',
      m.left !== null &&
        m.right !== null &&
        m.stage !== null &&
        Math.round(m.left.w) === 240 &&
        Math.round(m.right.w) === 336 &&
        Math.abs(m.stage.w - 776) <= 1,
      `${String(m.left?.w)}/${String(m.stage?.w)}/${String(m.right?.w)}`,
    );
  } else if (vp.width >= 1200) {
    check(
      `${vp.name}: left rail 208px, right rail 304px`,
      m.left !== null &&
        m.right !== null &&
        Math.round(m.left.w) === 208 &&
        Math.round(m.right.w) === 304,
      `${String(m.left?.w)}/${String(m.right?.w)}`,
    );
  }
  // Keyboard walk: every focused control must stay visible, not hidden behind the ceiling or dock.
  let obscured = 0;
  let steps = 0;
  await page.keyboard.press('Tab');
  for (let i = 0; i < 45; i++) {
    const focus = await page.evaluate<Focus | null>(`(() => {
      const el = document.activeElement;
      if (el === null || el === document.body || el.tagName === 'NEXTJS-PORTAL') return null;
      const r = el.getBoundingClientRect();
      // The skip link is meant to overlay the top while focused; the dev portal is Next.js tooling.
      const inChrome = Boolean(el.closest('.lj-ceiling, .lj-dock')) || el.tagName === 'NEXTJS-PORTAL' || (el.tagName === 'A' && el.getAttribute('href') === '#main');
      const c = document.querySelector('.lj-ceiling').getBoundingClientRect();
      const d = document.querySelector('.lj-dock').getBoundingClientRect();
      const hidden = !inChrome && (r.top < c.bottom - 1 && r.bottom > c.top || r.bottom > d.top + 1 && r.top < d.bottom);
      return { hidden, visible: r.width > 0 && r.height > 0, desc: el.tagName + ':' + (el.textContent || '').slice(0, 30) + ':' + Math.round(r.top) + '-' + Math.round(r.bottom) + ' c' + Math.round(c.bottom) + ' d' + Math.round(d.top) };
    })()`);
    if (focus !== null) {
      steps++;
      if (focus.hidden || !focus.visible) {
        obscured++;
        console.log('   obscured:', focus.desc);
      }
    }
    await page.keyboard.press('Tab');
  }
  check(
    `${vp.name}: keyboard focus never sits behind the ceiling or dock`,
    obscured === 0 && steps > 5,
    `${String(steps)} stops, ${String(obscured)} hidden`,
  );
  await page.screenshot({ path: join(OUT, `stage2-${vp.name}.png`), fullPage: vp.width < 800 });
  await context.close();
}
await browser.close();
console.log(failed === 0 ? 'layout checks passed' : `${String(failed)} layout check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
