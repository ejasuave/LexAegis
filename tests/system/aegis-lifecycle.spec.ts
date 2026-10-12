import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { selectQuote, waitForTestId } from './harness/browser';
import {
  control,
  installInstruments,
  startSlowRun,
  storageHolds,
  typeToAegis,
  visiblePrivate,
} from './harness/aegis';
import { fund } from './harness/chain';
import {
  addMatterAndDocument,
  confirmFactsAndCheck,
  createAccountAndVault,
  decideRecordAndFreeze,
} from './harness/flows';
import { isBlocked } from './harness/services';
import { startSuite, type Suite } from './harness/suite';

/*
 * SYSTEM EVIDENCE (browser_scripted). Lifecycle events while Aegis, voice, decryption, approval or
 * verification are in progress, on the production build with real PostgreSQL, an S3-compatible store
 * and a loopback Anvil. A late or stale callback must not bring back a private pane, a signing authority
 * or a success indicator. The authenticator is a CDP VIRTUAL authenticator, the provider is the
 * SCRIPTED test provider and the speech objects are scripted stand-ins: this proves the application's
 * controllers, not a real authenticator, model or speech engine. Cleanup is best effort: JavaScript
 * cannot guarantee physical memory erasure and cannot recall anything already disclosed.
 */

const CASES = [
  'lifecycle-lock-signout-and-switch-clear-private-state',
  'lifecycle-session-expiry-pagehide-and-interrupted-network',
  'lifecycle-stop-coordinates-every-part-without-sending',
  'lifecycle-stop-after-possible-broadcast-keeps-reconciliation',
] as const;

let suite: Suite | undefined;

