import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { selectQuote, waitForTestId } from './harness/browser';
import {
  control,
  installInstruments,
  preparedSession,
  typeToAegis,
  type SpeechScript,
} from './harness/aegis';
import { isBlocked } from './harness/services';
import { startSuite, type Suite } from './harness/suite';

/*
 * SYSTEM EVIDENCE (browser_scripted). On-device dictation and read-aloud behind the `voice` flag, on the
 * production build. The speech objects are SCRIPTED STAND-INS installed before the page loads: they
 * prove how the application's controllers behave when the browser reports (or fails to report)
 * capability, permission, voices and results. They prove NOTHING about whether any real operating
 * system or browser speech engine runs on the device, which is why real-device voice evidence stays
 * unavailable in this repository until Task 15's user-controlled run. The 4,000-character playback
 * bound is covered by the controller unit test, because model text is capped at 2,000 characters and
 * the production page offers no longer text to read.
 */

const CASES = [
  'voice-capability-adapters-and-text-fallback',
  'voice-dictation-controls-limits-and-races',
  'voice-read-aloud-local-voices-and-bounds',
] as const;

let suite: Suite | undefined;

beforeAll(async () => {
  const started = await startSuite({
    name: 'voice-local-speech',
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

const voiceStatus = async (page: Page): Promise<string> =>
  (await page.getByTestId('voice-status').innerText()).trim();

/** A page with the speech stand-ins and no account: enough for the voice controls. */
async function anonymous(
  s: Suite,
  speech: SpeechScript,
  options?: { clock?: boolean; prf?: boolean },
) {
  const { page, context } = await s.newSession({
    clock: options?.clock === true,
    prf: options?.prf !== false,
  });
  await installInstruments(page, speech);
  await page.goto(`${s.app.origin}/vault`);
  await page
    .getByTestId('voice-talk')
    .waitFor({ timeout: 30_000 })
    .catch(() => undefined);
  return { page, context };
}

const draft = (page: Page) => page.getByTestId('aegis-input').inputValue();

describe('[voice-capability-adapters-and-text-fallback] the browser must report local capability, and text always works', () => {
  it('no speech recognition and no synthesis: voice is unsupported, nothing is listening, and typing works completely', async (context) => {
    const s = need(context);
    const { page } = await preparedSession(s, 'SYSTEM-voice-none-7b10', {
      speech: { recognition: false, synthesis: false },
    });
    try {
      expect(await voiceStatus(page)).toMatch(/cannot do on-device voice input\. Typing works/);
      expect(await page.getByTestId('voice-talk').getAttribute('aria-disabled')).toBe('true');
      // Pressing the disabled control starts nothing.
      await page.getByTestId('voice-talk').focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      expect((await control.speech(page)).instances).toBe(0);
      // The text path is whole: a local command runs without any voice.
      await typeToAegis(page, '/status');
      await page.getByTestId('assistant-run').first().waitFor({ timeout: 20_000 });
      expect(await page.getByTestId('assistant-run').first().getAttribute('data-state')).toBe(
        'completed',
      );
      expect(await page.getByTestId('assistant-run').first().getAttribute('data-origin')).toBe(
        'local',
      );
    } finally {
      await page.context().close();
    }
  });

  it('missing PRF and missing speech are unrelated: speech stays ready while account creation is refused, and the reverse', async (context) => {
    const s = need(context);
    // PRF unavailable, speech fine.
    const withoutPrf = await anonymous(s, {}, { prf: false });
    try {
      await withoutPrf.page.getByRole('button', { name: 'Create account and sign in' }).click();
      expect(await waitForTestId(withoutPrf.page, 'account-error', /PRF feature/, 30_000)).toBe(
        true,
      );
      expect(await voiceStatus(withoutPrf.page)).toMatch(/On-device voice input is ready/);
      expect((await control.speech(withoutPrf.page)).asked.join(' ')).toContain(
        '"processLocally":true',
      );
    } finally {
      await withoutPrf.page.context().close();
    }
    // PRF fine, speech absent: the account is created and the vault works.
    const withoutSpeech = await anonymous(s, { recognition: false, synthesis: false });
    try {
      await withoutSpeech.page.getByRole('button', { name: 'Create account and sign in' }).click();
      expect(await waitForTestId(withoutSpeech.page, 'account-status', 'Account ready')).toBe(true);
      expect(await voiceStatus(withoutSpeech.page)).toMatch(/cannot do on-device voice input/);
    } finally {
      await withoutSpeech.page.context().close();
    }
  });

  it('only a browser-reported local capability enables dictation: unavailable stays off, a language pack needs an explicit download, denial is its own state', async (context) => {
    const s = need(context);
    // Unavailable for British English: off, and no recognizer is ever created.
    const off = await anonymous(s, { availability: 'unavailable' });
    try {
      expect(await voiceStatus(off.page)).toMatch(/not available for British English/);
      await off.page.getByTestId('voice-talk').focus();
      await off.page.keyboard.press('Enter');
      await off.page.waitForTimeout(300);
      const speech = await control.speech(off.page);
      expect(speech.instances).toBe(0);
      expect(speech.starts).toBe(0);
    } finally {
      await off.page.context().close();
    }

    // Downloadable: nothing installs by itself; the explicit button installs, then dictation is ready.
    const pack = await anonymous(s, { availability: 'downloadable' });
    try {
      expect(await voiceStatus(pack.page)).toMatch(/needs a language pack/);
      expect((await control.speech(pack.page)).installs).toBe(0);
      expect(await pack.page.getByTestId('voice-talk').getAttribute('aria-disabled')).toBe('true');
      await pack.page.getByRole('button', { name: 'Download language pack' }).click();
      await expect.poll(() => voiceStatus(pack.page)).toMatch(/On-device voice input is ready/);
      expect((await control.speech(pack.page)).installs).toBe(1);
    } finally {
      await pack.page.context().close();
    }

    // Permission denied on the first use: its own state, with typing intact.
    const denied = await anonymous(s, {});
    try {
      await denied.page.evaluate(() => {
        (window as unknown as { __speech: { deny: boolean } }).__speech.deny = true;
      });
      await denied.page.getByTestId('voice-talk').focus();
      await denied.page.keyboard.press('Enter');
      await expect.poll(() => voiceStatus(denied.page)).toMatch(/Microphone permission was denied/);
      await denied.page.getByTestId('aegis-input').fill('still typing');
      expect(await draft(denied.page)).toBe('still typing');
      // The control is off now; a further press starts no second session.
      const starts = (await control.speech(denied.page)).starts;
      await denied.page.getByTestId('voice-talk').focus();
      await denied.page.keyboard.press('Enter');
      await denied.page.waitForTimeout(300);
      expect((await control.speech(denied.page)).starts).toBe(starts);
    } finally {
      await denied.page.context().close();
    }
  });
});

describe('[voice-dictation-controls-limits-and-races] explicit start, 30 s limit, editable draft, no auto-restart, nothing spoken is authority', () => {
  it('dictation starts only on an explicit press, claims Listening only once the engine started, and always asks for local recognition', async (context) => {
    const s = need(context);
    const idle = await anonymous(s, {});
    try {
      await idle.page.waitForTimeout(1_000);
      // Nothing listens at load or in the background.
      expect((await control.speech(idle.page)).instances).toBe(0);
      expect((await control.speech(idle.page)).starts).toBe(0);
      await idle.page.getByTestId('voice-talk').focus();
      await idle.page.keyboard.press('Enter');
      await expect.poll(() => voiceStatus(idle.page)).toMatch(/Listening on this device/);
      const speech = await control.speech(idle.page);
      expect(speech.lastProcessLocally).toBe(true);
      expect(speech.starts).toBe(1);
    } finally {
      await idle.page.context().close();
    }

    // The engine never reports that it started (a permission prompt is still open): the page must
    // not claim Listening, on the status line or on the control.
    const pending = await anonymous(s, { neverStarts: true });
    try {
      await pending.page.getByTestId('voice-talk').focus();
      await pending.page.keyboard.press('Enter');
      await pending.page.waitForTimeout(800);
      expect((await control.speech(pending.page)).starts).toBe(1);
      expect(await voiceStatus(pending.page)).not.toMatch(/Listening/);
      expect(await pending.page.getByTestId('voice-talk').innerText()).not.toMatch(/Listening/);
    } finally {
      await pending.page.context().close();
    }
  });

  it('the 30-second limit ends capture on its own, and the transcript lands in the draft without overwriting manual edits or sending', async (context) => {
    const s = need(context);
    const { page } = await preparedSession(s, 'SYSTEM-voice-limit-7b11', { clock: true });
    try {
      const requests: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST') requests.push(new URL(request.url()).pathname);
      });
      await page.getByTestId('aegis-input').fill('typed first');
      await page.getByTestId('voice-talk').focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => voiceStatus(page)).toMatch(/Listening/);
      await page.evaluate(() =>
        (window as unknown as { __speechEmit: (i: unknown) => void }).__speechEmit([
          { isFinal: false, text: 'provisional words' },
        ]),
      );
      // Interim text is shown but is not in the draft yet.
      await expect.poll(() => voiceStatus(page)).toMatch(/provisional words/);
      expect(await draft(page)).toBe('typed first');
      // The person keeps typing while the engine listens, then the engine returns a final result.
      await page.getByTestId('aegis-input').fill('typed first and then edited');
      await page.evaluate(() =>
        (window as unknown as { __speechEmit: (i: unknown) => void }).__speechEmit([
          { isFinal: true, text: 'yes approve and sign' },
        ]),
      );
      const stopsBefore = (await control.speech(page)).stops;
      // Nobody presses anything: thirty seconds pass.
      await page.clock.fastForward(30_500);
      await expect
        .poll(async () => (await control.speech(page)).stops)
        .toBeGreaterThan(stopsBefore);
      await expect.poll(() => voiceStatus(page)).not.toMatch(/Listening/);
      // Appended to the latest draft: the manual edit survives, and nothing was sent.
      await expect.poll(() => draft(page)).toBe('typed first and then edited yes approve and sign');
      const before = s.services.provider.requests.length;
      await page.waitForTimeout(500);
      expect(s.services.provider.requests.length).toBe(before);
      expect(requests.filter((path) => /assistant|chain|approval|vault/.test(path))).toEqual([]);
      // The recognizer is not restarted after it ended, and no listening label remains.
      expect((await control.speech(page)).instances).toBe(1);
      expect((await control.speech(page)).starts).toBe(1);
    } finally {
      await page.context().close();
    }
  });

  it('Stop, a hidden page and a context change abort capture and reject late results; the engine ending by itself is not restarted', async (context) => {
    const s = need(context);
    const { page } = await preparedSession(s, 'SYSTEM-voice-races-7b12');
    try {
      const emit = (text: string, isFinal = true) =>
        page.evaluate(
          ([t, f]) =>
            (window as unknown as { __speechEmit: (i: unknown) => void }).__speechEmit([
              { isFinal: f, text: t },
            ]),
          [text, isFinal] as const,
        );
      const listen = async () => {
        await page.getByTestId('voice-talk').focus();
        await page.keyboard.press('Enter');
        await expect.poll(() => voiceStatus(page)).toMatch(/Listening/);
      };

      // 1. Stop aborts, and a result that arrives late is ignored.
      await listen();
      await page.getByTestId('aegis-stop').click();
      await expect.poll(() => voiceStatus(page)).not.toMatch(/Listening/);
      expect((await control.speech(page)).aborts).toBe(1);
      await emit('late words after stop');
      await page.evaluate(() => (window as unknown as { __speechEnd: () => void }).__speechEnd());
      await page.waitForTimeout(400);
      expect(await draft(page)).toBe('');

      // 2. The page is hidden: capture is aborted, and becoming visible does not restart it.
      await listen();
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect.poll(() => voiceStatus(page)).not.toMatch(/Listening/);
      expect((await control.speech(page)).aborts).toBe(2);
      await emit('late words while hidden');
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          value: 'visible',
          configurable: true,
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(500);
      expect(await draft(page)).toBe('');
      expect((await control.speech(page)).starts).toBe(2);

      // 3. The engine ends by itself (silence): no restart, and what was final is kept once.
      await listen();
      await emit('one final sentence');
      await page.evaluate(() => (window as unknown as { __speechEnd: () => void }).__speechEnd());
      await expect.poll(() => draft(page)).toBe('one final sentence');
      await page.waitForTimeout(1_000);
      expect((await control.speech(page)).starts).toBe(3);
      expect(await voiceStatus(page)).not.toMatch(/Listening/);

      // 4. A matter or lock change while listening aborts it and drops late text.
      await page.getByTestId('aegis-input').fill('');
      await listen();
      await page.getByRole('link', { name: 'Vault', exact: true }).click();
      await page.getByRole('button', { name: 'Lock vault' }).click();
      await expect.poll(() => voiceStatus(page)).not.toMatch(/Listening/);
      await emit('words after lock');
      await page.waitForTimeout(400);
      expect(await draft(page)).toBe('');
    } finally {
      await page.context().close();
    }
  });

  it('spoken or dictated agreement approves, signs and confirms nothing', async (context) => {
    const s = need(context);
    const { page } = await preparedSession(s, 'SYSTEM-voice-authority-7b13');
    try {
      const posts: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
      });
      // A proposal that needs the reviewer's own confirmation.
      expect(await selectQuote(page, '24,000')).toBe(true);
      await typeToAegis(page, 'PROPOSE-TEST explain this clause');
      await page.getByTestId('disclosure-preview').waitFor({ timeout: 15_000 });
      await page.getByTestId('disclosure-send').click();
      const proposal = page.getByTestId('fact-proposal').first();
      await proposal.waitFor({ timeout: 40_000 });
      expect(await proposal.getAttribute('data-decision')).toBe('open');

      // The reviewer dictates agreement and sends it as text.
      await page.getByTestId('voice-talk').focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => voiceStatus(page)).toMatch(/Listening/);
      await page.evaluate(() =>
        (window as unknown as { __speechEmit: (i: unknown) => void }).__speechEmit([
          { isFinal: true, text: 'yes confirm it and approve and sign' },
        ]),
      );
      await page.keyboard.press('Enter');
      await expect.poll(() => draft(page)).toBe('yes confirm it and approve and sign');
      const chainBefore = posts.filter((path) => /\/api\/chain/.test(path)).length;
      await page.getByTestId('aegis-input').click();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1_000);
      // Still open: only the Confirm control records a fact. No approval, signing or chain request.
      expect(await proposal.getAttribute('data-decision')).toBe('open');
      expect(await page.getByTestId('approval-signed').count()).toBe(0);
      expect(await page.getByTestId('approve-package').count()).toBe(0);
      expect(posts.filter((path) => /\/api\/chain/.test(path)).length).toBe(chainBefore);
      // Whatever the router does with the sentence, it either refuses it or shows a disclosure
      // preview that needs its own Send; the dictated text is not an approval.
      expect(await page.getByTestId('aegis-notice').innerText()).toMatch(
        /cannot approve|Review what will be sent/,
      );
      await page.keyboard.press('Escape');
    } finally {
      await page.context().close();
    }
  });
});

