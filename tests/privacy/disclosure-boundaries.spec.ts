import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyse, observationsSchema, type Observations } from '../../tooling/src/privacy/analyse';
import {
  attachPrivacyObserver,
  openPrivacyServerLog,
  type PrivacyObserver,
} from '../../tooling/src/privacy/observe';
import {
  deployRegistry,
  fund,
  startMiner,
  writeLocalDeploymentRecord,
} from '../system/harness/chain';
import {
  addVirtualAuthenticator,
  confirmFact,
  has,
  launch,
  selectQuote,
  SYNTHETIC_FACTS,
  waitForTestId,
} from '../system/harness/browser';
import { PDFS } from '../system/harness/flows';
import { recordResult } from '../system/harness/recorder';
import {
  isBlocked,
  repository,
  startSystemChain,
  startSystemServices,
  startWebApp,
  type SystemChain,
  type SystemServices,
  type WebApp,
} from '../system/harness/services';

/*
 * SYSTEM EVIDENCE (browser_scripted). The Chapter 17 observation layer and disclosure matrix, attached to
 * a NEW complete journey that also broadcasts a real transaction to a loopback registry. Planted
 * synthetic canaries are searched in browser storage, network bodies, the console, the provider's
 * requests, the server log, every database row and every stored object, in plain, escaped, URL, hex and
 * base64 forms. Canary absence is a bounded regression test, not proof against every encoding or side
 * channel, and the scripted provider means nothing was observed at a real model provider or host.
 * Browser interception cannot see what the backend sent to S3 or Qwen: those layers are named
 * unverified, and the server egress recorder lists only destinations.
 */

const CASES = [
  'privacy-observed-journey-disclosure-matrix',
  'privacy-assistant-consent-and-failure-boundaries',
  'privacy-logging-and-evidence-hygiene',
] as const;
const TITLE = 'SENTINEL-system-matter-71be';
const REASON = 'The client was told about the GBP 2,000 gap.';

let services: SystemServices | undefined;
let chain: SystemChain | undefined;
let web: WebApp | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
let observer: PrivacyObserver | null = null;
let stopMiner: (() => void) | undefined;
let scratch = '';
let observeDir = '';
let blocked = false;
let analysis: ReturnType<typeof analyse> | undefined;
let observed: Observations | undefined;
const exported = { path: '' };
const consentLog: string[] = [];