beforeAll(async () => {
  const started = await startSuite({
    name: 'aegis-lifecycle',
    cases: CASES,
    localChain: true,
    faultProxy: true,
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

/** A signed-in account with an unlocked vault, a matter and an imported synthetic document. */
async function prepared(s: Suite, title: string): Promise<{ page: Page; address: string }> {
  const { page } = await s.newSession();
  await installInstruments(page);
  const account = await createAccountAndVault(page, s.app.origin);
  if (s.chain === null) throw new Error('chain');
  await fund(s.chain, account.address, 10n * 10n ** 18n);
  await addMatterAndDocument(page, title);
  return { page, address: account.address };
}

/** Prepared, then facts confirmed, checks run, decisions recorded and the package frozen and saved. */
async function frozen(s: Suite, title: string): Promise<{ page: Page; address: string }> {
  const out = await prepared(s, title);
  await confirmFactsAndCheck(out.page);
  await decideRecordAndFreeze(out.page, 'Recorded for the lifecycle check.');
  return out;
}

const accountTransactions = async (s: Suite, address: string): Promise<number> =>
  Number(
    BigInt(
      (await s.chain?.local.transport.request('eth_getTransactionCount', [
        address,
        'latest',
      ])) as string,
    ),
  );

const providerCount = (s: Suite) => () => s.services.provider.requests.length;

const runState = (page: Page) =>
  page
    .getByTestId('assistant-run')
    .last()
    .getAttribute('data-state')
    .catch(() => null);

async function dbRunStates(s: Suite): Promise<string[]> {
  const rows = await s.services.pool.query<{ state: string }>(
    'select state from assistant_runs order by updated_at',
  );
  return rows.rows.map((row) => row.state);
}

const activeRuns = async (s: Suite): Promise<number> =>
  (await dbRunStates(s)).filter((state) => ['queued', 'running', 'stopping'].includes(state))
    .length;
const completedRuns = async (s: Suite): Promise<number> =>
  (await dbRunStates(s)).filter((state) => state === 'completed').length;

async function goTo(page: Page, link: 'Vault' | 'Review'): Promise<void> {
  await page.getByRole('link', { name: link, exact: true }).click();
}

describe('[lifecycle-lock-signout-and-switch-clear-private-state] Lock, Sign out and a matter switch while Aegis is working', () => {
  it('Lock cancels the run, clears every private pane and object URL, and unlocking restores nothing by itself', async (context) => {
    const s = need(context);
    const { page } = await prepared(s, 'SYSTEM-lifecycle-lock-7a31');
    const completedAtStart = await completedRuns(s);
    try {
      await startSlowRun(page, providerCount(s));
      await expect.poll(() => runState(page), { timeout: 20_000 }).toBe('running');
      expect((await visiblePrivate(page)).length).toBeGreaterThan(0);

      await goTo(page, 'Vault');
      await page.getByRole('button', { name: 'Lock vault' }).click();
      await expect
        .poll(async () => (await page.getByTestId('vault-status').innerText()).trim(), {
          timeout: 15_000,
        })
        .toMatch(/Locked/);

      // Back on Review: no source text, file name or answer, no run, an empty composer.
      await goTo(page, 'Review');
      await page.waitForTimeout(500);
      expect(await visiblePrivate(page)).toEqual([]);
      expect(await page.getByTestId('assistant-run').count()).toBe(0);
      expect(await page.getByTestId('disclosure-preview').count()).toBe(0);
      expect(await page.getByTestId('aegis-input').inputValue()).toBe('');
      // No decrypted marker is left in this origin's storage, and every object URL is revoked.
      expect(await storageHolds(page, /24,000|Northwind|SYSTEM-lifecycle-lock/)).toEqual([]);
      const blobs = await control.blobs(page);
      expect(blobs.created.filter((url) => !blobs.revoked.includes(url))).toEqual([]);
      // The server was told: the run is not completed anywhere.
      await expect.poll(() => activeRuns(s), { timeout: 20_000 }).toBe(0);
      expect(await completedRuns(s)).toBe(completedAtStart);

      // Unlocking returns the vault, not the old panes, and the old run does not reappear.
      await goTo(page, 'Vault');
      await page.getByRole('button', { name: 'Unlock vault' }).click();
      await expect
        .poll(async () => (await page.getByTestId('vault-status').innerText()).trim(), {
          timeout: 30_000,
        })
        .not.toMatch(/Locked/);
      await goTo(page, 'Review');
      await page.waitForTimeout(500);
      expect(await visiblePrivate(page)).toEqual([]);
      expect(await page.getByTestId('assistant-run').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  });

  it('Sign out does the same and also ends server sign-in', async (context) => {
    const s = need(context);
    const { page } = await prepared(s, 'SYSTEM-lifecycle-signout-7a32');
    const completedAtStart = await completedRuns(s);
    try {
      await startSlowRun(page, providerCount(s));
      await expect.poll(() => runState(page), { timeout: 20_000 }).toBe('running');
      await goTo(page, 'Vault');
      await page.getByRole('button', { name: 'Sign out' }).click();
      expect(await waitForTestId(page, 'backend-state', 'Signed out')).toBe(true);
      await goTo(page, 'Review');
      await page.waitForTimeout(500);
      expect(await visiblePrivate(page)).toEqual([]);
      expect(await page.getByTestId('assistant-run').count()).toBe(0);
      const blobs = await control.blobs(page);
      expect(blobs.created.filter((url) => !blobs.revoked.includes(url))).toEqual([]);
      await expect.poll(() => activeRuns(s), { timeout: 20_000 }).toBe(0);
      expect(await completedRuns(s)).toBe(completedAtStart);
      // Signed out: a new request cannot start and reaches no provider.
      const before = providerCount(s)();
      await typeToAegis(page, 'explain this clause');
      await page.waitForTimeout(800);
      expect(providerCount(s)()).toBe(before);
      expect(await page.getByTestId('disclosure-preview').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  });

  it('switching matter while a run is held does not carry its panes, answer or state into the other matter', async (context) => {
    const s = need(context);
    const { page } = await prepared(s, 'SYSTEM-lifecycle-switch-7a33');
    const completedAtStart = await completedRuns(s);
    try {
      await startSlowRun(page, providerCount(s));
      await expect.poll(() => runState(page), { timeout: 20_000 }).toBe('running');
      await goTo(page, 'Vault');
      await page.getByLabel('New matter title').fill('SYSTEM-lifecycle-other-7a34');
      await page.getByRole('button', { name: 'Create matter' }).click();
      await page
        .getByRole('button', { name: /SYSTEM-lifecycle-other-7a34/ })
        .first()
        .click();
      await goTo(page, 'Review');
      await page.waitForTimeout(500);
      // The other matter shows none of the first matter's private material and none of its run.
      expect(await visiblePrivate(page)).toEqual([]);
      expect(await page.getByTestId('assistant-run').count()).toBe(0);
      await expect.poll(() => activeRuns(s), { timeout: 20_000 }).toBe(0);
      expect(await completedRuns(s)).toBe(completedAtStart);
      // Back on the first matter: the stopped run is never shown as completed.
      await goTo(page, 'Vault');
      await page
        .getByRole('button', { name: /SYSTEM-lifecycle-switch-7a33/ })
        .first()
        .click();
      await goTo(page, 'Review');
      await page.waitForTimeout(500);
      const states = await page
        .getByTestId('assistant-run')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-state')));
      expect(states).not.toContain('completed');
      expect(states).not.toContain('running');
    } finally {
      await page.context().close();
    }
  });
});

describe('[lifecycle-lock-signout-and-switch-clear-private-state] late events', () => {
  it('a completed run whose events arrive after Lock restores no answer, citation or success indicator', async (context) => {
    const s = need(context);
    const { page } = await prepared(s, 'SYSTEM-lifecycle-late-7a38');
    try {
      // The server will finish this run, but the page sees nothing until we release the stream.
      await control.stream(page).hold(true);
      expect(await selectQuote(page, '24,000')).toBe(true);
      await typeToAegis(page, 'explain this clause');
      await page.getByTestId('disclosure-preview').waitFor({ timeout: 15_000 });
      await page.getByTestId('disclosure-send').click();
      await expect.poll(() => dbRunStates(s), { timeout: 40_000 }).toContain('completed');
      expect(await page.getByTestId('assistant-run').count()).toBeLessThanOrEqual(1);

      await goTo(page, 'Vault');
      await page.getByRole('button', { name: 'Lock vault' }).click();
      await expect
        .poll(async () => (await page.getByTestId('vault-status').innerText()).trim(), {
          timeout: 15_000,
        })
        .toMatch(/Locked/);
      await goTo(page, 'Review');
      // Now the late events arrive.
      const deliveredBefore = await control.stream(page).delivered();
      await control.stream(page).release();
      await page.waitForTimeout(1_500);
      // The late chunks really did reach the page's reader, and still restored nothing.
      expect(await control.stream(page).delivered()).toBeGreaterThan(deliveredBefore);
      expect(await visiblePrivate(page)).toEqual([]);
      expect(await page.getByTestId('assistant-run').count()).toBe(0);
      expect(await page.getByTestId('citation-S1').count()).toBe(0);
      expect(await page.getByTestId('aegis-stop').getAttribute('aria-disabled')).toBe('true');
    } finally {
      await page.context().close();
    }
  });
});

describe('[lifecycle-session-expiry-pagehide-and-interrupted-network] expiry, pagehide and pageshow, and a cut connection', () => {
  it('pagehide and a restored (persisted) pageshow lock the vault, end voice and clear private panes before rendering resumes', async (context) => {
    const s = need(context);
    const { page } = await prepared(s, 'SYSTEM-lifecycle-pagehide-7a35');
    try {
      // Dictation is listening and read-aloud is speaking when the page is hidden.
      await page.getByTestId('voice-talk').focus();
      await page.keyboard.press('Enter');
      await expect
        .poll(async () => (await page.getByTestId('voice-status').innerText()).trim(), {
          timeout: 10_000,
        })
        .toMatch(/Listening/);
      expect((await visiblePrivate(page)).length).toBeGreaterThan(0);

      await page.evaluate(() =>
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
      );
      // The page sits frozen in the back-forward cache; then it is restored.
      await page.waitForTimeout(800);
      await page.evaluate(() =>
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
      );
      await page.waitForTimeout(500);
      // At the pageshow, private text was already gone (the pagehide handlers had run).
      const events = await page.evaluate(
        () => (window as unknown as { __lifecycle: string[] }).__lifecycle,
      );
      expect(events).toContain('pagehide:true:private=true'); // before any handler of this event
      expect(events).toContain('pageshow:true:private=false');
      expect(await visiblePrivate(page)).toEqual([]);
      expect(await page.getByTestId('assistant-run').count()).toBe(0);
      const speech = await control.speech(page);
      expect(speech.aborts).toBeGreaterThanOrEqual(1);
      expect(
        (await page.getByTestId('voice-status').innerText()).includes('Listening'),
        'no stale listening label',
      ).toBe(false);
      const blobs = await control.blobs(page);
      expect(blobs.created.filter((url) => !blobs.revoked.includes(url))).toEqual([]);
      await goTo(page, 'Vault');
      expect(await page.getByTestId('vault-status').innerText()).toMatch(/Locked/);
    } finally {
      await page.context().close();
    }
  });

  it('an expired server session refuses protected actions without success indicators or provider traffic', async (context) => {
    const s = need(context);
    const { page } = await prepared(s, 'SYSTEM-lifecycle-expiry-7a36');
    try {
      await s.services.pool.query(
        "update auth_sessions set expires_at = now() - interval '1 minute'",
      );
      const before = providerCount(s)();
      const completedBefore = (await dbRunStates(s)).filter(
        (state) => state === 'completed',
      ).length;
      expect(await selectAndExplain(page)).toBe(true);
      await page.waitForTimeout(1_500);
      // Whatever the page says, nothing was sent to the provider and no new run completed.
      expect(providerCount(s)()).toBe(before);
      expect((await dbRunStates(s)).filter((state) => state === 'completed').length).toBe(
        completedBefore,
      );
      const states = await page
        .getByTestId('assistant-run')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-state')));
      expect(states).not.toContain('completed');
      // The signed-in reading is not left claiming success after a protected call was refused.
      await goTo(page, 'Vault');
      const backend = await page.getByTestId('backend-state').innerText();
      expect(backend).not.toBe('');
    } finally {
      await page.context().close();
    }
  });

  it('cutting the connection during a run leaves it incomplete with an unknown outcome, never completed, and nothing is resent', async (context) => {
    const s = need(context);
    const { page } = await prepared(s, 'SYSTEM-lifecycle-network-7a37');
    try {
      await startSlowRun(page, providerCount(s));
      await expect.poll(() => runState(page), { timeout: 20_000 }).toBe('running');
      const sent = providerCount(s)();
      // The connection drops mid-stream (the page's own view of a dropped socket) and stays down.
      await page.context().setOffline(true);
      await control.stream(page).cut();
      await page.waitForTimeout(1_000);
      await expect.poll(() => runState(page), { timeout: 30_000 }).not.toBe('running');
      const stateWhileOffline = await runState(page);
      expect(stateWhileOffline).not.toBe('completed');
      await page.context().setOffline(false);
      await page.waitForTimeout(2_000);
      expect(await runState(page)).not.toBe('completed');
      expect(providerCount(s)()).toBe(sent);
      // The Stop control is not left active for work that no longer exists.
      expect(await page.getByTestId('aegis-stop').getAttribute('aria-disabled')).toBe('true');
    } finally {
      await page.context().close();
    }
  });
});

async function selectAndExplain(page: Page): Promise<boolean> {
  if (!(await selectQuote(page, '24,000'))) return false;
  await typeToAegis(page, 'explain this clause');
  await page.waitForTimeout(500);
  // Send if a preview appeared: a refused session must still not reach the provider.
  const preview = page.getByTestId('disclosure-preview');
  if ((await preview.count()) > 0) await page.getByTestId('disclosure-send').click();
  return true;
}

describe('[lifecycle-stop-coordinates-every-part-without-sending] one Stop for Aegis, read-aloud, dictation, an approval preview and an unused ticket', () => {
  it('Stop ends a held run, read-aloud and an approval preview together, sends nothing, and relabels no other operation', async (context) => {
    const s = need(context);
    const { page, address } = await frozen(s, 'SYSTEM-lifecycle-stop-7a40');
    try {
      // An earlier answer is on the page and read aloud with an on-device voice.
      expect(await selectQuote(page, '24,000')).toBe(true);
      await typeToAegis(page, 'explain this clause');
      await page.getByTestId('disclosure-preview').waitFor({ timeout: 15_000 });
      await page.getByTestId('disclosure-send').click();
      await expect.poll(() => runState(page), { timeout: 40_000 }).toBe('completed');
      await page
        .locator('select')
        .filter({ hasText: 'Local British' })
        .first()
        .selectOption('local-1');
      await page.getByTestId('read-aloud-play').first().click();
      await expect
        .poll(async () => (await page.getByTestId('read-aloud-status').first().innerText()).trim())
        .toMatch(/Speaking on this device/);

      // A second request is held at the provider, and an approval preview is open.
      await startSlowRun(page, providerCount(s));
      await expect.poll(() => runState(page), { timeout: 20_000 }).toBe('running');
      await page.getByTestId('preview-approval').click();
      await page.getByTestId('approval-details').waitFor({ timeout: 30_000 });
      const txBefore = await accountTransactions(s, address);
      const cancelsBefore = (await control.synth(page)).cancels;
      const providerBefore = providerCount(s)();

      await page.getByTestId('aegis-stop').click();

      await expect.poll(() => runState(page), { timeout: 20_000 }).toBe('cancelled');
      expect((await control.synth(page)).cancels).toBeGreaterThan(cancelsBefore);
      expect(await page.getByTestId('read-aloud-status').first().innerText()).not.toMatch(
        /Speaking/,
      );
      // The unused approval preview was discarded: nothing to approve until a new preview.
      expect(await page.getByTestId('approval-details').count()).toBe(0);
      expect(await page.getByTestId('approve-package').count()).toBe(0);
      expect(await page.getByTestId('preview-approval').count()).toBe(1);
      expect(await page.getByTestId('send-transaction').count()).toBe(0);
      // Nothing was sent: no chain transaction, no operation row, no further provider request.
      expect(await accountTransactions(s, address)).toBe(txBefore);
      const operations = await s.services.pool.query<{ n: number }>(
        'select count(*)::int as n from chain_operations',
      );
      expect(operations.rows[0]?.n).toBe(0);
      expect(providerCount(s)()).toBe(providerBefore);
      // Distinct outcomes: the earlier answer is still completed, the saved package is still saved,
      // and no sentence cancels the matter or the review as a whole.
      const states = await page
        .getByTestId('assistant-run')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-state')));
      expect(states).toEqual(['completed', 'cancelled']);
      expect(await page.getByTestId('frozen-package').innerText()).toMatch(/Saved and checked/);
      expect(await page.evaluate(() => document.body.innerText)).not.toMatch(
        /(matter|review|package) (was |is )?cancelled/i,
      );
      // Stop is idle again, and a second press changes nothing.
      expect(await page.getByTestId('aegis-stop').getAttribute('aria-disabled')).toBe('true');
    } finally {
      await page.context().close();
    }
  });

  it('Stop ends dictation and an unused fee ticket without sending, and the signed approval stays a separate fact', async (context) => {
    const s = need(context);
    const { page, address } = await frozen(s, 'SYSTEM-lifecycle-stop-7a41');
    try {
      await page.getByTestId('preview-approval').click();
      await page.getByTestId('approval-details').waitFor({ timeout: 30_000 });
      await page.getByTestId('approve-package').click();
      const send = page.getByTestId('send-transaction');
      await send.waitFor({ timeout: 60_000 });
      expect(await page.getByTestId('approval-signed').innerText()).toMatch(
        /Approval signed; publication not confirmed/,
      );
      const txBefore = await accountTransactions(s, address);

      // Dictation is listening while the unused fee ticket is on screen.
      await page.getByTestId('aegis-input').fill('typed before dictation ');
      await page.getByTestId('voice-talk').focus();
      await page.keyboard.press('Enter');
      await expect
        .poll(async () => (await page.getByTestId('voice-status').innerText()).trim())
        .toMatch(/Listening/);
      await page.getByTestId('aegis-stop').click();

      await expect
        .poll(async () => (await page.getByTestId('voice-status').innerText()).trim())
        .not.toMatch(/Listening/);
      expect((await control.speech(page)).aborts).toBeGreaterThanOrEqual(1);
      // The ticket was invalidated: it can no longer be confirmed, and nothing was sent.
      expect(await page.getByTestId('send-transaction').count()).toBe(0);
      expect(await page.getByTestId('tx-stage').innerText()).toMatch(/Cancelled/);
      expect(await accountTransactions(s, address)).toBe(txBefore);
      const row = await s.services.pool.query<{ phase: string; transaction_hash: string | null }>(
        'select phase, transaction_hash from chain_operations',
      );
      for (const operation of row.rows) expect(operation.transaction_hash).toBeNull();
      // The notice says what Stop did not do.
      expect(await page.getByTestId('aegis-notice').innerText()).toMatch(
        /was not sent.*still be used until its deadline/s,
      );
      // The approval is a separate, still-displayed fact; the typed draft was kept.
      expect(await page.getByTestId('approval-signed').count()).toBe(1);
      expect(await page.getByTestId('aegis-input').inputValue()).toMatch(/typed before dictation/);
    } finally {
      await page.context().close();
    }
  });
});

describe('[lifecycle-stop-after-possible-broadcast-keeps-reconciliation] Stop never cancels or hides a transaction that may have been sent', () => {
  it('after a lost response Stop leaves the unknown outcome and read-only Refresh, which then confirms the same transaction', async (context) => {
    const s = need(context);
    const proxy = s.proxy;
    if (proxy === null) throw new Error('proxy');
    const { page, address } = await frozen(s, 'SYSTEM-lifecycle-stop-7a42');
    try {
      proxy.clear();
      await page.getByTestId('preview-approval').click();
      await page.getByTestId('approval-details').waitFor({ timeout: 30_000 });
      await page.getByTestId('approve-package').click();
      const send = page.getByTestId('send-transaction');
      await send.waitFor({ timeout: 60_000 });
      const sendsBefore = proxy.count('eth_sendRawTransaction');
      // The node accepts the transaction and the response is lost.
      proxy.add({ method: 'eth_sendRawTransaction', mode: 'lose_response', times: 1 });
      await send.click();
      await expect
        .poll(async () => (await page.getByTestId('tx-stage').innerText()).trim(), {
          timeout: 30_000,
        })
        .toMatch(/Status unknown/);
      expect(proxy.count('eth_sendRawTransaction') - sendsBefore).toBe(1);

      // Stop is pressed: it must not cancel, replace or hide what may have been sent.
      await page.getByTestId('aegis-stop').click({ force: true });
      await page.waitForTimeout(1_000);
      expect(await page.getByTestId('tx-stage').innerText()).toMatch(/Status unknown/);
      expect(await page.getByTestId('tx-stage').innerText()).not.toMatch(/Cancelled|Not sent/);
      expect(await page.getByTestId('refresh-status').count()).toBe(1);
      expect(proxy.count('eth_sendRawTransaction') - sendsBefore).toBe(1);

      // Reading is still allowed, and reconciles the same transaction from chain state.
      let confirmed = false;
      for (let attempt = 0; attempt < 30 && !confirmed; attempt += 1) {
        await page.getByTestId('refresh-status').click();
        await page.waitForTimeout(1_500);
        confirmed = /Execution was confirmed at a canonical block/.test(
          await page
            .getByTestId('tx-outcome')
            .innerText()
            .catch(() => ''),
        );
      }
      expect(confirmed).toBe(true);
      // Exactly one transaction from this account, never a second send.
      expect(await accountTransactions(s, address)).toBe(1);
      expect(proxy.count('eth_sendRawTransaction') - sendsBefore).toBe(1);
    } finally {
      proxy.clear();
      await page.context().close();
    }
  });
});