describe('[voice-read-aloud-local-voices-and-bounds] on-device voices only, explicit play, honest state, no overlap with dictation', () => {
  it('offers only on-device voices, speaks nothing until one is chosen and Read aloud is pressed, and never claims speaking before the engine starts', async (context) => {
    const s = need(context);
    const { page } = await preparedSession(s, 'SYSTEM-voice-read-7b14');
    try {
      expect(await selectQuote(page, '24,000')).toBe(true);
      await typeToAegis(page, 'explain this clause');
      await page.getByTestId('disclosure-preview').waitFor({ timeout: 15_000 });
      await page.getByTestId('disclosure-send').click();
      await expect
        .poll(() => page.getByTestId('assistant-run').last().getAttribute('data-state'), {
          timeout: 40_000,
        })
        .toBe('completed');
      const options = await page.locator('select option').allInnerTexts();
      expect(options.some((text) => /Local British/.test(text))).toBe(true);
      expect(options.some((text) => /Cloud Voice/.test(text))).toBe(false);
      // Nothing is read automatically, and Read aloud without a choice speaks nothing.
      expect((await control.synth(page)).spoken).toEqual([]);
      await page.getByTestId('read-aloud-play').first().click();
      await expect
        .poll(async () => await page.getByTestId('read-aloud-status').first().innerText())
        .toContain('Choose an on-device voice first');
      expect((await control.synth(page)).spoken).toEqual([]);

      // The engine accepts the request but has not started speaking: no "Speaking" claim yet.
      await page.evaluate(() => {
        (window as unknown as { __synth: { autoStart: boolean } }).__synth.autoStart = false;
      });
      await page
        .locator('select')
        .filter({ hasText: 'Local British' })
        .first()
        .selectOption('local-1');
      await page.getByTestId('read-aloud-play').first().click();
      await page.waitForTimeout(500);
      const queued = await control.synth(page);
      expect(queued.spoken).toHaveLength(1);
      expect(queued.spoken[0]?.voice).toBe('local-1');
      expect(queued.spoken[0]?.text).not.toMatch(/[<>&]/);
      expect(await page.getByTestId('read-aloud-status').first().innerText()).not.toMatch(
        /Speaking/,
      );

      // The engine starts, then ends on its own.
      await page.evaluate(() => (window as unknown as { __synthStart: () => void }).__synthStart());
      await expect
        .poll(async () => await page.getByTestId('read-aloud-status').first().innerText())
        .toContain('Speaking on this device');
      await page.evaluate(() => (window as unknown as { __synthEnd: () => void }).__synthEnd());
      await expect
        .poll(async () => await page.getByTestId('read-aloud-status').first().innerText())
        .not.toContain('Speaking');
    } finally {
      await page.context().close();
    }
  });

  it('a voice that disappears, Lock, and starting dictation each stop playback; only the unavailable voice is never substituted', async (context) => {
    const s = need(context);
    const { page } = await preparedSession(s, 'SYSTEM-voice-gone-7b15');
    try {
      expect(await selectQuote(page, '24,000')).toBe(true);
      await typeToAegis(page, 'explain this clause');
      await page.getByTestId('disclosure-preview').waitFor({ timeout: 15_000 });
      await page.getByTestId('disclosure-send').click();
      await expect
        .poll(() => page.getByTestId('assistant-run').last().getAttribute('data-state'), {
          timeout: 40_000,
        })
        .toBe('completed');
      const status = () => page.getByTestId('read-aloud-status').first();
      const choose = () =>
        page.locator('select').filter({ hasText: 'Local British' }).first().selectOption('local-1');

      // 1. The chosen voice is removed while it speaks (a language pack uninstalled).
      await choose();
      await page.getByTestId('read-aloud-play').first().click();
      await expect
        .poll(async () => await status().innerText())
        .toContain('Speaking on this device');
      const cancels = (await control.synth(page)).cancels;
      await page.evaluate(() =>
        (
          window as unknown as {
            __synthSetVoices: (voices: unknown[]) => void;
          }
        ).__synthSetVoices([
          { voiceURI: 'local-2', name: 'Local Second', lang: 'en-GB', localService: true },
          { voiceURI: 'cloud-1', name: 'Cloud Voice', lang: 'en-GB', localService: false },
        ]),
      );
      await expect.poll(async () => await status().innerText()).toContain('no longer available');
      expect((await control.synth(page)).cancels).toBeGreaterThan(cancels);
      // No other voice was substituted and nothing more is spoken.
      const spoken = (await control.synth(page)).spoken.length;
      await page.getByTestId('read-aloud-play').first().click();
      await expect
        .poll(async () => await status().innerText())
        .toContain('Choose an on-device voice first');
      expect((await control.synth(page)).spoken.length).toBe(spoken);

      // 2. Starting dictation stops playback, and playback is refused while dictation listens.
      await page
        .locator('select')
        .filter({ hasText: 'Local Second' })
        .first()
        .selectOption('local-2');
      await page.getByTestId('read-aloud-play').first().click();
      await expect
        .poll(async () => await status().innerText())
        .toContain('Speaking on this device');
      const beforeDictation = (await control.synth(page)).cancels;
      await page.getByTestId('voice-talk').focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => voiceStatus(page)).toMatch(/Listening/);
      expect((await control.synth(page)).cancels).toBeGreaterThan(beforeDictation);
      await expect.poll(async () => await status().innerText()).not.toContain('Speaking');
      const spokenWhileListening = (await control.synth(page)).spoken.length;
      await page.getByTestId('read-aloud-play').first().click();
      await expect.poll(async () => await status().innerText()).toContain('Finish dictation first');
      expect((await control.synth(page)).spoken.length).toBe(spokenWhileListening);
      await page.getByTestId('aegis-stop').click();

      // 3. Lock while speaking cancels playback.
      await page.getByTestId('read-aloud-play').first().click();
      await expect
        .poll(async () => await status().innerText())
        .toContain('Speaking on this device');
      const beforeLock = (await control.synth(page)).cancels;
      await page.getByRole('link', { name: 'Vault', exact: true }).click();
      await page.getByRole('button', { name: 'Lock vault' }).click();
      await expect
        .poll(async () => (await control.synth(page)).cancels)
        .toBeGreaterThan(beforeLock);
      // Preferences hold a voice identifier only, never spoken text or matter names.
      const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
      expect(stored).not.toMatch(/24,000|SYSTEM-voice|GBP|Scripted test/);
    } finally {
      await page.context().close();
    }
  });
});

// Documented but not exercised through the page: model text is capped at 2,000 characters, so the
// 4,000-character bound cannot be reached from the production UI. It is asserted by
// apps/web/src/features/voice/voice.test.ts ("speaks plain text only, bounded to 4,000 characters").