beforeAll(async () => {
  const started = new Date();
  scratch = mkdtempSync(join(tmpdir(), 'system-privacy-'));
  observeDir = join(scratch, 'observe');
  mkdirSync(observeDir, { recursive: true });
  // The Chapter 17 observer is armed by this variable. It is test-owned and deleted with `scratch`.
  process.env.PRIVACY_OBSERVE_DIR = observeDir;
  const block = (code: 'SERVICE_UNAVAILABLE' | 'PREREQUISITE_MISSING', reason: string): void => {
    blocked = true;
    for (const id of CASES)
      recordResult({
        caseId: id,
        status: 'blocked',
        evidenceClass: 'browser_scripted',
        startedAt: started,
        configuration: { reason },
        issueCodes: [code],
      });
  };
  const s = await startSystemServices();
  if (isBlocked(s)) {
    block(s.code, s.reason);
    return;
  }
  services = s;
  const c = await startSystemChain(10143, { allowPublicChainId: true });
  if (isBlocked(c)) {
    block(c.code, c.reason);
    return;
  }
  chain = c;
  const registry = await deployRegistry(c);
  const recordFile = join(scratch, 'local-deployment.json');
  writeLocalDeploymentRecord(recordFile, c, registry);
  stopMiner = startMiner(c);
  const log = openPrivacyServerLog('system');
  const app = await startWebApp({
    name: 'privacy',
    serverLog: log ?? undefined,
    env: {
      NEXT_PUBLIC_CHAIN_ID: '10143',
      NEXT_PUBLIC_REGISTRY_ADDRESS: registry.address,
      DATABASE_URL: s.postgres.url,
      S3_ENDPOINT: s.s3.endpoint,
      S3_BUCKET: s.s3.bucket,
      S3_REGION: s.s3.region,
      S3_ACCESS_KEY_ID: s.s3.accessKeyId,
      S3_SECRET_ACCESS_KEY: s.s3.secretAccessKey,
      FEATURE_VOICE: 'false',
      FEATURE_AGENT_IDENTITY: 'false',
      FEATURE_REPUTATION_FEEDBACK: 'false',
      LEXAEGIS_TEST_MODE: 'scripted-assistant',
      ASSISTANT_TEST_PROVIDER_URL: s.provider.baseUrl,
      QWEN_API_KEY: '',
      QWEN_BASE_URL: '',
      QWEN_OUTPUT_MODE: '',
      LEXAEGIS_TEST_CHAIN: 'local-anvil',
      LEXAEGIS_TEST_CHAIN_DEPLOYMENT: recordFile,
      ALCHEMY_MONAD_RPC_URL: c.local.rpcUrl,
    },
  });
  if (isBlocked(app)) {
    block(app.code, app.reason);
    return;
  }
  web = app;
  browser = await launch();
  // No trace, video, HAR or saved authentication state is ever enabled for this context.
  context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
    acceptDownloads: true,
  });
  observer = await attachPrivacyObserver(context, {
    journey: 'system',
    origin: app.origin,
    serverLog: log,
  });
  page = await context.newPage();
  await addVirtualAuthenticator(context, page);
  const file = readFileSync(join(PDFS, 'discrepancy-2000.pdf'));
  const plant = (
    id: string,
    klass: Parameters<NonNullable<typeof observer>['canary']>[0]['class'],
    kind: 'text' | 'bytes' | 'token',
    value: string,
  ): void => observer?.canary({ id, class: klass, kind, value });
  plant('matter-title', 'matter_title', 'text', TITLE);
  plant('pdf-file-name', 'filename', 'text', 'discrepancy-2000.pdf');
  plant(
    'source-file-sha256',
    'artifact_hash',
    'bytes',
    createHash('sha256').update(file).digest('hex'),
  );
  plant('pdf-employer', 'unselected_text', 'text', 'Northwind Demo Ltd');
  plant('pdf-heading', 'unselected_text', 'text', 'SYNTHETIC SETTLEMENT AGREEMENT');
  plant('pdf-total-line', 'unselected_text', 'text', 'Total settlement payment');
  plant('pdf-total-amount', 'unselected_text', 'text', 'GBP 24,000');
  plant('fact-total-pence', 'money_field', 'token', '2400000');
  plant('fact-instalment-pence', 'money_field', 'token', '1200000');
  plant('reviewer-reason', 'reviewer_note', 'text', REASON);
  plant('storage-secret', 'storage_credential', 'text', s.s3.secretAccessKey);
  plant('storage-access-key', 'storage_credential', 'text', s.s3.accessKeyId);
  plant('database-url', 'database_credential', 'text', s.postgres.url);
}, 900_000);

afterAll(async () => {
  stopMiner?.();
  await browser?.close();
  await web?.stop();
  await chain?.stop();
  await services?.stop();
  delete process.env.PRIVACY_OBSERVE_DIR;
  rmSync(scratch, { recursive: true, force: true });
});

const it_ = (name: string, fn: () => Promise<void> | void) =>
  it(name, async (testContext) => {
    if (blocked) testContext.skip();
    await fn();
  });
const p = (): Page => {
  if (page === undefined) throw new Error('not started');
  return page;
};
const provider = () => {
  if (services === undefined) throw new Error('not started');
  return services.provider;
};
const phase = async (name: string): Promise<void> => {
  await observer?.phase(p(), name);
};
const typeToAegis = async (text: string): Promise<void> => {
  await p().getByTestId('aegis-input').click();
  await p().getByTestId('aegis-input').fill(text);
  await p().keyboard.press('Enter');
};

