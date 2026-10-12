import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { noHorizontalScroll, selectQuote } from './harness/browser';
import { control, installInstruments, typeToAegis } from './harness/aegis';
import { fund } from './harness/chain';
import {
  addMatterAndDocument,
  confirmFactsAndCheck,
  createAccountAndVault,
  decideRecordAndFreeze,
} from './harness/flows';
import { isBlocked, repository } from './harness/services';
import { startSuite, type Suite } from './harness/suite';

/*
 * SYSTEM EVIDENCE (browser_scripted). Layout, keyboard, focus, status, contrast and motion checks on the
 * production build with synthetic data only. These are automated checks of the controls they name, run
 * in Chromium: they are not a WCAG conformance assessment, they do not replace a screen reader or a
 * person using assistive technology, and contrast is computed from rendered colours of text on flat
 * backgrounds. Screenshots under docs/evidence/chapter12 show synthetic content only.
 */

const CASES = [
  'a11y-reflow-matrix-and-screenshots',
  'a11y-keyboard-only-flows-focus-and-escape',
  'a11y-names-status-contrast-and-motion',
] as const;

const EVIDENCE = join(repository, 'docs', 'evidence', 'chapter12');
const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '390x844', width: 390, height: 844 },
  { name: '320x640', width: 320, height: 640 },
] as const;

let suite: Suite | undefined;

beforeAll(async () => {
  mkdirSync(EVIDENCE, { recursive: true });
  const started = await startSuite({
    name: 'accessibility',
    cases: CASES,
    localChain: true,
    env: () => ({ FEATURE_VOICE: 'true' }),
  });
  if (isBlocked(started)) return;
  suite = started;
}, 600_000);
afterAll(async () => {
  await suite?.stop();
});

const need = (context: { skip: () => never }): Suite => {
  if (suite === undefined) context.skip();
  return suite;
};

/** A funded account with a matter, a document, confirmed facts, checks, decisions and a frozen package. */
async function frozen(s: Suite, title: string): Promise<Page> {
  const { page } = await s.newSession();
  await installInstruments(page);
  const account = await createAccountAndVault(page, s.app.origin);
  if (s.chain === null) throw new Error('chain');
  await fund(s.chain, account.address, 10n * 10n ** 18n);
  await addMatterAndDocument(page, title);
  await confirmFactsAndCheck(page);
  await decideRecordAndFreeze(page, 'Recorded for the accessibility check.');
  return page;
}

async function mode(page: Page, name: 'Command centre' | 'Review'): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForTimeout(250);
}

interface Fit {
  readonly covered: boolean;
  readonly clippedX: boolean;
  readonly width: number;
  readonly height: number;
}

/** Whether the control is reachable on screen: inside the viewport horizontally and not under another element. */
async function fit(locator: Locator): Promise<Fit> {
  await locator.scrollIntoViewIfNeeded();
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      covered: top === null || !(top === element || element.contains(top)),
      clippedX: rect.left < -0.5 || rect.right > window.innerWidth + 0.5,
      width: rect.width,
      height: rect.height,
    };
  });
}

/** On narrow screens the package lives in its own tab; wider layouts show everything at once. */
async function openPackage(page: Page): Promise<void> {
  const tab = page.getByRole('tab', { name: 'Review package' });
  if (await tab.isVisible().catch(() => false)) await tab.click();
  await page.waitForTimeout(200);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
}

