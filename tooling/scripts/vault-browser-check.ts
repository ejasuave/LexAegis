/**
 * pnpm test:vault:browser
 *
 * Drives the production build in real headless Chromium with a CDP VIRTUAL authenticator (PRF
 * enabled), a real throwaway PostgreSQL and a real S3-compatible server (VersityGW). It runs the
 * genuine Mera SDK, Web Crypto and the vault UI. It is recorded as virtual_authenticator
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

const PORT = 3101;
const ORIGIN = `http://localhost:${String(PORT)}`;
const WEB = join(ROOT, 'apps', 'web');
const SENTINEL_TITLE = 'SENTINEL-matter-title-7c41';
const SENTINEL_FACT = 'SENTINEL-fact-text-19ab';
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
  NEXT_DIST_DIR: '.next-vault-check',
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
  page.on('request', (request) => {
    if (request.url().includes('/api/vault')) {
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

  await page.goto(`${ORIGIN}/vault`);
  check('starts with no vault state', await waitFor(page, 'vault-status', /unavailable|Locked/i));

  await page.getByRole('button', { name: 'Create account and sign in' }).click();
  check('account ready', await waitFor(page, 'account-status', 'Account ready'));
  check('backend signed in', await waitFor(page, 'backend-state', 'Signed in'));
  const address =
    (await page.locator('[data-testid="account-address"]').getAttribute('title')) ?? '';

  check('discovery says no vault yet', await waitFor(page, 'vault-discovery', 'None yet'));
  const assertionsBeforeCreate = asserted;
  await page.getByRole('button', { name: 'Create vault' }).click();
  check(
    'create vault: unlocked and saved',
    (await waitFor(page, 'vault-status', 'Saved')) && asserted === assertionsBeforeCreate + 1,
    `assertions=${String(asserted - assertionsBeforeCreate)}`,
  );

  await page.getByLabel('New matter title').fill(SENTINEL_TITLE);
  await page.getByRole('button', { name: 'Create matter' }).click();
  check(
    'matter created and listed',
    await page
      .getByRole('button', { name: new RegExp(SENTINEL_TITLE) })
      .first()
      .waitFor({ timeout: 15_000 })
      .then(
        () => true,
        () => false,
      ),
  );
  await page.getByLabel(/Entry text/).fill(SENTINEL_FACT);
  await page.getByLabel('I confirm this is correct').check();
  await page.getByRole('button', { name: 'Add to working context' }).click();
  check('unsaved change is labelled', await waitFor(page, 'vault-status', 'Unsaved changes'));
  await page.getByRole('button', { name: 'Save context' }).click();
  check('context saved', await waitFor(page, 'vault-status', 'Saved'));

  // Real object-body limits through the production server.
  await page.locator('#source-file').setInputFiles({
    name: 'large-original.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(9 * 1024 * 1024, 7),
  });
  check(
    'a 9 MiB original is encrypted and stored through the route',
    (await page
      .getByText('large-original.bin')
      .waitFor({ timeout: 60_000 })
      .then(
        () => true,
        () => false,
      )) && (await waitFor(page, 'vault-status', 'Saved')),
  );
  await page.locator('#source-file').setInputFiles({
    name: 'too-large.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 1),
  });
  check(
    'an original over 10 MiB is refused with an explanation and nothing stored',
    (await waitFor(page, 'vault-notice', 'too large')) &&
      (await page.getByText('too-large.bin').count()) === 0,
  );
  const view = await context.request.get(`${ORIGIN}/api/vault`);
  const vaultId = ((await view.json()) as { data?: { descriptor?: { vaultId?: string } } }).data
    ?.descriptor?.vaultId;
  const countObjects = async () =>
    Number(
      (await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM vault_objects')).rows[0]?.n,
    );
  const objectsBefore = await countObjects();
  const oversize = await context.request.put(
    `${ORIGIN}/api/vault/${vaultId ?? 'x'}/objects/${crypto.randomUUID()}`,
    {
      headers: {
        origin: ORIGIN,
        'x-lexaegis-request': '1',
        'content-type': 'application/json',
      },
      data: Buffer.alloc(16 * 1024 * 1024 + 1, 2),
    },
  );
  check(
    'a body over 16 MiB is refused by the route and nothing is stored',
    oversize.status() === 400 && (await countObjects()) === objectsBefore,
    String(oversize.status()),
  );

  // Network surface: only ciphertext, no plaintext, no key material.
  const joined = vaultRequests.map((item) => item.body).join('\n');
  check(
    'requests to the vault carry no plaintext',
    !joined.includes('SENTINEL') && vaultRequests.length > 0,
    `requests=${String(vaultRequests.length)}`,
  );
  const storage = await page.evaluate(async () => ({
    local: JSON.stringify(Object.entries(localStorage)),
    session: JSON.stringify(Object.entries(sessionStorage)),
    databases: (await indexedDB.databases()).length,
  }));
  check(
    'browser storage holds no matter text',
    !storage.local.includes('SENTINEL') &&
      !storage.session.includes('SENTINEL') &&
      storage.databases === 0,
  );

  // Lock removes decrypted text from the page.
  await page.getByRole('button', { name: 'Lock vault' }).click();
  check('lock: vault locked', await waitFor(page, 'vault-status', 'Locked'));
  check(
    'lock: no decrypted text remains in the page',
    !(await page.content()).includes('SENTINEL'),
  );

  const assertionsBeforeUnlock = asserted;
  await page.getByRole('button', { name: 'Unlock vault' }).click();
  check(
    'unlock: needs a new passkey assertion',
    (await waitFor(page, 'vault-status', /Saved|Unlocked/)) &&
      asserted === assertionsBeforeUnlock + 1,
  );
  await page
    .getByRole('button', { name: new RegExp(SENTINEL_TITLE) })
    .first()
    .click();
  check('unlock: saved fact is back', (await page.content()).includes(SENTINEL_FACT));
  await page.getByRole('button', { name: 'Lock vault' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  check('sign out: server session ended', await waitFor(page, 'backend-state', 'Signed out'));

  // Stateless recovery: clear everything this site stored, then recover with the same passkey.
  await context.clearCookies();
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  check(
    'after clearing storage: no account known',
    await waitFor(page, 'account-status', 'No account'),
  );
  const createdBeforeRecover = created;
  await page.getByRole('button', { name: 'Recover vault' }).click();
  check(
    'recover: same address, vault unlocked from remote ciphertext alone',
    (await waitFor(page, 'account-status', 'Account ready')) &&
      (await page.locator('[data-testid="account-address"]').getAttribute('title')) === address &&
      (await waitFor(page, 'vault-status', /Saved|Unlocked/)),
  );
  await page
    .getByRole('button', { name: new RegExp(SENTINEL_TITLE) })
    .first()
    .click();
  check(
    'recover: the matter and fact are restored',
    (await page.content()).includes(SENTINEL_FACT),
  );
  check('recover: no new passkey was created', created === createdBeforeRecover);

  // Server side: ciphertext only at rest.
  const rows = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM vault_objects');
  check('objects were stored', Number(rows.rows[0]?.n ?? 0) >= 4, rows.rows[0]?.n ?? '');
  const anonymous = await fetch(`${ORIGIN}/api/vault`);
  check('guard: unauthenticated vault read is refused', anonymous.status === 401);
  check('no Content Security Policy violation', violations.length === 0, violations[0] ?? '');
  await pool.end();

  const ok = checks.every((item) => item.ok);
  await recordEvidence({
    root: ROOT,
    results: [
      stamp({
        id: `vault-browser-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
        subject: 'vault-browser-check',
        command: 'pnpm test:vault:browser',
        evidenceClass: 'virtual_authenticator',
        outcome: ok ? 'pass' : 'fail',
        reasonCodes: [
          'AUTHENTICATOR_MODE_VIRTUAL',
          'PASSKEY_STEP_REQUIRES_REAL_DEVICE_EVIDENCE',
          ...(ok ? [] : ['CHECKS_FAILED']),
        ],
        facts: {
          browser: `chromium ${version}`,
          checksPassed: String(checks.filter((item) => item.ok).length),
          checksTotal: String(checks.length),
          recoveredAfterClearingStorage:
            checks.find((item) => item.name.startsWith('recover: same address'))?.ok ?? false,
          storage: 'postgresql + versitygw 1.8.0',
          authenticatorMode: 'virtual',
          realDeviceEvidence: false,
        },
      }),
    ],
  });
  console.log(
    `\n${String(checks.filter((item) => item.ok).length)} of ${String(checks.length)} checks passed (virtual authenticator; not real-device evidence).`,
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