describe('[privacy-assistant-consent-and-failure-boundaries] explicit consent, renewed consent and provider failure', () => {
  it_(
    'nothing reaches the assistant until an explicit Send, and the selection never expands',
    async () => {
      const page = p();
      await page.goto(`${web?.origin ?? ''}/review`);
      await phase('before-account');
      await page.goto(`${web?.origin ?? ''}/vault`);
      await page.getByRole('button', { name: 'Create account and sign in' }).click();
      expect(await waitForTestId(page, 'account-status', 'Account ready')).toBe(true);
      const address = (await page.getByTestId('account-address').getAttribute('title')) ?? '';
      if (chain === undefined) throw new Error('chain');
      await fund(chain, address, 10n * 10n ** 18n);
      await page.getByRole('button', { name: 'Create vault' }).click();
      expect(await waitForTestId(page, 'vault-status', 'Saved')).toBe(true);
      await page.getByLabel('New matter title').fill(TITLE);
      await page.getByRole('button', { name: 'Create matter' }).click();
      await page
        .getByRole('button', { name: new RegExp(TITLE) })
        .first()
        .waitFor({ timeout: 15_000 });
      await page.getByRole('link', { name: 'Review', exact: true }).click();
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await page.getByTestId('pdf-input').setInputFiles(join(PDFS, 'discrepancy-2000.pdf'));
      expect(await has(page, /discrepancy-2000\.pdf: saved encrypted/, 40_000)).toBe(true);
      await page.getByRole('button', { name: 'Next page' }).click();
      expect(await has(page, /Total settlement payment: GBP 24,000/)).toBe(true);
      for (const [field, slot, quote] of SYNTHETIC_FACTS)
        expect(await confirmFact(page, field, slot, quote)).toBe(true);
      await phase('after-unlock-save-and-facts');
      // Importing, confirming facts and selecting text sent nothing.
      expect(provider().requests).toHaveLength(0);

      // A preview is not a send: it shows what WOULD leave, and the provider is still untouched.
      await selectQuote(page, '24,000');
      await page.getByTestId('explain-selection').click();
      await page.getByTestId('disclosure-preview').waitFor({ timeout: 15_000 });
      expect(provider().requests).toHaveLength(0);

      // Changing the selection renews consent: the old preview is discarded and Send then does nothing.
      await selectQuote(page, '10,000');
      await expect
        .poll(() => page.getByTestId('disclosure-preview').count(), { timeout: 5_000 })
        .toBe(0);
      expect(await page.getByTestId('aegis-notice').innerText()).toMatch(
        /selection changed.*Nothing was sent/s,
      );
      expect(provider().requests).toHaveLength(0);

      // A new preview for the new selection, then an explicit Send.
      await page.getByTestId('explain-selection').click();
      await page.getByTestId('disclosure-preview').waitFor({ timeout: 15_000 });
      await page.getByTestId('disclosure-send').click();
      consentLog.push('send-10,000');
      const card = page.getByTestId('assistant-run').first();
      await expect
        .poll(() => card.getAttribute('data-state'), { timeout: 30_000 })
        .toBe('completed');
      const sent = JSON.stringify(provider().requests);
      // Only the excerpt the reviewer selected and consented to: neither the earlier selection nor any
      // unselected line of the document was expanded into the request.
      expect(sent).toContain('10,000');
      for (const never of [
        '24,000',
        'Northwind Demo Ltd',
        'SYNTHETIC SETTLEMENT AGREEMENT',
        'Total settlement payment',
        TITLE,
        'discrepancy-2000.pdf',
      ])
        expect(sent, never).not.toContain(never);
      await phase('after-consented-run');
    },
  );

  it_(
    'a provider failure is reported, bounded and retried only through a new explicit disclosure',
    async () => {
      const page = p();
      const before = provider().requests.length;
      await typeToAegis('FAIL-TEST explain this clause');
      await page.getByTestId('disclosure-preview').waitFor({ timeout: 15_000 });
      expect(provider().requests.length).toBe(before);
      await page.getByTestId('disclosure-send').click();
      const cards = page.getByTestId('assistant-run');
      await expect
        .poll(() => cards.last().getAttribute('data-state'), { timeout: 40_000 })
        .toBe('failed');
      const attempts = provider().requests.length - before;
      // At most six provider attempts for one run, and the failure is typed, not a success.
      expect(attempts).toBeGreaterThanOrEqual(1);
      expect(attempts).toBeLessThanOrEqual(6);
      expect(await cards.last().innerText()).toMatch(/could not be reached/);
      // No silent continuation: the count is stable and no preview reappears by itself.
      await page.waitForTimeout(3_000);
      expect(provider().requests.length - before).toBe(attempts);
      expect(await page.getByTestId('disclosure-preview').count()).toBe(0);
      // A retry is a NEW preview and a NEW Send.
      await typeToAegis('FAIL-TEST explain this clause');
      await page.getByTestId('disclosure-preview').waitFor({ timeout: 15_000 });
      expect(provider().requests.length - before).toBe(attempts);
      await page
        .getByTestId('aegis-stop')
        .click()
        .catch(() => undefined);
      await page
        .getByRole('button', { name: /^Cancel|Discard/ })
        .first()
        .click({ timeout: 2_000 })
        .catch(() => undefined);
    },
  );

  it_(
    'Stop during a provider wait ends the run and no further provider request follows',
    async () => {
      const page = p();
      // Clear any pending preview first.
      if ((await page.getByTestId('disclosure-preview').count()) > 0) {
        await page.keyboard.press('Escape');
      }
      const before = provider().requests.length;
      await typeToAegis('SLOW-TEST explain this clause');
      await page.getByTestId('disclosure-preview').waitFor({ timeout: 15_000 });
      await page.getByTestId('disclosure-send').click();
      await expect
        .poll(() => provider().requests.length, { timeout: 20_000 })
        .toBeGreaterThan(before);
      await page.getByTestId('aegis-stop').click();
      const cards = page.getByTestId('assistant-run');
      await expect
        .poll(async () => (await cards.last().getAttribute('data-state')) ?? '', {
          timeout: 30_000,
        })
        .toMatch(/cancelled|failed/);
      const settled = provider().requests.length;
      await page.waitForTimeout(3_000);
      expect(provider().requests.length).toBe(settled);
    },
  );
});

