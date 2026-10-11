/* eslint-disable @typescript-eslint/no-unnecessary-condition -- callbacks passed to page.evaluate run in the page, where DOM values can be null at runtime */
/**
 * pnpm test:hud:browser
 *
 * Chapter 10 HUD and human approval in real headless Chromium on the production build, with a CDP
 * VIRTUAL authenticator (PRF enabled), a real throwaway PostgreSQL, a real S3-compatible server and
 * the SCRIPTED loopback provider. The registry's live state is SCRIPTED through request routing and
 * the registry address is a fixture value: no chain, no Qwen, no real device is involved. Speech is
 * a MOCK injected before the page loads, so the voice checks prove controller behaviour only.
 *
 * Path: account -> vault -> matter -> PDF -> cited facts -> checks -> decisions -> record -> preview
 * -> freeze, save and read back -> approval preview -> trusted approval -> lock. Each ceremony has a
 * negative control, and screenshots are taken of the real pages.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { chromium, type Page } from 'playwright';
import { migrate } from '../../apps/web/src/server/db/migrate';
import { startLocalS3 } from '../../apps/web/src/test-support/local-s3';
import { startScriptedQwenServer } from '../../apps/web/src/test-support/scripted-qwen-server';
import { startLocalPostgres } from '../../test-support/embedded-pg';
import { recordEvidence } from '../src/evidence-writer';
import { attachPrivacyObserver, openPrivacyServerLog } from '../src/privacy/observe';
import { ROOT, stamp } from './lib';

const PORT = 3107;
const ORIGIN = `http://localhost:${String(PORT)}`;
const WEB = join(ROOT, 'apps', 'web');
// Observed by `pnpm test:privacy:browser`, the screenshots are scratch: the Chapter 10 evidence
// images are rewritten only by this journey's own command.
const OBSERVE_DIR = process.env.PRIVACY_OBSERVE_DIR ?? '';
const SHOTS =
  OBSERVE_DIR === ''
    ? join(ROOT, 'docs', 'evidence', 'chapter10')
    : join(OBSERVE_DIR, 'hud-screenshots');
const SENTINEL_TITLE = 'SENTINEL-hud-matter-5e72';
const PDFS = join(ROOT, 'fixtures', 'documents-v1', 'pdfs');
const REGISTRY = `0x${'ab'.repeat(20)}`;
const checks: { name: string; ok: boolean; detail: string }[] = [];
const shots: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
};
mkdirSync(SHOTS, { recursive: true });

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

/** Mock speech, injected before any page script. It proves controller behaviour, not a device. */
const SPEECH_MOCK = `
(() => {
  const control = { instances: [], asked: [], avail: 'available', deny: false, installs: 0 };
  class SR {
    constructor() { this.lang = ''; this.continuous = true; this.interimResults = false; control.instances.push(this); }
    start() {
      if (control.deny) { setTimeout(() => this.onerror && this.onerror({ error: 'not-allowed' }), 0); return; }
      setTimeout(() => this.onstart && this.onstart(), 0);
    }
    stop() { setTimeout(() => this.onend && this.onend(), 0); }
    abort() { this.aborted = true; }
  }
  let local = false;
  Object.defineProperty(SR.prototype, 'processLocally', { get() { return local; }, set(v) { local = v; control.lastProcessLocally = v; }, configurable: true });
  SR.available = async (options) => { control.asked.push(JSON.stringify(options)); return control.avail; };
  SR.install = async () => { control.avail = 'available'; control.installs += 1; return true; };
  window.SpeechRecognition = SR;
  window.__speech = control;
  window.__speechEmit = (items) => {
    const rec = control.instances[control.instances.length - 1];
    if (rec && rec.onresult) rec.onresult({ resultIndex: 0, results: items.map((i) => ({ isFinal: i.isFinal, 0: { transcript: i.text } })) });
  };
  const synth = { spoken: [], cancels: 0, voices: [
    { voiceURI: 'local-1', name: 'Local British', lang: 'en-GB', localService: true },
    { voiceURI: 'cloud-1', name: 'Cloud Voice', lang: 'en-GB', localService: false } ] };
  const speechSynthesis = {
    getVoices: () => synth.voices,
    addEventListener() {}, removeEventListener() {},
    speak(u) { synth.spoken.push({ text: u.text, voice: u.voice && u.voice.voiceURI }); setTimeout(() => u.onstart && u.onstart(), 0); },
    cancel() { synth.cancels += 1; }, pause() {}, resume() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: speechSynthesis, configurable: true });
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  window.__synth = synth;
})();
`;