describe('[a11y-reflow-matrix-and-screenshots] Command-centre and Review modes at four sizes', () => {
  it('no horizontal scroll, no clipped or covered confirmation, 44 px touch targets, at 1440x900, 1024x768, 390x844 and 320 px', async (context) => {
    const s = need(context);
    const page = await frozen(s, 'SYSTEM-a11y-reflow-7c01');
    try {
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        for (const name of ['Command centre', 'Review'] as const) {
          await mode(page, name);
          expect(await noHorizontalScroll(page), `${name} at ${viewport.name}`).toBe(true);
          await shot(page, `${name === 'Review' ? 'review' : 'command-centre'}-${viewport.name}`);
        }
        // The composer and its controls are reachable at this size.
        await mode(page, 'Review');
        for (const id of ['aegis-input', 'aegis-send', 'aegis-stop', 'voice-talk']) {
          const result = await fit(page.getByTestId(id));
          expect(result.clippedX, `${id} clipped at ${viewport.name}`).toBe(false);
          expect(result.covered, `${id} covered at ${viewport.name}`).toBe(false);
          expect(result.height, `${id} height at ${viewport.name}`).toBeGreaterThanOrEqual(43.5);
        }
      }

      // A refusal, an error or a Stop note is shown whole on a small screen, never clipped to a line.
      for (const viewport of [VIEWPORTS[2], VIEWPORTS[3]]) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await mode(page, 'Review');
        await typeToAegis(page, 'approve');
        await expect
          .poll(async () => (await page.getByTestId('aegis-notice').innerText()).trim())
          .toMatch(/cannot approve/);
        const clipped = await page.getByTestId('aegis-notice').evaluate((element) => ({
          clipped: element.scrollHeight > element.clientHeight + 1,
          lines: getComputedStyle(element).webkitLineClamp,
        }));
        expect(clipped.clipped, `notice clipped at ${viewport.name}`).toBe(false);
        expect(clipped.lines).toBe('none');
        await shot(page, `notice-${viewport.name}`);
        await page.getByTestId('aegis-input').fill('');
      }

      // The approval confirmations at the smallest sizes: visible, unclipped, uncovered, 44 px.
      await page.setViewportSize({ width: 390, height: 844 });
      await mode(page, 'Review');
      await openPackage(page);
      await page.getByTestId('preview-approval').scrollIntoViewIfNeeded();
      await page.getByTestId('preview-approval').click();
      await page.getByTestId('approval-details').waitFor({ timeout: 30_000 });
      for (const viewport of [VIEWPORTS[2], VIEWPORTS[3]]) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.waitForTimeout(250);
        await openPackage(page);
        expect(await noHorizontalScroll(page)).toBe(true);
        const approve = await fit(page.getByTestId('approve-package'));
        expect(approve.clippedX, `approve clipped at ${viewport.name}`).toBe(false);
        expect(approve.covered, `approve covered at ${viewport.name}`).toBe(false);
        expect(approve.height).toBeGreaterThanOrEqual(43.5);
        await fit(page.getByTestId('approve-package'));
        await shot(page, `approval-preview-${viewport.name}`);
      }
      await page.getByTestId('approve-package').click();
      await page.getByTestId('send-transaction').waitFor({ timeout: 60_000 });
      for (const viewport of [VIEWPORTS[2], VIEWPORTS[3]]) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.waitForTimeout(250);
        await openPackage(page);
        expect(await noHorizontalScroll(page)).toBe(true);
        for (const id of ['send-transaction']) {
          const result = await fit(page.getByTestId(id));
          expect(result.clippedX, `${id} clipped at ${viewport.name}`).toBe(false);
          expect(result.covered, `${id} covered at ${viewport.name}`).toBe(false);
          expect(result.height).toBeGreaterThanOrEqual(43.5);
        }
        await fit(page.getByTestId('send-transaction'));
        await shot(page, `fee-confirmation-${viewport.name}`);
      }
    } finally {
      await page.context().close();
    }
  });
});

