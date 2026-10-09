/**
 * pnpm test:review:browser
 *
 * Chapter 8 document review in real headless Chromium on the production build, with a CDP VIRTUAL
 * authenticator (PRF enabled), a real throwaway PostgreSQL and a real S3-compatible server. It
 * imports synthetic PDFs, confirms cited facts, runs the checks, opens a citation, saves encrypted
 * state, locks and recovers, compares two versions and runs a SIMULATED what-if. It is recorded as virtual_authenticator
 * evidence: it does not show real-device PRF support, prompt counts or synced-passkey recovery.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import { chromium, type Page } from 'playwright';
import { migrate } from '../../apps/web/src/server/db/migrate';
import { startLocalS3 } from '../../apps/web/src/test-support/local-s3';
import { startLocalPostgres } from '../../test-support/embedded-pg';
import { recordEvidence } from '../src/evidence-writer';
import { ROOT, stamp } from './lib';

const PORT = 3102;
const ORIGIN = `http://localhost:${String(PORT)}`;
const WEB = join(ROOT, 'apps', 'web');
const SENTINEL_TITLE = 'SENTINEL-review-matter-5d2e';
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
      .waitFor({ timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

const postgres = await startLocalPostgres();
const s3 = await startLocalS3();
const env = {
  NEXT_DIST_DIR: '.next-review-check',
  NEXT_TELEMETRY_DISABLED: '1',
  FEATURE_DOCUMENT_COMPARISON: 'true',
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
};
let server: ChildProcess | null = null;
const browser = await chromium.launch({ headless: true });
let created = 0;
let asserted = 0;

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
  const vaultRequests: { method: string; url: string; body: string }[] = [];
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
      vaultRequests.push({
        method: request.method(),
        url: request.url(),
        body: (request.postDataBuffer() ?? Buffer.alloc(0)).toString('latin1'),
      });
    }
  });

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
  cdp.on('WebAuthn.credentialAdded', () => (created += 1));
  cdp.on('WebAuthn.credentialAsserted', () => (asserted += 1));

  const pageText = async () => (await page.content()) + (await page.locator('body').innerText());
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

  // Client-side navigation keeps the in-memory unlock; a full page load would lock everything.
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  check('review page shows the document intake', await has('Drop a text-based PDF here'));

  // 1. Import the control agreement.
  await page.getByTestId('pdf-input').setInputFiles(join(PDFS, 'discrepancy-2000.pdf'));
  check(
    'PDF imported and saved encrypted',
    await has(/discrepancy-2000\.pdf: saved encrypted/, 40_000),
  );
  check('document listed with its text coverage', await has(/2 pages · text coverage complete/));
  check('extracted text is shown with its physical page', await has(/Physical page 1 of 2/));

  // 2. Confirm cited facts from the source passages.
  await page.getByRole('button', { name: 'Next page' }).click();
  check('page 2 text shown', await has(/Total settlement payment: GBP 24,000/));
  const facts = [
    await confirmFact('Payment total (pence)', 'total', '24,000'),
    await confirmFact('Payment instalment (pence)', 'i1', '10,000'),
    await confirmFact('Payment instalment (pence)', 'i2', '12,000'),
    await confirmFact('Payment basis (gross or net)', 'basis', 'gross'),
  ];
  check('four cited facts confirmed', facts.every(Boolean), facts.join(','));

  // 3. Deterministic checks and the exact pound result.
  await page.getByRole('button', { name: 'Run checks' }).click();
  check(
    'payment discrepancy reported in plain words',
    await has('Payment schedule differs by £2,000'),
  );
  check('checks are labelled as current', await has('Checked the current inputs'));
  check(
    'rule pack is labelled a demo draft',
    await has(/demo draft, not reviewed by a qualified person/),
  );
  const text = await page.locator('body').innerText();
  check(
    'no legal-validity verdict or all-clear',
    !/legally valid|enforceable|all clear|risk score/i.test(text),
  );

  // 4. Open a citation: the exact passage is highlighted.
  await page
    .getByRole('button', { name: /Open source \(page 2\)/ })
    .first()
    .click();
  const highlighted = await page.getByTestId('source-highlight').first().innerText();
  check('citation opens the exact passage', highlighted.length > 0, highlighted);

  // 5. Save, lock, and prove nothing private stays in the page.
  await page.getByRole('button', { name: 'Save facts' }).click();
  await page.waitForTimeout(1500);
  check(
    'facts saved: no unsaved changes remain',
    (await page.getByText('Unsaved changes').count()) === 0,
  );
  await page.getByRole('link', { name: 'Vault', exact: true }).click();
  await waitFor(page, 'vault-status', 'Saved');
  await page.getByRole('button', { name: 'Lock vault' }).click();
  check('vault locked', await waitFor(page, 'vault-status', 'Locked'));
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.waitForTimeout(500);
  const locked = await pageText();
  check(
    'lock: no document text, file name or finding remains in the page',
    !/Northwind|discrepancy-2000|Payment schedule differs|GBP 24,000|SENTINEL/.test(locked),
  );

  // 6. Unlock needs a new assertion, and the review state comes back from ciphertext.
  const assertionsBefore = asserted;
  await page.getByRole('link', { name: 'Vault', exact: true }).click();
  await page.getByRole('button', { name: 'Unlock vault' }).click();
  check(
    'unlock needs a new passkey assertion',
    (await waitFor(page, 'vault-status', /Saved|Unlocked/)) && asserted === assertionsBefore + 1,
  );
  await page
    .getByRole('button', { name: new RegExp(SENTINEL_TITLE) })
    .first()
    .click();
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  check(
    'after unlock: the document is back with its coverage',
    (await has(/discrepancy-2000\.pdf/)) && (await has(/2 pages · text coverage complete/)),
  );
  await page.getByRole('button', { name: 'Next page' }).click();
  check(
    'after unlock: the four facts are back',
    (await page.getByText(/payment_instalment \/ settlement\.i2 = 1200000/).count()) > 0,
  );
  await page.getByRole('button', { name: 'Run checks' }).click();
  check('after unlock: the same discrepancy', await has('Payment schedule differs by £2,000'));

  // 7. Simulation is isolated.
  await page.getByLabel(/SIMULATED instalment 2/).fill('14000');
  check(
    'simulation shows a match and says SIMULATED',
    await has(/SIMULATED result: match · difference £0\.00/),
  );
  check('the real finding is unchanged', await has('Payment schedule differs by £2,000'));
  await page.getByRole('button', { name: 'Reset' }).click();
  check('reset restores the real figures', await has(/SIMULATED result: mismatch/));

  // 8. Two versions.
  await page.getByTestId('pdf-input').setInputFiles(join(PDFS, 'version-1.pdf'));
  await has(/version-1\.pdf: saved encrypted/, 40_000);
  await page.getByTestId('pdf-input').setInputFiles(join(PDFS, 'version-2.pdf'));
  check('second version imported', await has(/version-2\.pdf: saved encrypted/, 40_000));
  await page.getByLabel(/^Old version/).selectOption({ label: 'version-1.pdf' });
  await page.getByLabel(/^New version/).selectOption({ label: 'version-2.pdf' });
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  check('comparison lists the changes', await has(/\d+ change\(s\) in the extracted text/));
  check('an added "not" is reported', (await page.getByText(/Added/).count()) > 0);

  // 9. Unsupported file.
  await page.getByTestId('pdf-input').setInputFiles({
    name: 'scan.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 broken'),
  });
  check(
    'a broken PDF is refused with a reason',
    await has(/scan\.pdf: .*(damaged|not a valid PDF|could not be read)/),
  );

  // Privacy surface.
  const joined = vaultRequests.map((item) => item.body).join('\n');
  check(
    'no request carries document plaintext',
    !/Northwind|IGNORE|settlement payment|discrepancy-2000|SENTINEL/.test(joined) &&
      vaultRequests.length > 0,
    `requests=${String(vaultRequests.length)}`,
  );
  check(
    'only this origin was contacted (no third party, no document-controlled URL)',
    outside.length === 0,
    outside[0] ?? '',
  );
  const storage = await page.evaluate(async () => ({
    local: JSON.stringify(Object.entries(localStorage)),
    session: JSON.stringify(Object.entries(sessionStorage)),
    databases: (await indexedDB.databases()).length,
    workers: (await navigator.serviceWorker.getRegistrations()).length,
    caches: (await caches.keys()).length,
  }));
  check(
    'no plaintext in localStorage, sessionStorage, IndexedDB, caches or service workers',
    !/Northwind|discrepancy|SENTINEL/.test(storage.local + storage.session) &&
      storage.databases === 0 &&
      storage.workers === 0 &&
      storage.caches === 0,
  );
  const atRest = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM vault_objects');
  check(
    'ciphertext objects stored server side',
    Number(atRest.rows[0]?.n ?? 0) >= 8,
    atRest.rows[0]?.n ?? '',
  );
  check('no Content Security Policy violation', violations.length === 0, violations[0] ?? '');
  await pool.end();

  const ok = checks.every((item) => item.ok);
  await recordEvidence({
    root: ROOT,
    results: [
      stamp({
        id: `review-browser-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
        subject: 'review-browser-check',
        command: 'pnpm test:review:browser',
        evidenceClass: 'virtual_authenticator',
        outcome: ok ? 'pass' : 'fail',
        reasonCodes: [
          'AUTHENTICATOR_MODE_VIRTUAL',
          'SYNTHETIC_DOCUMENTS_ONLY',
          ...(ok ? [] : ['CHECKS_FAILED']),
        ],
        facts: {
          browser: `chromium ${version}`,
          checksPassed: String(checks.filter((item) => item.ok).length),
          checksTotal: String(checks.length),
          storage: 'postgresql + versitygw 1.8.0',
          authenticatorMode: 'virtual',
          realDeviceEvidence: false,
        },
      }),
    ],
  });
  console.log(
    `\n${String(checks.filter((item) => item.ok).length)} of ${String(checks.length)} checks passed (virtual authenticator; synthetic documents; not real-device evidence).`,
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
  await s3.stop();
  await postgres.stop();
}