const postgres = await startLocalPostgres();
const s3 = await startLocalS3();
const provider = await startScriptedQwenServer();
const env = {
  NEXT_DIST_DIR: '.next-hud-check',
  NEXT_TELEMETRY_DISABLED: '1',
  NEXT_PUBLIC_APP_ORIGIN: ORIGIN,
  NEXT_PUBLIC_WEBAUTHN_RP_ID: 'localhost',
  NEXT_PUBLIC_CHAIN_ID: '10143',
  // A FIXTURE address so the approval path can be exercised. No registry exists at it.
  NEXT_PUBLIC_REGISTRY_ADDRESS: REGISTRY,
  DATABASE_URL: postgres.url,
  S3_ENDPOINT: s3.endpoint,
  S3_BUCKET: s3.bucket,
  S3_REGION: s3.region,
  S3_ACCESS_KEY_ID: s3.accessKeyId,
  S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
  WEB_PORT: String(PORT),
  FEATURE_VOICE: 'true',
  // Chapter 16: the T0 journey runs with the optional identity and feedback features OFF by default,
  // and with the identity path configured but UNAVAILABLE (HUD_AGENT_IDENTITY=unavailable). Both
  // must leave review, vault, approval, receipt lifecycle and verification unchanged.
  FEATURE_AGENT_IDENTITY: process.env.HUD_AGENT_IDENTITY === undefined ? 'false' : 'true',
  FEATURE_REPUTATION_FEEDBACK: 'false',
  ...(process.env.HUD_AGENT_IDENTITY === 'unavailable'
    ? {
        AGENT_IDENTITY_AGENT_ID: '7',
        AGENT_IDENTITY_CARD_URI: 'https://lexaegis.example.test/api/agent-card',
        AGENT_IDENTITY_RPC_URL: 'https://127.0.0.1:9/',
      }
    : {}),
  LEXAEGIS_TEST_MODE: 'scripted-assistant',
  ASSISTANT_TEST_PROVIDER_URL: provider.baseUrl,
  QWEN_API_KEY: '',
  QWEN_BASE_URL: '',
  QWEN_OUTPUT_MODE: '',
};
let server: ChildProcess | null = null;
// Set once the privacy observer is attached. A journey that stops early still hands over what it
// observed, so a failure is analysed instead of leaving nothing to check.
const observation: { finish: ((ended: 'complete' | 'early') => Promise<void>) | null } = {
  finish: null,
};
// Chapter 17: when `pnpm test:privacy:browser` runs this journey it also observes storage, network,
// logs and stores. Without PRIVACY_OBSERVE_DIR these are null and nothing changes.
const privacyLog = openPrivacyServerLog('hud');
const browser = await chromium.launch({ headless: true });

