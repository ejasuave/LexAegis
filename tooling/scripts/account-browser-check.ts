/**
 * pnpm test:account:browser
 *
 * Drives the production build of the web application in real headless Chromium with a CDP
 * VIRTUAL authenticator (PRF enabled) and a real, throwaway PostgreSQL. It runs the genuine
 * Mera SDK and browser WebAuthn code. It is recorded as virtual_authenticator evidence: it does
 * not show real-device PRF support, the number of prompts a person sees, or synced recovery.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import { chromium, type Page } from 'playwright';
import { migrate } from '../../apps/web/src/server/db/migrate';
import { startLocalPostgres } from '../../test-support/embedded-pg';
import { recordEvidence } from '../src/evidence-writer';
import { ROOT, stamp } from './lib';

const PORT = 3100;
const ORIGIN = `http://localhost:${String(PORT)}`;
const WEB = join(ROOT, 'apps', 'web');
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

const text = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`).innerText();
async function waitFor(page: Page, id: string, expected: string | RegExp): Promise<boolean> {
  try {
    await page
      .locator(`[data-testid="${id}"]`)
      .filter({ hasText: expected })
      .waitFor({ timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const postgres = await startLocalPostgres();
const env = {
  NEXT_DIST_DIR: '.next-check',
  NEXT_TELEMETRY_DISABLED: '1',
  NEXT_PUBLIC_APP_ORIGIN: ORIGIN,
  NEXT_PUBLIC_WEBAUTHN_RP_ID: 'localhost',
  NEXT_PUBLIC_CHAIN_ID: '10143',
  DATABASE_URL: postgres.url,
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
  const authBodies: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/auth/')) authBodies.push(request.postData() ?? '');
  });
  const authResponses: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/api/auth/'))
      void response
        .text()
        .then((body) => authResponses.push(body))
        .catch(() => undefined);
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

  const first = await page.goto(`${ORIGIN}/vault`);
  const csp = first?.headers()['content-security-policy'] ?? '';
  check(
    'CSP uses a nonce with strict-dynamic and no unsafe-inline or unsafe-eval',
    /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/.test(csp) &&
      !/unsafe-(inline|eval)/.test(csp),
    csp.slice(0, 60),
  );
  check(
    'framing and plugins are blocked',
    csp.includes("frame-ancestors 'none'") &&
      csp.includes("object-src 'none'") &&
      csp.includes("connect-src 'self'"),
  );
  check('page is not cached', (first?.headers()['cache-control'] ?? '').includes('no-store'));

  check('starts with no account', await waitFor(page, 'account-status', 'No account'));

  // 1. Create account and sign in.
  await page.getByRole('button', { name: 'Create account and sign in' }).click();
  check('create: account ready', await waitFor(page, 'account-status', 'Account ready'));
  check(
    'create: signed in to the server without another passkey step',
    await waitFor(page, 'backend-state', 'Signed in'),
  );
  const address =
    (await page.locator('[data-testid="account-address"]').getAttribute('title')) ?? '';
  check('create: a derived address is shown', /^0x[0-9a-f]{40}$/.test(address), address);
  const ceremoniesAtCreate = { created, asserted };
  check(
    'create: one credential was made',
    created === 1,
    `created=${String(created)} asserted=${String(asserted)}`,
  );

  // Cookies and storage.
  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === 'lexaegis_session');
  check(
    'session cookie is HttpOnly, SameSite=Strict, host-only and path /',
    session !== undefined &&
      session.httpOnly &&
      session.sameSite === 'Strict' &&
      session.path === '/' &&
      !session.domain.startsWith('.'),
  );
  check(
    'session cookie is invisible to page script',
    !(await page.evaluate(() => document.cookie)).includes('lexaegis_session'),
  );
  const storage = await page.evaluate(async () => ({
    localKeys: Object.keys(localStorage),
    hint: localStorage.getItem('lexaegis.account-profile.v1'),
    session: Object.keys(sessionStorage),
    databases: (await indexedDB.databases()).length,
  }));
  const hint = JSON.parse(storage.hint ?? '{}') as Record<string, unknown>;
  check(
    'browser storage holds only the public account profile',
    storage.localKeys.length === 1 &&
      storage.session.length === 0 &&
      storage.databases === 0 &&
      Object.keys(hint).sort().join(',') ===
        'address,credentialId,profileId,rpId,schema,transports',
  );
  check(
    'stored profile names the same address and nothing secret',
    hint.address === address && !/[0-9a-f]{64}/i.test(JSON.stringify(hint)),
  );

  // 3. Lock, then a fresh ceremony is required.
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  check(
    'lock: signing locked while the server sign-in remains separate',
    (await waitFor(page, 'account-status', 'Locked')) &&
      (await text(page, 'backend-state')) === 'Signed in',
  );
  const assertedBeforeUnlock = asserted;
  await page.getByRole('button', { name: 'Unlock signing' }).click();
  check(
    'unlock: needs a new passkey assertion and reproduces the address',
    (await waitFor(page, 'account-status', 'Account ready')) &&
      asserted === assertedBeforeUnlock + 1 &&
      (await page.locator('[data-testid="account-address"]').getAttribute('title')) === address,
  );

  // Keyboard operation and reduced motion.
  await page.getByRole('button', { name: 'Lock', exact: true }).focus();
  await page.keyboard.press('Enter');
  check('keyboard: Lock works from the keyboard', await waitFor(page, 'account-status', 'Locked'));
  check(
    'reduced motion: no running animations',
    (await page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === 'running').length,
    )) === 0,
  );

  await page.getByRole('button', { name: 'Sign out' }).click();
  check('sign out: server session ended', await waitFor(page, 'backend-state', 'Signed out'));
  check(
    'sign out: session cookie removed',
    !(await context.cookies()).some((cookie) => cookie.name === 'lexaegis_session'),
  );

  // 4. Clear this application's storage and cookies, reload, recover with the same passkey.
  await context.clearCookies();
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  check(
    'after clearing storage: no account is known',
    await waitFor(page, 'account-status', 'No account'),
  );
  const createdBeforeRecover = created;
  await page.getByRole('button', { name: 'Recover account' }).click();
  check(
    'recover: same address reproduced from the existing passkey',
    (await waitFor(page, 'account-status', 'Account ready')) &&
      (await page.locator('[data-testid="account-address"]').getAttribute('title')) === address,
  );
  check('recover: signed in again', await waitFor(page, 'backend-state', 'Signed in'));
  check('recover: no new passkey was created', created === createdBeforeRecover);

  // Network surface.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const bodyKeys = new Set(
    authBodies.filter(Boolean).flatMap((body) => Object.keys(JSON.parse(body) as object)),
  );
  check(
    'auth requests carry only address, chain, challenge ID and signature',
    [...bodyKeys].sort().join(',') === 'address,chainId,challengeId,signature',
    [...bodyKeys].join(','),
  );
  check(
    'auth responses never contain a session token',
    !authResponses.some((body) => /token|[0-9a-f]{64}"/.test(body)),
  );
  check(
    'no Content Security Policy violation occurred',
    violations.length === 0,
    violations[0] ?? '',
  );

  // Server guards, from outside the page.
  const post = (headers: Record<string, string>) =>
    fetch(`${ORIGIN}/api/auth/challenge`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ address, chainId: '10143' }),
    }).then((r) => r.status);
  const good = { origin: ORIGIN, 'content-type': 'application/json', 'x-lexaegis-request': '1' };
  check('guard: a correct same-origin request is accepted', (await post(good)) === 200);
  check(
    'guard: a cross-origin request is refused',
    (await post({ ...good, origin: 'https://evil.test' })) === 403,
  );
  check(
    'guard: a request without the custom header is refused',
    (await post({ origin: ORIGIN, 'content-type': 'application/json' })) === 403,
  );
  check(
    'guard: unauthenticated identity read is 401',
    (await fetch(`${ORIGIN}/api/auth/me`)).status === 401,
  );
  const rows = await pool.query<{ token_hash: string }>('SELECT token_hash FROM auth_sessions');
  check(
    'database stores token hashes only',
    rows.rows.length >= 2 && rows.rows.every((row) => /^[0-9a-f]{64}$/.test(row.token_hash)),
  );
  await pool.end();

  const ok = checks.every((item) => item.ok);
  await recordEvidence({
    root: ROOT,
    results: [
      stamp({
        id: `account-browser-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
        subject: 'account-browser-check',
        command: 'pnpm test:account:browser',
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
          addressReproducedAfterClearingStorage:
            checks.find((item) => item.name.startsWith('recover: same address'))?.ok ?? false,
          credentialsCreatedDuringCreate: String(ceremoniesAtCreate.created),
          assertionsDuringCreate: String(ceremoniesAtCreate.asserted),
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
  await postgres.stop();
}