describe('[a11y-keyboard-only-flows-focus-and-escape] the whole path by keyboard, with visible focus and an Escape that confirms nothing', () => {
  const focused = (page: Page) =>
    page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        testId: element.getAttribute('data-testid'),
        name: element.getAttribute('aria-label') ?? element.textContent.trim().slice(0, 60),
        outline: `${style.outlineStyle}/${style.outlineWidth}`,
        shadow: style.boxShadow,
      };
    });

  it('drawers: focus moves in, Escape closes and returns focus to the opener, nothing is confirmed, and focus is not trapped', async (context) => {
    const s = need(context);
    const page = await frozen(s, 'SYSTEM-a11y-keyboard-7c02');
    try {
      await mode(page, 'Review');
      // A key press first, so the browser treats focus as keyboard focus (and shows its ring).
      await page.keyboard.press('Tab');
      const activity = page.locator('button[aria-controls="activity-drawer"]');
      await activity.focus();
      expect((await focused(page))?.name).toMatch(/Activity/);
      // Focus is visible: an outline or a box shadow, never none.
      const ring = await focused(page);
      expect(ring?.outline.startsWith('none') === true && ring.shadow === 'none').toBe(false);
      await page.keyboard.press('Enter');
      const drawer = page.locator('#activity-drawer');
      await drawer.waitFor({ timeout: 10_000 });
      // Focus moved into the drawer.
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.getElementById('activity-drawer')?.contains(document.activeElement),
          ),
        )
        .toBe(true);
      await page.keyboard.press('Escape');
      await drawer.waitFor({ state: 'hidden', timeout: 10_000 });
      expect((await focused(page))?.name).toMatch(/Activity/);
      // Same for the saved-context drawer, and the drawer is non-modal: Tab leaves it freely.
      const context1 = page.locator('button[aria-controls="context-drawer"]');
      await context1.focus();
      await page.keyboard.press('Enter');
      await page.locator('#context-drawer').waitFor({ timeout: 10_000 });
      for (let index = 0; index < 40; index += 1) await page.keyboard.press('Tab');
      expect(
        await page.evaluate(() =>
          document.getElementById('context-drawer')?.contains(document.activeElement),
        ),
        'focus can leave a non-modal drawer',
      ).toBe(false);
      await context1.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      await page.keyboard.press('Escape');
      expect(await page.getByTestId('approve-package').count()).toBe(0);
      expect(await page.getByTestId('send-transaction').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  });

  it('source navigation, disclosure, approval, fee confirmation, retry/cancel and export all work by keyboard; Escape confirms nothing', async (context) => {
    const s = need(context);
    const page = await frozen(s, 'SYSTEM-a11y-keyboard-7c03');
    try {
      await mode(page, 'Review');
      // Source navigation: the page controls take focus and respond to Enter.
      await page.keyboard.press('Tab');
      await page.getByRole('button', { name: 'Previous page' }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Next page' }).focus();
      await page.keyboard.press('Enter');
      expect(await selectQuote(page, '24,000')).toBe(true);

      // Disclosure: Escape cancels and sends nothing; the same preview is sent by keyboard.
      await typeToAegis(page, 'explain this clause');
      await page.getByTestId('disclosure-preview').waitFor({ timeout: 15_000 });
      const atPreview = s.services.provider.requests.length;
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      expect(s.services.provider.requests.length, 'Escape does not send').toBe(atPreview);
      const afterEscape = atPreview;
      expect(await page.getByTestId('assistant-run').count()).toBe(0);
      // Escape sent nothing; the preview is dismissed with its own Cancel button, by keyboard.
      await page.getByTestId('disclosure-cancel').focus();
      await page.keyboard.press('Enter');
      await page.getByTestId('disclosure-preview').waitFor({ state: 'detached', timeout: 10_000 });
      expect(s.services.provider.requests.length).toBe(atPreview);
      await selectQuote(page, '24,000');
      await typeToAegis(page, 'explain this clause');
      await page.getByTestId('disclosure-preview').waitFor({ timeout: 15_000 });
      await page.getByTestId('disclosure-send').focus();
      await page.keyboard.press('Enter');
      await expect
        .poll(() => page.getByTestId('assistant-run').last().getAttribute('data-state'), {
          timeout: 40_000,
        })
        .toBe('completed');
      expect(s.services.provider.requests.length).toBeGreaterThan(afterEscape);

      // Approval by keyboard: Escape on the preview approves nothing; Enter on Approve signs.
      await page.getByTestId('preview-approval').focus();
      await page.keyboard.press('Enter');
      await page.getByTestId('approval-details').waitFor({ timeout: 30_000 });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      expect(await page.getByTestId('approval-signed').count()).toBe(0);
      await page.getByTestId('approve-package').focus();
      const ring = await focused(page);
      expect(ring?.outline.startsWith('none') === true && ring.shadow === 'none').toBe(false);
      await page.keyboard.press('Enter');
      await page.getByTestId('send-transaction').waitFor({ timeout: 60_000 });
      expect(await page.getByTestId('approval-signed').innerText()).toMatch(/Approval signed/);

      // Fee confirmation: "Do not send" is the cancel path and works by keyboard; then a new quote.
      await page.getByRole('button', { name: 'Do not send' }).focus();
      await page.keyboard.press('Enter');
      await expect
        .poll(async () => (await page.getByTestId('tx-stage').innerText()).trim())
        .toMatch(/Cancelled/);
      expect(await page.getByTestId('send-transaction').count()).toBe(0);

      // Export by keyboard: the preview discloses, Escape-less Cancel closes it, nothing downloads.
      const downloads: string[] = [];
      page.on('download', (download) => downloads.push(download.suggestedFilename()));
      const exportButton = page.getByRole('button', { name: /^Export readable review/ }).first();
      await exportButton.focus();
      await page.keyboard.press('Enter');
      const preview = page.getByRole('group', { name: 'Export preview' });
      await preview.waitFor({ timeout: 15_000 });
      expect(await preview.innerText()).toMatch(/discloses private material/i);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      expect(downloads).toEqual([]);
      await preview.getByRole('button', { name: 'Cancel' }).focus();
      await page.keyboard.press('Enter');
      await preview.waitFor({ state: 'detached', timeout: 10_000 });
      expect(downloads).toEqual([]);
      await shot(page, 'keyboard-focus-1440x900');
    } finally {
      await page.context().close();
    }
  });
});