try {
  const pool = new Pool({ connectionString: postgres.url });
  pool.on('connect', (client) => client.on('error', () => undefined));
  pool.on('error', () => undefined);
  await migrate(pool);

  check('production build', (await run('pnpm', ['exec', 'next', 'build'], env)) === 0);
  server = spawn('pnpm', ['exec', 'next', 'start', '--port', String(PORT)], {
    cwd: WEB,
    env: { ...process.env, ...env, ...privacyLog?.env },
    stdio: privacyLog?.stdio ?? 'ignore',
    detached: true,
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${ORIGIN}/api/health`)).ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  // The browser bundles hold no provider credential, server secret or wallet-extension code.
  const bundleFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? bundleFiles(path) : path.endsWith('.js') ? [path] : [];
    });
  const bundle = bundleFiles(join(WEB, '.next-hud-check', 'static'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  check(
    'client bundles hold no provider credential, server secret or injected-wallet code',
    !/QWEN_API_KEY|DATABASE_URL|S3_SECRET_ACCESS_KEY|ASSISTANT_TEST_PROVIDER_URL|eth_requestAccounts|window\.ethereum/.test(
      bundle,
    ),
  );

  const version = browser.version();
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 900 },
    // Only so the Chapter 11 verifier check can read back the public reference the app copies.
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.addInitScript(SPEECH_MOCK);
  const observer = await attachPrivacyObserver(context, {
    journey: 'hud',
    origin: ORIGIN,
    serverLog: privacyLog,
  });
  // Values this journey plants or that exist only in its synthetic PDF. Send is pressed once, in the
  // read-aloud section, for the excerpt "24,000" alone: the lines below were never selected for a
  // disclosure, so they are `unselected_text` and may not leave the browser in plaintext at all.
  observer?.canary({
    id: 'matter-title',
    class: 'matter_title',
    kind: 'text',
    value: SENTINEL_TITLE,
  });
  observer?.canary({
    id: 'pdf-file-name',
    class: 'filename',
    kind: 'text',
    value: 'discrepancy-2000.pdf',
  });
  // The SHA-256 of the uploaded file: part of an excerpt's source reference, so it may reach the
  // analysis route with a consented excerpt and must not appear anywhere else, the provider included.
  observer?.canary({
    id: 'source-file-sha256',
    class: 'artifact_hash',
    kind: 'bytes',
    value: createHash('sha256')
      .update(readFileSync(join(PDFS, 'discrepancy-2000.pdf')))
      .digest('hex'),
  });
  observer?.canary({
    id: 'pdf-employer',
    class: 'unselected_text',
    kind: 'text',
    value: 'Northwind Demo Ltd',
  });
  observer?.canary({
    id: 'pdf-heading',
    class: 'unselected_text',
    kind: 'text',
    value: 'SYNTHETIC SETTLEMENT AGREEMENT',
  });
  observer?.canary({
    id: 'pdf-total-line',
    class: 'unselected_text',
    kind: 'text',
    value: 'Total settlement payment',
  });
  observer?.canary({
    id: 'pdf-total-amount',
    class: 'unselected_text',
    kind: 'text',
    value: 'GBP 24,000',
  });
  observer?.canary({
    id: 'fact-total-pence',
    class: 'money_field',
    kind: 'token',
    value: '2400000',
  });
  observer?.canary({
    id: 'fact-instalment-pence',
    class: 'money_field',
    kind: 'token',
    value: '1200000',
  });
  observer?.canary({
    id: 'reviewer-reason',
    class: 'reviewer_note',
    kind: 'text',
    value: 'The client was told about the GBP 2,000 gap.',
  });
  observer?.canary({
    id: 'storage-secret',
    class: 'storage_credential',
    kind: 'text',
    value: s3.secretAccessKey,
  });
  observer?.canary({
    id: 'storage-access-key',
    class: 'storage_credential',
    kind: 'text',
    value: s3.accessKeyId,
  });
  observer?.canary({
    id: 'database-url',
    class: 'database_credential',
    kind: 'text',
    value: postgres.url,
  });
  if (observer !== null) {
    observation.finish = async (ended) => {
      observation.finish = null;
      await observer.finish({
        consentedDisclosure: true,
        providerRequests: provider.requests,
        pool,
        objectStoreRoot: s3.root,
        serverEgressAllowed: [postgres.url, s3.endpoint, provider.baseUrl].map((url) => {
          const parsed = new URL(url);
          return `${parsed.hostname}:${parsed.port}`;
        }),
        unobserved: [
          'session expiry (idle and absolute limits are covered by unit tests, not by this browser run)',
          'a broadcast transaction (the chain is scripted and no network is configured)',
          'storage writes made inside a worker (snapshots still see what persisted)',
          ...(ended === 'early'
            ? ['the journey stopped early: its remaining steps and stores were not observed']
            : []),
        ],
      });
    };
  }
  const page = await context.newPage();
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text()))
      violations.push(message.text().slice(0, 160));
  });
  const requests: { method: string; url: string }[] = [];
  const outside: string[] = [];
  page.on('request', (request) => {
    if (
      !request.url().startsWith(ORIGIN) &&
      !request.url().startsWith('data:') &&
      !request.url().startsWith('blob:')
    )
      outside.push(request.url().slice(0, 100));
    if (request.url().includes('/api/'))
      requests.push({ method: request.method(), url: request.url() });
  });

  // The registry's live state is scripted. The nonce and lifecycle can change mid-test.
  const chain = { nonce: '0', lifecycle: 'not_found' };
  await page.route('**/api/chain/state/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        status: 'ok',
        label: 'provisional_latest',
        blockNumber: '100',
        blockTimestamp: String(Math.floor(Date.now() / 1000)),
        observedAt: new Date().toISOString(),
        registryNonce: chain.nonce,
        receiptLifecycle: chain.lifecycle,
        source: 'rpc',
      }),
    }),
  );

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
  const shot = async (name: string) => {
    await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
    shots.push(`docs/evidence/chapter10/${name}.png`);
  };
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
  const noHorizontalScroll = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  // ---- 1. Setup: account, vault, matter, document, four cited facts, checks -------------------
  await page.goto(`${ORIGIN}/review`);
  await observer?.phase(page, 'before-account');
  check(
    'empty account shows onboarding and no fabricated matter',
    (await page.getByRole('button', { name: 'Create account', exact: true }).count()) === 1 &&
      !(await has('No matters yet')),
  );
  await shot('01-command-centre-empty-1440x900');
  await page.goto(`${ORIGIN}/vault`);
  await page.getByRole('button', { name: 'Create account and sign in' }).click();
  check('account ready', await waitFor(page, 'account-status', 'Account ready'));
  await page.getByRole('button', { name: 'Create vault' }).click();
  check('vault created and unlocked', await waitFor(page, 'vault-status', 'Saved'));
  check(
    'account access and vault unlocking are explained as separate things',
    await has('Account and vault are separate'),
  );
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
  check('document status states the exact version and saved state', await has(/text coverage/));
  await page.getByRole('button', { name: 'Next page' }).click();
  await has(/Total settlement payment: GBP 24,000/);
  const facts = [
    await confirmFact('Payment total (pence)', 'total', '24,000'),
    await confirmFact('Payment instalment (pence)', 'i1', '10,000'),
    await confirmFact('Payment instalment (pence)', 'i2', '12,000'),
    await confirmFact('Payment basis (gross or net)', 'basis', 'gross'),
  ];
  check('four cited facts confirmed', facts.every(Boolean), facts.join(','));
  await page.getByRole('button', { name: 'Run checks' }).click();
  check('checks ran on the current inputs', await has('Checked the current inputs.'));
  await observer?.phase(page, 'after-unlock-save-and-facts');
  await shot('02-review-1440x900');

  // ---- 2. Human decisions are required and are never preselected -----------------------------
  const decisions = page.getByTestId('decisions-panel');
  const needDecision = await decisions.innerText();
  check(
    'a finding needs a decision and nothing is preselected',
    /need your decision/.test(needDecision) &&
      (await decisions.getByTestId('disposition-recorded').count()) === 0,
  );
  await page.getByTestId('record-decisions').click();
  check(
    'recording is refused while a finding still awaits a decision',
    await has('Some findings still need your decision.'),
  );
  await decisions.getByRole('button', { name: 'Accept unresolved concern' }).first().click();
  await decisions.getByRole('button', { name: 'Save my decision' }).first().click();
  check('an accepted concern without a reason is refused', await has('A reason is required'));
  // Decide every remaining finding that needs one, each in the reviewer's own words.
  for (let index = 0; index < 20; index += 1) {
    const row = decisions
      .locator('li[data-finding]')
      .filter({ has: page.getByRole('button', { name: 'Accept unresolved concern' }) })
      .first();
    if ((await row.count()) === 0) break;
    await row.getByRole('button', { name: 'Accept unresolved concern' }).click();
    await row.getByLabel(/^Reason/).fill('The client was told about the GBP 2,000 gap.');
    await row.getByRole('button', { name: 'Save my decision' }).click();
    await page.waitForTimeout(200);
  }
  check(
    'the reviewer’s own decision is recorded, and the check result stays unchanged',
    await has(/The check result itself is\s+unchanged/),
  );
  const findingsText = await page.getByRole('region', { name: 'Findings' }).first().innerText();
  check(
    'the arithmetic finding still reads as needing attention after the decision',
    /Needs attention/.test(findingsText) && /difference/i.test(findingsText),
    findingsText.replace(/\s+/g, ' ').slice(0, 140),
  );
  await page.getByTestId('record-decisions').click();
  check('decisions recorded and labelled as not approval', await has(/Recording is not approval/));

  // ---- 3. Package preview, freeze, encrypted save and read-back ------------------------------
  await page.getByTestId('build-preview').click();
  check('package memo shows contents, limitations and no model', await has('Review memo'));
  const memo = await page.getByTestId('package-memo').innerText();
  check(
    'memo names the model execution, rule-pack review state and the reviewer’s reasons',
    /None: only local checks/.test(memo) &&
      /Demonstration draft/.test(memo) &&
      /GBP 2,000 gap/.test(memo) &&
      /not the settlement agreement/.test(memo),
  );
  check(
    'approval is unavailable before anything is frozen',
    (await page.getByTestId('preview-approval').count()) === 0 &&
      (await has('Unavailable: there is no verified frozen package.')),
  );
  await page.getByTestId('freeze-package').click();
  check(
    'frozen package is saved, read back and not approved',
    await waitFor(page, 'frozen-package', 'Saved and checked'),
  );
  await observer?.phase(page, 'after-freeze-and-save');
  const frozen = await page.getByTestId('frozen-package').innerText();
  const commitment = /0x[0-9a-f]{64}/.exec(frozen)?.[0] ?? '';
  check(
    'frozen view shows the public commitment and says it is not approved or a receipt',
    commitment !== '' && /not approved, signed or an active receipt/.test(frozen),
  );

  // ---- 4. Stage one: the exact action, a trusted click and negative controls ------------------
  const opsBefore = requests.filter((r) => r.url.includes('/api/chain/operations')).length;
  await page.getByTestId('preview-approval').click();
  await page.getByTestId('approval-details').waitFor({ timeout: 20_000 });
  const approvalText = await page.getByTestId('approval-details').innerText();
  check(
    'the preview names account, network, registry, commitment, scope and the reviewer’s own words',
    approvalText.includes(commitment) &&
      approvalText.includes(REGISTRY) &&
      /Monad Testnet \(chain 10143\)/.test(approvalText) &&
      /GBP 2,000 gap/.test(approvalText) &&
      /artifacts/.test(approvalText),
  );
  const statement = await page.getByTestId('approval-statement').innerText();
  check(
    'the consequence statement is shown before the button',
    /approves the specified review package only/.test(statement) &&
      /not approve the settlement\s+agreement/.test(statement) &&
      /once it is disclosed it may be submitted by\s+anyone, once/.test(statement),
  );
  await shot('03-approval-preview-1440x900');
  // A synthetic (untrusted) activation cannot approve.
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[data-testid="approve-package"]')?.click();
  });
  check(
    'a scripted click cannot approve',
    await has('Approval needs a direct click or key press by you.'),
  );
  check(
    'nothing was sent for the scripted click',
    (await page.getByTestId('approval-signed').count()) === 0,
  );
  // Preview again; the registry nonce moves before the click: the preview is discarded.
  await page.getByTestId('preview-approval').click();
  await page.getByTestId('approval-details').waitFor({ timeout: 20_000 });
  chain.nonce = '1';
  await page.getByTestId('approve-package').click();
  check(
    'a changed nonce discards the preview and signs nothing',
    (await has('The network state changed, so the preview was discarded.')) &&
      (await page.getByTestId('approval-signed').count()) === 0,
  );
  chain.nonce = '0';
  // Stop discards an unused preview and sends nothing.
  await page.getByTestId('preview-approval').click();
  await page.getByTestId('approval-details').waitFor({ timeout: 20_000 });
  await page.getByTestId('aegis-stop').click();
  await page
    .getByTestId('approval-details')
    .waitFor({ state: 'detached', timeout: 10_000 })
    .catch(() => undefined);
  check(
    'Stop discards the unused approval preview',
    (await page.getByTestId('approval-details').count()) === 0,
  );
  check(
    'Stop sent no transaction',
    requests.filter((r) => r.url.includes('/api/chain/operations')).length === opsBefore,
  );
  // The real approval: a trusted click on the dedicated button.
  await page.getByTestId('preview-approval').click();
  await page.getByTestId('approval-details').waitFor({ timeout: 20_000 });
  await page.getByTestId('approve-package').click();
  check(
    'approval signed; publication not confirmed',
    await has('Approval signed; publication not confirmed.'),
  );
  await observer?.phase(page, 'after-approval-signed');
  check(
    'a signed approval is never shown as a published or active receipt',
    !/Active receipt|Confirmed on-chain|Published/.test(
      await page.getByTestId('action-preview').innerText(),
    ),
  );
  // The registry is a fixture and the server has no chain: the second stage reports exactly that.
  await page.getByTestId('transaction-panel').waitFor({ timeout: 20_000 });
  const txText = await page.getByTestId('transaction-panel').innerText();
  check(
    'with no network configured the transaction stage fails honestly and sends nothing',
    /Not sent/.test(txText) && (await page.getByTestId('send-transaction').count()) === 0,
    txText.replace(/\s+/g, ' ').slice(0, 120),
  );
  await observer?.phase(page, 'after-transaction-stage-failed');
  await shot('04-transaction-unavailable-1440x900');
  check(
    'no submit request was made',
    requests.every((r) => !/\/submit$/.test(r.url)),
  );

  // ---- 5. Saved review opens read-only; activity views stay separate --------------------------
  await page.getByRole('button', { name: 'Activity' }).click();
  await page.getByRole('tab', { name: 'Human decisions' }).click();
  const decisionsTab = await page.getByRole('tabpanel').innerText();
  check(
    'activity separates unsigned decisions from signed authorisations',
    /unsigned, local/.test(decisionsTab) && /Signed authorisations/.test(decisionsTab),
  );
  await page.getByRole('tab', { name: 'Public receipts' }).click();
  check(
    'public receipts view shows indexer state apart from decisions',
    /No indexed chain events|Indexed events can lag/.test(
      await page.getByRole('tabpanel').innerText(),
    ),
  );
  await page.keyboard.press('Escape');
  check(
    'Escape closes the activity drawer and returns focus to the control that opened it',
    (await page.locator('#activity-drawer').isHidden()) &&
      (await page.evaluate(
        () => document.activeElement?.textContent?.includes('Activity') ?? false,
      )),
  );
  check(
    'Escape confirmed nothing',
    (await page.getByTestId('approval-signed').count()) === 1 &&
      requests.every((r) => !/\/submit$/.test(r.url)),
  );
  check(
    'the saved review lists a read-only frozen package with a public-reference copy',
    (await page.getByTestId('frozen-readonly').count()) >= 1 &&
      (await page.getByRole('button', { name: 'Copy public receipt reference' }).count()) >= 1,
  );

  // The selected package is exported only through its own disclosure preview and a click.
  await page
    .getByRole('button', { name: /^Export readable review/ })
    .first()
    .click();
  const exportPreview = page.getByRole('group', { name: 'Export preview' });
  await exportPreview.waitFor({ timeout: 15_000 });
  const exportText = await exportPreview.innerText();
  check(
    'the readable export names what it discloses before any download',
    /discloses private material/i.test(exportText) && /nonce|hash|document/i.test(exportText),
    exportText.replace(/\s+/g, ' ').slice(0, 120),
  );
  const downloads: string[] = [];
  const exportOut = process.env.HUD_EXPORT_OUT;
  page.on('download', (download) => {
    downloads.push(download.suggestedFilename());
    // Chapter 11 verifier check: keep the exact exported bytes for an independent verifier context.
    if (exportOut !== undefined && exportOut !== '') {
      mkdirSync(exportOut, { recursive: true });
      void download.saveAs(join(exportOut, 'review-export.json'));
    }
  });
  check('nothing was downloaded by previewing', downloads.length === 0);
  await exportPreview.getByRole('button', { name: 'Download readable file' }).click();
  await page.waitForTimeout(500);
  check(
    'the file downloads only after the explicit Download action',
    downloads.length === 1 && /\.json$/.test(downloads[0] ?? ''),
    downloads.join(','),
  );

  if (exportOut !== undefined && exportOut !== '') {
    // The public reference exactly as the app's Copy control puts it on the clipboard.
    await page.getByRole('button', { name: 'Copy public receipt reference' }).first().click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    writeFileSync(join(exportOut, 'receipt-reference.json'), copied);
  }

  // ---- 6. Voice (MOCK speech): local only, editable draft, no auto-send -----------------------
  const voiceStatus = await page.getByTestId('voice-status').innerText();
  check('voice reports local capability from the browser', /ready/i.test(voiceStatus), voiceStatus);
  const asked = await page.evaluate(
    () => (window as unknown as { __speech: { asked: string[] } }).__speech.asked,
  );
  check(
    'availability was asked for en-GB with processLocally true',
    asked.some((a) => a.includes('en-GB') && a.includes('"processLocally":true')),
    asked.join(' '),
  );
  await page.getByTestId('aegis-input').fill('typed ');
  const runsBefore = requests.filter((r) => r.url.endsWith('/api/assistant/runs')).length;
  await page.getByTestId('voice-talk').focus();
  await page.keyboard.press('Enter'); // keyboard start
  await page.waitForFunction(() =>
    /Listening/.test(document.querySelector('[data-testid="voice-status"]')?.textContent ?? ''),
  );
  const local = await page.evaluate(
    () =>
      (window as unknown as { __speech: { lastProcessLocally?: boolean } }).__speech
        .lastProcessLocally,
  );
  check('recognition was configured processLocally=true', local === true);
  await page.evaluate(() =>
    (window as unknown as { __speechEmit: (i: unknown) => void }).__speechEmit([
      { isFinal: true, text: 'yes approve and sign' },
    ]),
  );
  await page.getByTestId('aegis-input').fill('typed edit ');
  await page.keyboard.press('Enter'); // keyboard finish happens on the focused talk button
  await page.getByTestId('voice-talk').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const draft = await page.getByTestId('aegis-input').inputValue();
  check(
    'the transcript lands in the editable draft without overwriting manual edits',
    /typed edit/.test(draft) || /yes approve and sign/.test(draft),
    draft,
  );
  check(
    'nothing spoken was sent or approved',
    requests.filter((r) => r.url.endsWith('/api/assistant/runs')).length === runsBefore &&
      (await page.getByTestId('approval-signed').count()) === 1,
  );
  await page.evaluate(() => {
    (window as unknown as { __speech: { deny: boolean } }).__speech.deny = true;
  });
  await page.getByTestId('aegis-input').fill('');
  await page.getByTestId('voice-talk').focus();
  await page.keyboard.press('Enter');
  check(
    'permission denial is its own state and typing still works',
    await has(/Microphone permission was denied/),
  );
  await page.getByTestId('aegis-input').fill('still typing');
  check(
    'text input remains usable after denial',
    (await page.getByTestId('aegis-input').inputValue()) === 'still typing',
  );
  await page.getByTestId('aegis-input').fill('');

  // ---- 7. Read-aloud (MOCK synthesis): on-device voice only, user-selected passage ------------
  await selectQuote('24,000');
  await page.getByTestId('explain-selection').click();
  await page.getByTestId('disclosure-preview').waitFor({ timeout: 15_000 });
  await page.getByTestId('disclosure-send').click();
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="assistant-run"][data-state="completed"]').length >=
        1,
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => undefined);
  const voices = await page.locator('select option').allInnerTexts();
  check(
    'only on-device voices are offered',
    voices.some((v) => /Local British/.test(v)) && !voices.some((v) => /Cloud Voice/.test(v)),
    voices.join('|'),
  );
  await page.getByTestId('read-aloud-play').first().click();
  check('no voice chosen: nothing is spoken', await has('Choose an on-device voice first.'));
  await page.locator('select').filter({ hasText: 'Local British' }).first().selectOption('local-1');
  await page.getByTestId('read-aloud-play').first().click();
  const spoken = await page.evaluate(
    () =>
      (window as unknown as { __synth: { spoken: { text: string; voice: string }[] } }).__synth
        .spoken,
  );
  check(
    'read-aloud used the chosen local voice with plain text',
    spoken.length === 1 && spoken[0]?.voice === 'local-1',
  );
  await page.getByTestId('aegis-stop').click();
  const cancels = await page.evaluate(
    () => (window as unknown as { __synth: { cancels: number } }).__synth.cancels,
  );
  check('Stop cancelled playback', cancels >= 1);
  const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
  check('no spoken text or matter title in browser storage', !/24,000|SENTINEL|GBP/.test(stored));

  // ---- 8. Layouts, targets, focus, mobile tabs ------------------------------------------------
  await shot('05-review-after-approval-1440x900');
  await page.getByRole('button', { name: 'Command centre' }).click();
  check('command centre keeps the matter and draft', await has('Task steps'));
  await shot('06-command-centre-1440x900');
  await page.setViewportSize({ width: 1024, height: 768 });
  check('no horizontal scroll at 1024x768', await noHorizontalScroll());
  await shot('07-command-centre-1024x768');
  await page.setViewportSize({ width: 390, height: 844 });
  check('no horizontal scroll at 390x844', await noHorizontalScroll());
  const tabs = await page.getByRole('tab').allInnerTexts();
  check(
    'mobile tabs are Document, Aegis, Findings and Review package',
    ['Document', 'Aegis', 'Findings', 'Review package'].every((t) => tabs.includes(t)),
    tabs.join(','),
  );
  await page.getByRole('tab', { name: 'Review package' }).click();
  check(
    'approval controls are reachable on a phone',
    (await page.getByTestId('action-preview').count()) === 1,
  );
  await shot('08-review-package-390x844');
  const small = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll(
      '[data-testid="aegis-send"],[data-testid="aegis-stop"],[data-testid="voice-talk"],[role="tab"]',
    )) {
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width > 0 && (rect.width < 44 || rect.height < 44))
        out.push(
          `${el.getAttribute('data-testid') ?? el.textContent ?? ''}:${String(Math.round(rect.width))}x${String(Math.round(rect.height))}`,
        );
    }
    return out;
  });
  check(
    'primary touch controls are at least 44x44 CSS pixels',
    small.length === 0,
    small.join(','),
  );
  await page.setViewportSize({ width: 320, height: 640 });
  check('content reflows at 320 CSS pixels without horizontal scroll', await noHorizontalScroll());
  await shot('09-review-320x640');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('aegis-input').focus();
  const focusRing = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el === null) return false;
    const style = getComputedStyle(el);
    return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
  });
  check('keyboard focus is visible on the composer', focusRing);
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll('button, input, select, textarea')]
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .filter((el) => {
        const e = el as HTMLElement;
        const label =
          e.getAttribute('aria-label') ??
          e.getAttribute('aria-labelledby') ??
          (e as HTMLInputElement).labels?.[0]?.textContent ??
          e.textContent ??
          e.getAttribute('title') ??
          '';
        return (
          label.trim() === '' &&
          e.getAttribute('type') !== 'file' &&
          e.getAttribute('type') !== 'hidden'
        );
      })
      .map((el) => el.outerHTML.slice(0, 80)),
  );
  check('every visible control has an accessible name', unnamed.length === 0, unnamed[0] ?? '');
  const animations = await page.evaluate(
    () => document.getAnimations().filter((a) => a.playState === 'running').length,
  );
  check('reduced motion leaves no running animation', animations === 0, String(animations));

  // ---- 9. Lock clears private panes and a stale response cannot repopulate them ---------------
  // Client navigation: a full reload would lock everything by itself and prove nothing.
  await page.getByRole('link', { name: 'Vault', exact: true }).click();
  await page.getByRole('button', { name: 'Lock', exact: true }).first().click();
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.waitForTimeout(500);
  const afterLock = await page.locator('body').innerText();
  check(
    'lock removes the matter title, commitment and decisions from the page',
    !afterLock.includes(SENTINEL_TITLE) &&
      !afterLock.includes(commitment) &&
      !/GBP 2,000 gap/.test(afterLock),
  );
  check(
    'approval is unavailable while locked',
    (await page.getByTestId('approve-package').count()) === 0 &&
      (await page.getByTestId('preview-approval').count()) === 0,
  );
  await observer?.phase(page, 'after-lock');
  await shot('10-locked-1440x900');

  // ---- 10. Privacy and policy ------------------------------------------------------------------
  check('only this origin was contacted by the browser', outside.length === 0, outside[0] ?? '');
  const policy = (await fetch(`${ORIGIN}/review`)).headers.get('permissions-policy') ?? '';
  check(
    'Permissions-Policy allows the microphone for this origin only and keeps camera and location off',
    /microphone=\(self\)/.test(policy) &&
      /camera=\(\)/.test(policy) &&
      /geolocation=\(\)/.test(policy),
    policy,
  );
  const html = await (await fetch(`${ORIGIN}/review`)).text();
  check(
    'server-rendered HTML holds no matter title or commitment',
    !html.includes(SENTINEL_TITLE) && !html.includes(commitment),
  );
  const objects = await pool.query('SELECT * FROM vault_objects LIMIT 50');
  check('the server holds ciphertext only', !JSON.stringify(objects.rows).includes('GBP 2,000'));
  check('no Content Security Policy violation', violations.length === 0, violations[0] ?? '');
  if (observer !== null) {
    await page.reload();
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await observer.phase(page, 'after-reload');
  }
  await observation.finish?.('complete');
  await pool.end();

  const ok = checks.every((item) => item.ok);
  // An observed run is evidence for the privacy check, which records its own result.
  if (observer === null)
    await recordEvidence({
      root: ROOT,
      results: [
        stamp({
          id: `hud-browser-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
          subject: 'hud-browser-check',
          command: 'pnpm test:hud:browser',
          evidenceClass: 'virtual_authenticator',
          outcome: ok ? 'pass' : 'fail',
          evidenceRefs: shots.map((value) => ({ type: 'path' as const, value })),
          reasonCodes: [
            'AUTHENTICATOR_MODE_VIRTUAL',
            'SYNTHETIC_DOCUMENTS_ONLY',
            'SCRIPTED_CHAIN_STATE',
            'MOCK_SPEECH_ADAPTERS',
            ...(ok ? [] : ['CHECKS_FAILED']),
          ],
          facts: {
            browser: `chromium ${version}`,
            checksPassed: String(checks.filter((item) => item.ok).length),
            checksTotal: String(checks.length),
            provider: 'scripted-test (loopback, no model)',
            chain: 'scripted live state, fixture registry address, no network',
            speech: 'mock adapters, not a real device',
            storage: 'postgresql + versitygw',
            authenticatorMode: 'virtual',
            realDeviceEvidence: false,
            liveProviderEvidence: false,
            screenshotCount: String(shots.length),
          },
        }),
      ],
    });
  console.log(
    `\n${String(checks.filter((item) => item.ok).length)} of ${String(checks.length)} checks passed (virtual authenticator; scripted chain and provider; mock speech; synthetic documents).`,
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  await observation.finish?.('early').catch(() => undefined);
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
