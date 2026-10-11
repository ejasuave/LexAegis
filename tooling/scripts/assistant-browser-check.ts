/**
 * pnpm test:assistant:browser
 *
 * Chapter 9 Aegis assistant in real headless Chromium on the production build, with a CDP VIRTUAL
 * authenticator (PRF enabled), a real throwaway PostgreSQL, a real S3-compatible server and a
 * SCRIPTED loopback provider that speaks the Chat Completions wire format. No model is called.
 *
 * One synthetic path: selected document -> explicit disclosure -> Aegis request -> native tool
 * execution -> cited response -> human fact confirmation -> refreshed deterministic check ->
 * explicit encrypted saved outcome, with Stop and stale-input rejection on the same path, in
 * both layouts and by keyboard. Recorded as virtual_authenticator evidence with a scripted
 * provider: it shows nothing about Qwen, real devices or real legal documents.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import { chromium, type Page } from 'playwright';
import { migrate } from '../../apps/web/src/server/db/migrate';
import { startLocalS3 } from '../../apps/web/src/test-support/local-s3';
import { startScriptedQwenServer } from '../../apps/web/src/test-support/scripted-qwen-server';
import { startLocalPostgres } from '../../test-support/embedded-pg';
import { recordEvidence } from '../src/evidence-writer';
import { ROOT, stamp } from './lib';

const PORT = 3103;
const ORIGIN = `http://localhost:${String(PORT)}`;
const WEB = join(ROOT, 'apps', 'web');
const SENTINEL_TITLE = 'SENTINEL-assistant-matter-9c41';
const PDFS = join(ROOT, 'fixtures', 'documents-v1', 'pdfs');
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
};

function run(command: string, args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: WEB,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function waitFor(page: Page, id: string, expected: string | RegExp): Promise<boolean> {
  try {
    await page
      .locator(`[data-testid="${id}"]`)
      .filter({ hasText: expected })
      .first()
      .waitFor({ timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

const postgres = await startLocalPostgres();
const s3 = await startLocalS3();
const provider = await startScriptedQwenServer();
const env = {
  NEXT_DIST_DIR: '.next-assistant-check',
  NEXT_TELEMETRY_DISABLED: '1',
  NEXT_PUBLIC_APP_ORIGIN: ORIGIN,
  NEXT_PUBLIC_WEBAUTHN_RP_ID: 'localhost',
  NEXT_PUBLIC_CHAIN_ID: '10143',
  DATABASE_URL: postgres.url,
  S3_ENDPOINT: s3.endpoint,
  S3_BUCKET: s3.bucket,
  S3_REGION: s3.region,
  S3_ACCESS_KEY_ID: s3.accessKeyId,
  S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
  WEB_PORT: String(PORT),
  // The explicit scripted test mode. It refuses to start alongside a real key, so none is passed.
  LEXAEGIS_TEST_MODE: 'scripted-assistant',
  ASSISTANT_TEST_PROVIDER_URL: provider.baseUrl,
  QWEN_API_KEY: '',
  QWEN_BASE_URL: '',
  QWEN_OUTPUT_MODE: '',
};
let server: ChildProcess | null = null;
const browser = await chromium.launch({ headless: true });

try {
  const pool = new Pool({ connectionString: postgres.url });
  pool.on('connect', (client) => client.on('error', () => undefined));
  pool.on('error', () => undefined);
  await migrate(pool);

  check('production build', (await run('pnpm', ['exec', 'next', 'build'], env)) === 0);
  server = spawn('pnpm', ['exec', 'next', 'start', '--port', String(PORT)], {
    cwd: WEB,
    env: { ...process.env, ...env },
    stdio: 'ignore',
    detached: true,
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${ORIGIN}/api/health`)).ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  const version = browser.version();
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text()))
      violations.push(message.text().slice(0, 160));
  });
  const requests: { method: string; url: string; body: string }[] = [];
  const outside: string[] = [];
  page.on('request', (request) => {
    if (
      !request.url().startsWith(ORIGIN) &&
      !request.url().startsWith('data:') &&
      !request.url().startsWith('blob:')
    ) {
      outside.push(request.url().slice(0, 100));
    }
    if (request.url().includes('/api/')) {
      requests.push({
        method: request.method(),
        url: request.url(),
        body: (request.postDataBuffer() ?? Buffer.alloc(0)).toString('utf8'),
      });
    }
  });
  const runPosts = () =>
    requests.filter((r) => r.method === 'POST' && r.url === `${ORIGIN}/api/assistant/runs`);

  await page.addInitScript('window.__name = (target) => target;');
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    } as never,
  });

  const has = (text: string | RegExp, timeout = 20_000) =>
    page
      .getByText(text)
      .first()
      .waitFor({ timeout })
      .then(
        () => true,
        () => false,
      );
  const selectQuote = (quote: string) =>
    page.evaluate((q) => {
      const region = document.querySelector('[aria-label^="Extracted text"]');
      if (region === null) return false;
      const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        const at = text.data.indexOf(q);
        if (at >= 0) {
          const range = document.createRange();
          range.setStart(text, at);
          range.setEnd(text, at + q.length);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          region.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          return true;
        }
      }
      return false;
    }, quote);
  const confirmFact = async (field: string, slot: string, quote: string) => {
    await page.getByLabel(/^Field/).selectOption({ label: field });
    await page.getByLabel(/^Slot/).fill(slot);
    const selected = await selectQuote(quote);
    await page.getByRole('button', { name: 'Confirm fact' }).click();
    return selected && (await has('Fact confirmed'));
  };

  const runCards = page.getByTestId('assistant-run');
  /** Waits until there are exactly `count` run cards and the last one is in `state`. */
  const runIs = (count: number, state: string, timeout = 30_000) =>
    page
      .waitForFunction(
        ([n, s]) => {
          const cards = document.querySelectorAll('[data-testid="assistant-run"]');
          return cards.length === n && cards[cards.length - 1]?.getAttribute('data-state') === s;
        },
        [count, state] as const,
        { timeout },
      )
      .then(
        () => true,
        () => false,
      );
  const typeCommand = async (text: string) => {
    await page.getByTestId('aegis-input').click();
    await page.getByTestId('aegis-input').fill(text);
    await page.keyboard.press('Enter');
  };
  const preview = page.getByTestId('disclosure-preview');
  const previewShown = () =>
    preview.waitFor({ timeout: 15_000 }).then(
      () => true,
      () => false,
    );
  const notice = () => page.getByTestId('aegis-notice').innerText();

  // ---- Account, vault, matter, document and four cited facts (Chapter 4, 5 and 8 flows) ----------
  await page.goto(`${ORIGIN}/vault`);
  await page.getByRole('button', { name: 'Create account and sign in' }).click();
  check('account ready', await waitFor(page, 'account-status', 'Account ready'));
  await page.getByRole('button', { name: 'Create vault' }).click();
  check('vault created and unlocked', await waitFor(page, 'vault-status', 'Saved'));
  await page.getByLabel('New matter title').fill(SENTINEL_TITLE);
  await page.getByRole('button', { name: 'Create matter' }).click();
  await page
    .getByRole('button', { name: new RegExp(SENTINEL_TITLE) })
    .first()
    .waitFor({ timeout: 15_000 });
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByTestId('pdf-input').setInputFiles(join(PDFS, 'discrepancy-2000.pdf'));
  check('synthetic PDF imported', await has(/discrepancy-2000\.pdf: saved encrypted/, 40_000));
  await page.getByRole('button', { name: 'Next page' }).click();
  await has(/Total settlement payment: GBP 24,000/);
  const facts = [
    await confirmFact('Payment total (pence)', 'total', '24,000'),
    await confirmFact('Payment instalment (pence)', 'i1', '10,000'),
    await confirmFact('Payment instalment (pence)', 'i2', '12,000'),
    await confirmFact('Payment basis (gross or net)', 'basis', 'gross'),
  ];
  check('four cited facts confirmed', facts.every(Boolean), facts.join(','));

  // ---- Availability: the scripted provider is shown as what it is --------------------------------
  const readiness = (await (await fetch(`${ORIGIN}/api/readiness`)).json()) as {
    capabilities: { name: string; state: string }[];
  };
  check(
    'readiness never reports the scripted provider as verified Qwen',
    readiness.capabilities.find((c) => c.name === 'assistant.qwen')?.state !== 'verified',
    readiness.capabilities.find((c) => c.name === 'assistant.qwen')?.state ?? '',
  );
  check('docked orb reads Ready in Review mode', await has('Ready'));

  // ---- 1. Explain selection: disclosure first, nothing sent until Send ------------------------------
  await selectQuote('24,000');
  await page.getByTestId('explain-selection').click();
  check('disclosure preview appears before anything is sent', await previewShown());
  const previewText = await preview.innerText();
  check(
    'preview names the provider, region, matter, document and the one excerpt',
    /Scripted test provider \(not Qwen\)/.test(previewText) &&
      /test-loopback/.test(previewText) &&
      previewText.includes(SENTINEL_TITLE) &&
      /discrepancy-2000\.pdf/.test(previewText) &&
      /S1: page 2, 6 bytes/.test(previewText),
    previewText.replace(/\s+/g, ' ').slice(0, 200),
  );
  check(
    'preview states that text reaches the server and provider, without residency or retention claims',
    /sent in readable form to the LexAegis server/.test(previewText) &&
      /does not prove where data is processed/.test(previewText) &&
      /not end-to-end encrypted through analysis/.test(previewText) &&
      !/zero retention|UK-only|is end-to-end encrypted/i.test(previewText),
  );
  check('no run request before Send', runPosts().length === 0 && provider.requests.length === 0);
  await page.getByTestId('disclosure-send').click();
  check('run 1 finished', await runIs(1, 'completed'));
  const first = runCards.nth(0);
  check(
    'answer is labelled as the scripted test provider',
    (await first.getAttribute('data-model')) === 'scripted-test' &&
      /Scripted test provider \(not Qwen\)/.test(await first.innerText()),
  );
  check(
    'a native tool call ran: read_sources succeeded',
    (await first
      .locator('[data-testid="assistant-tool"][data-tool="read_sources"][data-outcome="succeeded"]')
      .count()) === 1,
  );
  const quotation = first.locator(
    '[data-testid="assistant-block"][data-kind="quotation"] blockquote',
  );
  check('quotation shows the stored quote', (await quotation.innerText()).trim() === '24,000');
  check(
    'task steps are shown',
    (await first.getByTestId('assistant-steps').locator('li').count()) === 4,
  );
  const sent = runPosts()[0]?.body ?? '';
  check(
    'the request carried the selected excerpt and consent, and not the rest of the document',
    sent.includes('"quote":"24,000"') &&
      sent.includes('"action":"explicit_send"') &&
      !/Northwind|10,000|12,000/.test(sent),
    `bytes=${String(sent.length)}`,
  );
  check(
    'the provider received handles first and the excerpt only through the tool result',
    !(provider.requests[0]?.messages?.[1]?.content ?? '').includes('24,000') &&
      (provider.requests[1]?.messages ?? []).some(
        (message) => message.role === 'tool' && (message.content ?? '').includes('24,000'),
      ) &&
      !JSON.stringify(provider.requests).includes(SENTINEL_TITLE),
  );

  // ---- 2. Exact-source opening ----------------------------------------------------------------------
  await first.getByTestId('citation-S1').first().click();
  const highlighted = await page.getByTestId('source-highlight').first().innerText();
  check('citation reopens the exact passage', highlighted === '24,000', highlighted);

  // ---- 3. Local deterministic check by keyboard: no disclosure, no request --------------------------
  await typeCommand('/check-payments');
  check('run 2 (local check) finished', await runIs(2, 'completed'));
  const second = runCards.nth(1);
  const localResult = second.getByTestId('payment-result');
  check(
    'local payment check shows the calculator result, with no model and no request',
    (await second.getAttribute('data-origin')) === 'local' &&
      (await second.getAttribute('data-model')) === 'none' &&
      (await localResult.getAttribute('data-difference')) === '200000' &&
      /£2,000\.00/.test(await localResult.innerText()) &&
      runPosts().length === 1,
  );

  // ---- 4. Ask Aegis about it: disclosed, sent by keyboard, totals from the tool result --------------
  await second.getByTestId('ask-aegis-payments').click();
  check('payment explanation needs its own disclosure', await previewShown());
  check(
    'that disclosure lists the four payment facts',
    /Confirmed facts\s*4/.test(await preview.innerText()),
  );
  await page.getByTestId('disclosure-send').focus();
  await page.keyboard.press('Enter');
  check('run 3 finished', await runIs(3, 'completed'));
  const third = runCards.nth(2);
  check(
    'displayed total comes from the check_payments tool result',
    (await third.getByTestId('payment-result').getAttribute('data-difference')) === '200000' &&
      (await third
        .locator('[data-testid="assistant-tool"][data-tool="check_payments"]')
        .count()) === 1,
  );

  // ---- 5. Stop during a provider wait ---------------------------------------------------------------
  await selectQuote('24,000');
  const providerBefore = provider.requests.length;
  await typeCommand('Please explain this clause SLOW-TEST');
  await previewShown();
  await page.getByTestId('disclosure-send').click();
  check('run 4 is working', await runIs(4, 'running'));
  check('orb label follows the real state', await has('Working'));
  await page.getByTestId('aegis-stop').click();
  check('run 4 was cancelled after Stop', await runIs(4, 'cancelled', 15_000));
  const fourth = runCards.nth(3);
  check(
    'the stopped run is labelled incomplete and never completed',
    (await fourth.getAttribute('data-complete')) === 'false' &&
      (await fourth.getByTestId('assistant-incomplete').count()) === 1,
  );
  // The control is now aria-disabled; a second activation must still do nothing.
  await page.getByTestId('aegis-stop').click({ force: true });
  check('repeated Stop is harmless', (await runCards.count()) === 4);
  const stopped = await pool.query<{ state: string }>(
    "SELECT state FROM assistant_runs WHERE state = 'cancelled'",
  );
  check(
    'the run is cancelled server side and nothing was dispatched after Stop',
    stopped.rowCount === 1 && provider.requests.length === providerBefore + 1,
    `rows=${String(stopped.rowCount)} provider=${String(provider.requests.length - providerBefore)}`,
  );

  // ---- 6. Proposal -> explicit human confirmation ---------------------------------------------------
  await selectQuote('24,000');
  await typeCommand('Please explain this clause PROPOSE-TEST');
  await previewShown();
  await page.getByTestId('disclosure-send').click();
  check('run 5 asks for input', await runIs(5, 'awaiting_input'));
  const fifth = runCards.nth(4);
  const proposal = fifth.getByTestId('fact-proposal');
  check(
    'a proposed fact is shown as proposed, beside its source',
    /Proposed, not confirmed/.test(await proposal.innerText()) &&
      /Northwind Analytics Ltd/.test(await proposal.innerText()),
  );
  const factLine = /employer \/ settlement\.employer = Northwind Analytics Ltd/;
  await typeCommand('yes');
  await page.waitForTimeout(400);
  await typeCommand('approve');
  await page.waitForTimeout(400);
  check(
    'typing yes or approve confirms nothing',
    (await page.getByText(factLine).count()) === 0 &&
      (await proposal.getAttribute('data-decision')) === 'open' &&
      /cannot approve/.test(await notice()),
    await notice(),
  );
  await proposal.getByTestId('proposal-confirm').click();
  check(
    'Confirm records the fact by the reviewer',
    (await has(factLine)) && (await proposal.getAttribute('data-decision')) === 'confirmed',
  );
  check(
    'earlier assistant results are marked out of date after the confirmation',
    (await first.getByTestId('assistant-stale').count()) === 1,
  );

  // ---- 7. Refreshed deterministic check -------------------------------------------------------------
  await typeCommand('/check-payments');
  check('run 6 (refreshed check) finished', await runIs(6, 'completed'));
  check(
    'the refreshed check uses the current facts',
    (await runCards.nth(5).getByTestId('payment-result').getAttribute('data-difference')) ===
      '200000' && (await runCards.nth(5).getByTestId('assistant-stale').count()) === 0,
  );

  // ---- 8. Explicit encrypted Save outcome -----------------------------------------------------------
  await selectQuote('24,000');
  await page.getByTestId('explain-selection').click();
  await previewShown();
  await page.getByTestId('disclosure-send').click();
  check('run 7 finished', await runIs(7, 'completed'));
  const seventh = runCards.nth(6);
  const objectsBefore = Number(
    (await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM vault_objects')).rows[0]?.n ??
      0,
  );
  check(
    'a result is unsaved until the reviewer saves it',
    (await seventh.getByTestId('save-state').getAttribute('data-save')) === 'unsaved',
  );
  await seventh.getByTestId('save-outcome').click();
  const savedOk = await seventh
    .locator('[data-testid="save-state"][data-save="saved"]')
    .waitFor({ timeout: 30_000 })
    .then(
      () => true,
      () => false,
    );
  check(
    'Save outcome shows saved only after read-back',
    savedOk,
    await seventh.getByTestId('save-state').innerText(),
  );
  const objectsAfter = Number(
    (await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM vault_objects')).rows[0]?.n ??
      0,
  );
  check(
    'the outcome was stored as ciphertext objects',
    objectsAfter >= objectsBefore + 2,
    `${String(objectsBefore)} -> ${String(objectsAfter)}`,
  );
  await page
    .getByRole('tab', { name: 'Document' })
    .click()
    .catch(() => undefined);
  check(
    'the saved outcome is listed as an unconfirmed assistant observation',
    await has(/Unconfirmed:\s*Assistant observation:/),
  );

  // ---- 9. Stale inputs: a pending disclosure is dropped, nothing is sent ----------------------------
  await page
    .getByRole('tab', { name: 'Aegis' })
    .click()
    .catch(() => undefined);
  await selectQuote('24,000');
  await page.getByTestId('explain-selection').click();
  await previewShown();
  const postsBefore = runPosts().length;
  await confirmFact('Employee', 'employee', 'GBP');
  const dropped = await preview.waitFor({ state: 'detached', timeout: 10_000 }).then(
    () => true,
    () => false,
  );
  check(
    'a fact change drops the pending disclosure; renewed consent is required',
    dropped && runPosts().length === postsBefore,
    await notice(),
  );

  // ---- 10. Both layouts share one conversation ------------------------------------------------------
  await page.getByRole('button', { name: 'Command centre', exact: true }).click();
  check(
    'Command centre shows the expanded orb caption and the same conversation',
    (await page.getByTestId('orb-caption').count()) === 1 && (await runCards.count()) === 7,
    `runs=${String(await runCards.count())}`,
  );
  await typeCommand('/status');
  check('run 8 (local status) finished in the Command centre', await runIs(8, 'completed'));
  check(
    'status keeps browser and assistant readings apart',
    /Vault \(this browser\)/.test(await runCards.nth(7).innerText()) &&
      runPosts().length === postsBefore,
  );
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  check('Review mode shows the same conversation, docked', (await runCards.count()) === 8);
  await page.getByRole('button', { name: /Activity/ }).click();
  check(
    'the activity drawer lists assistant runs apart from human decisions and chain events',
    (await has(/explain, completed; tools: read sources/)) &&
      (await page
        .getByRole('tab', { name: 'Human decisions' })
        .click()
        .then(() => has('No recorded decisions.'))),
  );
  await page.getByRole('button', { name: 'Close' }).click();

  // ---- 11. Lock clears the conversation -------------------------------------------------------------
  await page.getByRole('link', { name: 'Vault', exact: true }).click();
  await page.getByRole('button', { name: 'Lock vault' }).click();
  check('vault locked', await waitFor(page, 'vault-status', 'Locked'));
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.waitForTimeout(500);
  const locked = (await page.content()) + (await page.locator('body').innerText());
  check(
    'lock: no conversation, quote, proposal or matter title remains in the page',
    (await runCards.count()) === 0 &&
      !/24,000|Northwind|Scripted test answer|SENTINEL|Assistant observation/.test(locked),
  );

  // ---- Privacy surface ------------------------------------------------------------------------------
  const vaultBodies = requests
    .filter((r) => r.url.includes('/api/vault'))
    .map((r) => r.body)
    .join('\n');
  check(
    'vault requests carry no plaintext of the conversation or the saved outcome',
    !/Scripted test answer|Northwind Analytics|assistant-analysis|24,000|SENTINEL/.test(
      vaultBodies,
    ),
  );
  check(
    'private data never travels in a URL',
    requests.every((r) => {
      const path = r.url.replace(ORIGIN, '');
      // The only query the application makes: a page size on the PUBLIC history of a public
      // address (Chapter 7). Nothing private, no fragment, no other parameter.
      const publicHistory = /^\/api\/history\/reviewers\/0x[0-9a-f]{40}\?limit=\d{1,3}$/.test(path);
      return (publicHistory || !/[?#]/.test(path)) && !/24,000|Northwind/.test(r.url);
    }),
    requests.find((r) => /[?#]/.test(r.url.replace(ORIGIN, '')))?.url ?? '',
  );
  check(
    'selected text was sent only by the five explicit Sends',
    runPosts().length === 5,
    `posts=${String(runPosts().length)}`,
  );
  const rows = await pool.query('SELECT * FROM assistant_runs');
  const table = JSON.stringify(rows.rows);
  check(
    'operational rows hold IDs, state and counters only',
    rows.rowCount !== null &&
      rows.rowCount >= 4 &&
      !/24,000|Northwind|SENTINEL|settlement|0x[0-9a-f]{64}/.test(table),
    `rows=${String(rows.rowCount)}`,
  );
  check('only this origin was contacted by the browser', outside.length === 0, outside[0] ?? '');
  const storage = await page.evaluate(async () => ({
    local: JSON.stringify(Object.entries(localStorage)),
    session: JSON.stringify(Object.entries(sessionStorage)),
    databases: (await indexedDB.databases()).length,
    workers: (await navigator.serviceWorker.getRegistrations()).length,
    caches: (await caches.keys()).length,
  }));
  check(
    'nothing of the conversation is in localStorage, sessionStorage, IndexedDB, caches or service workers',
    !/24,000|Northwind|Scripted|SENTINEL|lexaegis\.assistant/.test(
      storage.local + storage.session,
    ) &&
      storage.databases === 0 &&
      storage.workers === 0 &&
      storage.caches === 0,
  );
  check(
    'every provider request disabled thinking, search and streaming, with the placeholder credential',
    provider.requests.length > 0 &&
      provider.requests.every(
        (body) =>
          body.enable_thinking === false && body.enable_search === false && body.stream === false,
      ) &&
      provider.authorizations.every((value) => value === 'Bearer scripted-test-no-key'),
    `requests=${String(provider.requests.length)}`,
  );
  check('no Content Security Policy violation', violations.length === 0, violations[0] ?? '');
  await pool.end();

  const ok = checks.every((item) => item.ok);
  await recordEvidence({
    root: ROOT,
    results: [
      stamp({
        id: `assistant-browser-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
        subject: 'assistant-browser-check',
        command: 'pnpm test:assistant:browser',
        evidenceClass: 'virtual_authenticator',
        outcome: ok ? 'pass' : 'fail',
        reasonCodes: [
          'AUTHENTICATOR_MODE_VIRTUAL',
          'SYNTHETIC_DOCUMENTS_ONLY',
          'SCRIPTED_PROVIDER_NOT_QWEN',
          ...(ok ? [] : ['CHECKS_FAILED']),
        ],
        facts: {
          browser: `chromium ${version}`,
          checksPassed: String(checks.filter((item) => item.ok).length),
          checksTotal: String(checks.length),
          provider: 'scripted-test (loopback, no model)',
          storage: 'postgresql + versitygw',
          authenticatorMode: 'virtual',
          realDeviceEvidence: false,
          liveProviderEvidence: false,
        },
      }),
    ],
  });
  console.log(
    `\n${String(checks.filter((item) => item.ok).length)} of ${String(checks.length)} checks passed (virtual authenticator; scripted provider, not Qwen; synthetic documents).`,
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  if (server?.pid !== undefined) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      // Already stopped.
    }
  }
  await provider.stop();
  await s3.stop();
  await postgres.stop();
}