describe('[privacy-observed-journey-disclosure-matrix] the Chapter 17 matrix over the complete journey with a real local broadcast', () => {
  it_(
    'review, freeze, encrypted save, approval, broadcast, export and lock leak nothing outside the matrix',
    async () => {
      const page = p();
      await page.getByRole('button', { name: 'Run checks' }).click();
      expect(await has(page, 'Checked the current inputs.')).toBe(true);
      const decisions = page.getByTestId('decisions-panel');
      for (let index = 0; index < 20; index += 1) {
        const row = decisions
          .locator('li[data-finding]')
          .filter({ has: page.getByRole('button', { name: 'Accept unresolved concern' }) })
          .first();
        if ((await row.count()) === 0) break;
        await row.getByRole('button', { name: 'Accept unresolved concern' }).click();
        await row.getByLabel(/^Reason/).fill(REASON);
        await row.getByRole('button', { name: 'Save my decision' }).click();
        await page.waitForTimeout(200);
      }
      await page.getByTestId('record-decisions').click();
      expect(await has(page, /Recording is not approval/)).toBe(true);
      await page.getByTestId('build-preview').click();
      expect(await has(page, 'Review memo')).toBe(true);
      await page.getByTestId('freeze-package').click();
      expect(await waitForTestId(page, 'frozen-package', 'Saved and checked')).toBe(true);
      await phase('after-freeze-and-save');

      await page.getByTestId('preview-approval').click();
      await page.getByTestId('approval-details').waitFor({ timeout: 30_000 });
      await page.getByTestId('approve-package').click();
      expect(await has(page, 'Approval signed; publication not confirmed.')).toBe(true);
      await phase('after-approval-signed');
      await page.getByTestId('send-transaction').waitFor({ timeout: 30_000 });
      await page.getByTestId('send-transaction').click();
      let outcome = '';
      for (let attempt = 0; attempt < 40; attempt += 1) {
        outcome = await page
          .getByTestId('tx-outcome')
          .innerText()
          .catch(() => '');
        if (/Execution was confirmed at a canonical block/.test(outcome)) break;
        const refresh = page.getByTestId('refresh-status');
        if ((await refresh.count()) > 0) await refresh.click();
        await page.waitForTimeout(2_000);
      }
      expect(outcome).toMatch(/Execution was confirmed at a canonical block/);
      await phase('after-broadcast-confirmed');

      // The explicit readable export is the one place the package is deliberately disclosed.
      await page
        .getByRole('button', { name: /^Export readable review/ })
        .first()
        .click();
      const preview = page.getByRole('group', { name: 'Export preview' });
      await preview.waitFor({ timeout: 15_000 });
      const download = page.waitForEvent('download');
      await preview.getByRole('button', { name: 'Download readable file' }).click();
      exported.path = join(scratch, 'review-export.json');
      await (await download).saveAs(exported.path);
      await phase('after-export');
      await page.getByRole('link', { name: 'Vault', exact: true }).click();
      await page.getByRole('button', { name: 'Lock vault' }).click();
      await phase('after-lock');
      await page.reload();
      await phase('after-reload');

      if (services === undefined || web === undefined || chain === undefined)
        throw new Error('not started');
      const rpc = new URL(chain.local.rpcUrl);
      await observer?.finish({
        consentedDisclosure: true,
        providerRequests: provider().requests,
        pool: services.pool,
        objectStoreRoot: services.s3.root,
        serverEgressAllowed: [
          services.postgres.url,
          services.s3.endpoint,
          provider().baseUrl,
          chain.local.rpcUrl,
        ].map((url) => {
          const parsed = new URL(url);
          return `${parsed.hostname}:${parsed.port}`;
        }),
        unobserved: [
          'what the backend sent to S3 (only the destination is recorded) and to Qwen (a scripted provider is used)',
          `a real provider's, host's or sponsor-side logs and retention (the chain endpoint ${rpc.host} is a loopback Anvil)`,
          'storage writes made inside a worker (snapshots still see what persisted)',
          'memory',
        ],
      });
      observed = observationsSchema.parse(
        JSON.parse(readFileSync(join(observeDir, 'system', 'observations.json'), 'utf8')),
      );
      // What the readable export names must stay private everywhere else.
      const bundle = JSON.parse(readFileSync(exported.path, 'utf8')) as {
        opening: { blindingNonce: string; manifest: { artifacts: { sha256: string }[] } };
      };
      observed.canaries.push({
        id: 'opening-blinding-nonce',
        class: 'opening_nonce',
        kind: 'bytes',
        value: bundle.opening.blindingNonce.slice(2),
      });
      for (const [index, artifact] of bundle.opening.manifest.artifacts.entries())
        observed.canaries.push({
          id: `artifact-sha256-${String(index + 1)}`,
          class: 'artifact_hash',
          kind: 'bytes',
          value: artifact.sha256.slice(2),
        });
      analysis = analyse(observed);
      expect(analysis.violations, JSON.stringify(analysis.violations).slice(0, 800)).toEqual([]);
      // Every layer contributed: an unobserved layer is not a clean layer.
      for (const [layer, minimum] of [
        ['storageWrites', 1],
        ['snapshots', 7],
        ['requests', 10],
        ['responses', 5],
        ['serverLogBytes', 1],
        ['databaseBytes', 10],
        ['storedObjects', 1],
      ] as const)
        expect(analysis.coverage[layer] ?? 0, layer).toBeGreaterThanOrEqual(minimum);
      expect(observed.canaries.some((canary) => canary.class === 'prf_output')).toBe(true);
      expect(observed.canaries.some((canary) => canary.class === 'signing_key')).toBe(true);
      expect(observed.canaries.some((canary) => canary.class === 'session_cookie')).toBe(true);
      // The server only contacted its database, object store, scripted provider and the local chain.
      expect(
        observed.serverEgress.every((destination) =>
          observed?.serverEgressAllowed.includes(destination),
        ),
      ).toBe(true);
      // Unobserved layers are stated, never silently clean.
      expect(observed.unobserved.length).toBeGreaterThan(0);
    },
  );
});