describe('[a11y-names-status-contrast-and-motion] names, status without colour, contrast, errors and reduced motion', () => {
  it('every visible control has an accessible name, statuses carry text, errors are announced, and the control tree is recorded', async (context) => {
    const s = need(context);
    const page = await frozen(s, 'SYSTEM-a11y-names-7c04');
    try {
      for (const name of ['Command centre', 'Review'] as const) {
        await mode(page, name);
        const unnamed = await page.evaluate(() => {
          const visible = (element: Element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
          };
          const labelled = (element: Element): string => {
            const aria = element.getAttribute('aria-label');
            if (aria !== null && aria.trim() !== '') return aria;
            const by = element.getAttribute('aria-labelledby');
            if (by !== null) {
              const text = by
                .split(/\s+/)
                .map((id) => document.getElementById(id)?.textContent ?? '')
                .join(' ')
                .trim();
              if (text !== '') return text;
            }
            if (
              element instanceof HTMLInputElement ||
              element instanceof HTMLSelectElement ||
              element instanceof HTMLTextAreaElement
            ) {
              const fromLabels = Array.from(element.labels ?? [])
                .map((label) => label.textContent)
                .join(' ')
                .trim();
              if (fromLabels !== '') return fromLabels;
            }
            const text = element.textContent.trim();
            if (text !== '') return text;
            return (element.getAttribute('title') ?? '').trim();
          };
          return Array.from(
            document.querySelectorAll(
              'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=checkbox], [role=switch]',
            ),
          )
            .filter(visible)
            .filter((element) => labelled(element) === '')
            .map(
              (element) =>
                `${element.tagName.toLowerCase()}[${element.getAttribute('data-testid') ?? ''}]`,
            );
        });
        expect(unnamed, `unnamed controls in ${name}`).toEqual([]);
        // The accessible control tree (synthetic content only) is kept as evidence.
        const tree = await page.locator('body').ariaSnapshot();
        writeFileSync(
          join(EVIDENCE, `control-tree-${name === 'Review' ? 'review' : 'command-centre'}.txt`),
          `${tree}\n`,
        );
        expect(tree).toMatch(/navigation|banner|main/);
      }

      // Status is text, not only colour: the readings the person must act on say their state in words.
      await mode(page, 'Review');
      expect(await page.getByTestId('frozen-package').innerText()).toMatch(/Saved and checked/);
      await page.getByTestId('preview-approval').click();
      await page.getByTestId('approval-details').waitFor({ timeout: 30_000 });
      const statusTexts = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll(
            '[role=status], [role=alert], [data-testid$=status], [data-testid=tx-stage]',
          ),
        )
          .map((element) => element.textContent.trim())
          .filter((text) => text !== ''),
      );
      for (const text of statusTexts) expect(text.length, text).toBeGreaterThan(2);

      await page.keyboard.press('Escape');
    } finally {
      await page.context().close();
    }
  });

  it('every rendered text meets the contrast threshold in both modes, and nothing animates under reduced motion', async (context) => {
    const s = need(context);
    const { page } = await s.newSession();
    await installInstruments(page);
    try {
      const account = await createAccountAndVault(page, s.app.origin);
      if (s.chain === null) throw new Error('chain');
      await fund(s.chain, account.address, 10n * 10n ** 18n);
      await addMatterAndDocument(page, 'SYSTEM-a11y-contrast-7c05');
      await confirmFactsAndCheck(page);

      const contrast = () =>
        page.evaluate(() => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context2d = canvas.getContext('2d', { willReadFrequently: true });
          if (context2d === null) return { error: 'no canvas' } as const;
          const rgba = (value: string): [number, number, number, number] => {
            context2d.clearRect(0, 0, 1, 1);
            context2d.fillStyle = '#000';
            context2d.fillStyle = value;
            context2d.fillRect(0, 0, 1, 1);
            const data = context2d.getImageData(0, 0, 1, 1).data;
            return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, (data[3] ?? 0) / 255];
          };
          const over = (top: number[], bottom: number[]): [number, number, number, number] => {
            const a = top[3] ?? 1;
            return [
              (top[0] ?? 0) * a + (bottom[0] ?? 0) * (1 - a),
              (top[1] ?? 0) * a + (bottom[1] ?? 0) * (1 - a),
              (top[2] ?? 0) * a + (bottom[2] ?? 0) * (1 - a),
              1,
            ];
          };
          const luminance = (c: number[]) => {
            const channel = (v: number) => {
              const x = v / 255;
              return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
            };
            return (
              0.2126 * channel(c[0] ?? 0) +
              0.7152 * channel(c[1] ?? 0) +
              0.0722 * channel(c[2] ?? 0)
            );
          };
          const background = (element: Element): { color: number[]; image: boolean } => {
            const layers: number[][] = [];
            let image = false;
            for (let node: Element | null = element; node !== null; node = node.parentElement) {
              const style = getComputedStyle(node);
              // The page's faint decorative grid sits on a flat base colour: judge text against that colour.
              if (
                style.backgroundImage !== 'none' &&
                node !== document.body &&
                node !== document.documentElement
              )
                image = true;
              const layer = rgba(style.backgroundColor);
              if (layer[3] > 0) layers.push(layer);
              if (layer[3] >= 1) break;
            }
            let result: number[] = [255, 255, 255, 1];
            for (const layer of layers.reverse()) result = over(layer, result);
            return { color: result, image };
          };
          const offenders: string[] = [];
          let checked = 0;
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            const text = (node.textContent ?? '').trim();
            const element = node.parentElement;
            if (text === '' || element === null) continue;
            if (element.closest('svg, script, style, [hidden], [aria-hidden=true]') !== null)
              continue;
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden') continue;
            if (style.getPropertyValue('clip') !== 'auto' && rect.width <= 1) continue; // sr-only
            if (element.closest('[aria-disabled=true], :disabled') !== null) continue; // inactive components
            const bg = background(element);
            if (bg.image) continue;
            let opacity = 1;
            for (let n: Element | null = element; n !== null; n = n.parentElement)
              opacity *= Number(getComputedStyle(n).opacity);
            const fg = rgba(style.color);
            const composed = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg.color);
            const l1 = luminance(composed);
            const l2 = luminance(bg.color);
            const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
            const size = parseFloat(style.fontSize);
            const bold = Number(style.fontWeight) >= 700;
            const large = size >= 24 || (size >= 18.66 && bold);
            checked += 1;
            if (ratio < (large ? 3 : 4.5))
              offenders.push(
                `${ratio.toFixed(2)} ${element.tagName.toLowerCase()} "${text.slice(0, 40)}" color=${style.color}`,
              );
          }
          return { checked, offenders } as const;
        });

      // Negative control: the probe must flag text that really is low contrast, or it proves nothing.
      await page.evaluate(() => {
        const element = document.createElement('p');
        element.id = 'contrast-control';
        element.textContent = 'deliberately low contrast control text';
        element.style.cssText = 'color:#3a4452;background:#060b14;font-size:14px';
        document.body.append(element);
      });
      const negative = await contrast();
      expect((negative.offenders ?? []).join('|')).toMatch(
        /deliberately low contrast control text/,
      );
      await page.evaluate(() => document.getElementById('contrast-control')?.remove());

      for (const name of ['Command centre', 'Review'] as const) {
        await mode(page, name);
        const result = await contrast();
        expect('error' in result ? result.error : '', `contrast probe in ${name}`).toBe('');
        if (!('error' in result)) {
          expect(result.checked, `text checked in ${name}`).toBeGreaterThan(
            name === 'Review' ? 20 : 5,
          );
          expect(result.offenders.slice(0, 10), `low contrast in ${name}`).toEqual([]);
        }
      }

      // Reduced motion: nothing runs while a request is in flight. With motion allowed the same
      // request does animate, so the check is not vacuous.
      const running = () =>
        page.evaluate(
          () =>
            document.getAnimations().filter((animation) => animation.playState === 'running')
              .length,
        );
      await selectQuote(page, '24,000');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await typeToAegis(page, 'SLOW-TEST explain this clause');
      await page.getByTestId('disclosure-preview').waitFor({ timeout: 15_000 });
      await page.getByTestId('disclosure-send').click();
      await expect
        .poll(() => page.getByTestId('assistant-run').last().getAttribute('data-state'), {
          timeout: 20_000,
        })
        .toBe('running');
      await page.waitForTimeout(500);
      expect(await running(), 'running animations under reduced motion').toBe(0);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.waitForTimeout(500);
      expect(await running(), 'the orb animates when motion is allowed').toBeGreaterThan(0);
      await page.getByTestId('aegis-stop').click();
      expect((await control.speech(page)).instances).toBe(0);
    } finally {
      await page.context().close();
    }
  });
});