describe('[privacy-logging-and-evidence-hygiene] allowlisted logs and evidence that holds no credential', () => {
  it_('server logs hold only allowlisted operational fields and no canary', () => {
    if (observed === undefined) throw new Error('the observed journey did not run');
    const lines = observed.serverLog.split('\n').filter((line) => line.trim().startsWith('{'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      for (const key of Object.keys(entry))
        expect(['level', 'event', 'requestId', 'code', 'status'], key).toContain(key);
    }
    for (const canary of observed.canaries) expect(observed.serverLog).not.toContain(canary.value);
    // A provider failure was logged by code only, never by request or error body.
    expect(observed.serverLog).not.toMatch(/FAIL-TEST|ScriptedProviderFailure/);
  });

  it_(
    'no screenshot, trace, HAR, video or saved authentication state is produced or committed',
    () => {
      const sources = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
          const path = join(dir, name);
          if (name === 'node_modules' || name.startsWith('.')) return [];
          return statSync(path).isDirectory()
            ? sources(path)
            : /\.(?:ts|mts)$/.test(name)
              ? [path]
              : [];
        });
      const own = new RegExp(
        [
          'storage' + 'State',
          'record' + 'Har',
          'tracing' + '\\.start',
          'record' + 'Video',
          'page' + '\\.screenshot',
        ].join('|'),
      );
      // The one exception: the accessibility spec photographs SYNTHETIC pages for the public evidence
      // set. It may use a screenshot and nothing else on this list, and only into docs/evidence/chapter12.
      const photographs = /accessibility-and-reflow\.spec\.ts$/;
      for (const file of sources(join(repository, 'tests')))
        if (!/disclosure-boundaries\.spec\.ts$/.test(file) && !/harness\.test\.ts$/.test(file)) {
          const text = readFileSync(file, 'utf8');
          if (!photographs.test(file)) {
            expect(text, file).not.toMatch(own);
            continue;
          }
          expect(text, file).not.toMatch(
            new RegExp(
              [
                'storage' + 'State',
                'record' + 'Har',
                'tracing' + '\\.start',
                'record' + 'Video',
              ].join('|'),
            ),
          );
          const targets = [...text.matchAll(/page\.screenshot\(\{\s*path:\s*([^,}]+)/g)].map(
            (m) => m[1],
          );
          expect(targets.length, file).toBeGreaterThan(0);
          for (const target of targets) expect(target, file).toMatch(/^join\(EVIDENCE$/);
          expect(text, file).toMatch(
            /const EVIDENCE = join\(repository, 'docs', 'evidence', 'chapter12'\)/,
          );
        }
      const ignore = readFileSync(join(repository, '.gitignore'), 'utf8');
      expect(ignore).toMatch(/^tests\/\.output\/$/m);
      expect(ignore).toMatch(/^\.env$/m);
      // The only artefacts this run wrote live under the ignored output directory or the temp folder.
      expect(scratch.startsWith(tmpdir())).toBe(true);
    },
  );
});
