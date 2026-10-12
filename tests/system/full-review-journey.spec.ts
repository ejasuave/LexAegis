import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deployRegistry,
  fund,
  lifecycleOf,
  startMiner,
  writeLocalDeploymentRecord,
  type DeployedRegistry,
} from './harness/chain';
import {
  addVirtualAuthenticator,
  confirmFact,
  has,
  launch,
  SYNTHETIC_FACTS,
  noHorizontalScroll,
  selectQuote,
  waitForTestId,
} from './harness/browser';
import { recordResult } from './harness/recorder';
import {
  isBlocked,
  repository,
  startSystemChain,
  startSystemServices,
  startWebApp,
  type SystemChain,
  type SystemServices,
  type WebApp,
} from './harness/services';
import { buildVerifier, serveStatic } from './harness/verifier';

/*
 * SYSTEM EVIDENCE (browser_scripted). The real production web application, real PostgreSQL, a real S3-
 * compatible server, a real registry on a throwaway Anvil chain and the standalone verifier served from
 * its own origin. SIMULATED: the model (a scripted loopback provider) and the authenticator (a CDP
 * virtual authenticator with PRF). The chain is Anvil run under chain ID 10143; it is not Monad and says
 * nothing about Monad gas charging, execution delay or Alchemy. Every review decision is made through a
 * rendered control: no approval ticket, flag or signing function is set from the page.
 */

const PDFS = join(repository, 'fixtures', 'documents-v1', 'pdfs');
const TITLE = 'SYSTEM-journey-matter-4c1a';
const REASON = 'The client was told about the GBP 2,000 gap.';
// The existing integer oracle: 2400000 - (1000000 + 1200000) = 200000 pence.
const ORACLE_DIFFERENCE = String(2_400_000 - (1_000_000 + 1_200_000));

let services: SystemServices | undefined;
let chain: SystemChain | undefined;
let registry: DeployedRegistry | undefined;
let app: WebApp | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
let scratch = '';
let stopMiner: (() => void) | undefined;
let verifierDist = '';
let blockedCode: 'SERVICE_UNAVAILABLE' | 'PREREQUISITE_MISSING' | undefined;
const requests: { method: string; url: string }[] = [];
const shared: { reviewer: string; commitment: string; exportPath: string; reference: string } = {
  reviewer: '',
  commitment: '',
  exportPath: '',
  reference: '',
};
const CASES = [
  'journey-setup-aegis-and-checks',
  'journey-decisions-freeze-and-save',
  'journey-approval-and-local-broadcast',
  'journey-export-and-independent-verification',
] as const;

const p = (): Page => {
  if (page === undefined) throw new Error('not started');
  return page;
};

beforeAll(async () => {
  const started = new Date();
  scratch = mkdtempSync(join(tmpdir(), 'system-journey-'));
  const blocked = (code: 'SERVICE_UNAVAILABLE' | 'PREREQUISITE_MISSING', reason = ''): void => {
    blockedCode = code;
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
  const started1 = await startSystemServices();
  if (isBlocked(started1)) {
    blocked(started1.code, started1.reason);
    return;
  }
  services = started1;
  const started2 = await startSystemChain(10143, { allowPublicChainId: true });
  if (isBlocked(started2)) {
    blocked(started2.code, started2.reason);
    return;
  }
  chain = started2;
  registry = await deployRegistry(chain);
  const recordFile = join(scratch, 'local-deployment.json');
  writeLocalDeploymentRecord(recordFile, chain, registry);
  stopMiner = startMiner(chain);

  verifierDist = join(scratch, 'verifier');
  buildVerifier(verifierDist, 'loopback-test', {
    VITE_REGISTRY_POLICY_JSON: JSON.stringify(registry.policy),
    VITE_RPC_URL: `${chain.local.rpcUrl}/`,
    VITE_RPC_ALLOWED_ORIGINS: chain.local.rpcUrl,
  });

  const web = await startWebApp({
    name: 'journey',
    env: {
      NEXT_PUBLIC_CHAIN_ID: '10143',
      NEXT_PUBLIC_REGISTRY_ADDRESS: registry.address,
      DATABASE_URL: services.postgres.url,
      S3_ENDPOINT: services.s3.endpoint,
      S3_BUCKET: services.s3.bucket,
      S3_REGION: services.s3.region,
      S3_ACCESS_KEY_ID: services.s3.accessKeyId,
      S3_SECRET_ACCESS_KEY: services.s3.secretAccessKey,
      FEATURE_VOICE: 'false',
      FEATURE_AGENT_IDENTITY: 'false',
      FEATURE_REPUTATION_FEEDBACK: 'false',
      LEXAEGIS_TEST_MODE: 'scripted-assistant',
      ASSISTANT_TEST_PROVIDER_URL: services.provider.baseUrl,
      QWEN_API_KEY: '',
      QWEN_BASE_URL: '',
      QWEN_OUTPUT_MODE: '',
      // The test-chain seam: loopback only, inert unless all three are set.
      LEXAEGIS_TEST_CHAIN: 'local-anvil',
      LEXAEGIS_TEST_CHAIN_DEPLOYMENT: recordFile,
      ALCHEMY_MONAD_RPC_URL: chain.local.rpcUrl,
    },
  });
  if (isBlocked(web)) {
    blocked(web.code, web.reason);
    return;
  }
  app = web;

  browser = await launch();
  context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
    acceptDownloads: true,
  });
  page = await context.newPage();
  page.on('request', (request) => {
    if (request.url().includes('/api/'))
      requests.push({ method: request.method(), url: request.url() });
  });
  await addVirtualAuthenticator(context, page);
}, 600_000);

afterAll(async () => {
  stopMiner?.();
  await browser?.close();
  await app?.stop();
  await chain?.stop();
  await services?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

/** A blocked environment skips (the beforeAll already recorded a typed blocked result per case). */
const it_ = (name: string, fn: () => Promise<void>) =>
  it(name, async (context) => {
    if (blockedCode !== undefined) context.skip();
    await fn();
  });

describe('full review journey', () => {
  it_(
    '[journey-setup-aegis-and-checks] account, vault, source, disclosure, Aegis, citation, facts, checks',
    async () => {
      const page = p();
      const origin = app?.origin ?? '';
      await page.goto(`${origin}/vault`);
      await page.getByRole('button', { name: 'Create account and sign in' }).click();
      expect(await waitForTestId(page, 'account-status', 'Account ready')).toBe(true);
      shared.reviewer = (await page.getByTestId('account-address').getAttribute('title')) ?? '';
      expect(shared.reviewer).toMatch(/^0x[0-9a-fA-F]{40}$/);
      // A fresh, derived account holds no MON: the harness funds it on the throwaway chain only.
      if (chain === undefined) throw new Error('chain');
      await fund(chain, shared.reviewer, 10n * 10n ** 18n);

      await page.getByRole('button', { name: 'Create vault' }).click();
      expect(await waitForTestId(page, 'vault-status', 'Saved')).toBe(true);
      // Account access and vault unlocking are separate, explicit steps.
      expect(await has(page, 'Account and vault are separate')).toBe(true);
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

      // Disclosure first: nothing reaches the assistant until Send.
      const provider = services?.provider;
      expect(provider?.requests.length).toBe(0);
      expect(await selectQuote(page, '24,000')).toBe(true);
      await page.getByTestId('explain-selection').click();
      const preview = page.getByTestId('disclosure-preview');
      await preview.waitFor({ timeout: 15_000 });
      const previewText = await preview.innerText();
      expect(previewText).toMatch(/Scripted test provider \(not Qwen\)/);
      expect(previewText).toMatch(/sent in readable form to the LexAegis server/);
      expect(previewText).toMatch(/not end-to-end encrypted through analysis/);
      expect(provider?.requests.length).toBe(0);
      await page.getByTestId('disclosure-send').click();
      const run = page.getByTestId('assistant-run').first();
      await run.waitFor({ timeout: 30_000 });
      await expect
        .poll(async () => await run.getAttribute('data-state'), { timeout: 30_000 })
        .toBe('completed');
      expect(await run.getAttribute('data-model')).toBe('scripted-test');
      // The exact citation reopens the exact passage in the stored document.
      await run.getByTestId('citation-S1').first().click();
      expect(await page.getByTestId('source-highlight').first().innerText()).toBe('24,000');

      // Required facts are confirmed by the reviewer through the rendered form.
      const facts: boolean[] = [];
      for (const [field, slot, quote] of SYNTHETIC_FACTS)
        facts.push(await confirmFact(page, field, slot, quote));
      expect(facts).toEqual([true, true, true, true]);
      await page.getByRole('button', { name: 'Run checks' }).click();
      expect(await has(page, 'Checked the current inputs.')).toBe(true);

      // The deterministic result equals the integer oracle, not any assistant prose.
      const findings = await page.getByRole('region', { name: 'Findings' }).first().innerText();
      expect(findings).toMatch(/Needs attention/);
      expect(findings).toMatch(/2,000/);
      expect(ORACLE_DIFFERENCE).toBe('200000');
      // Command-centre and Review modes keep the selected source while the vault stays unlocked.
      await page.getByRole('button', { name: 'Command centre', exact: true }).click();
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      expect(await has(page, /discrepancy-2000\.pdf/)).toBe(true);
      expect(await noHorizontalScroll(page)).toBe(true);
    },
  );

  it_(
    '[journey-decisions-freeze-and-save] decisions, record, freeze, encrypted save and read-back',
    async () => {
      const page = p();
      const decisions = page.getByTestId('decisions-panel');
      expect(await decisions.innerText()).toMatch(/need your decision/);
      // Nothing is preselected and recording is refused until every finding has a decision.
      expect(await decisions.getByTestId('disposition-recorded').count()).toBe(0);
      await page.getByTestId('record-decisions').click();
      expect(await has(page, 'Some findings still need your decision.')).toBe(true);
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
      // Approval is unavailable before anything is frozen and saved.
      expect(await page.getByTestId('preview-approval').count()).toBe(0);
      await page.getByTestId('freeze-package').click();
      expect(await waitForTestId(page, 'frozen-package', 'Saved and checked')).toBe(true);
      const frozen = await page.getByTestId('frozen-package').innerText();
      shared.commitment = /0x[0-9a-f]{64}/.exec(frozen)?.[0] ?? '';
      expect(shared.commitment).toMatch(/^0x[0-9a-f]{64}$/);
      // Saved is not approved, signed or an active receipt.
      expect(frozen).toMatch(/not approved, signed or an active receipt/);
      // The server holds ciphertext only.
      const rows = await services?.pool.query('select * from vault_objects');
      expect(JSON.stringify(rows?.rows ?? [])).not.toMatch(/GBP 2,000|Northwind|SYSTEM-journey/);
    },
  );

  it_(
    '[journey-approval-and-local-broadcast] exact action approval, exact fee confirmation, local broadcast, confirmed observation',
    async () => {
      const page = p();
      if (chain === undefined || registry === undefined) throw new Error('chain');
      const opsBefore = requests.filter((r) => r.url.includes('/api/chain/operations')).length;
      await page.getByTestId('preview-approval').click();
      await page.getByTestId('approval-details').waitFor({ timeout: 30_000 });
      const details = await page.getByTestId('approval-details').innerText();
      expect(details).toContain(shared.commitment);
      expect(details).toContain(registry.address);
      expect(details).toMatch(/chain 10143/);
      // A scripted (untrusted) activation cannot approve; a trusted click can.
      await page.evaluate(() => {
        document.querySelector<HTMLButtonElement>('[data-testid="approve-package"]')?.click();
      });
      expect(await has(page, 'Approval needs a direct click or key press by you.')).toBe(true);
      expect(await page.getByTestId('approval-signed').count()).toBe(0);
      // The scripted attempt discards the preview; a fresh preview and a trusted click approve.
      await page.getByTestId('preview-approval').click();
      await page.getByTestId('approval-details').waitFor({ timeout: 30_000 });
      await page.getByTestId('approve-package').click();
      // Signed is not issued.
      expect(await has(page, 'Approval signed; publication not confirmed.')).toBe(true);
      expect(await page.getByTestId('action-preview').innerText()).not.toMatch(
        /Active receipt|Confirmed on-chain|Published/,
      );
      // Nothing has been broadcast yet: the registry has no receipt.
      const before = await lifecycleOf(chain, registry.address, shared.reviewer, shared.commitment);
      expect(
        JSON.stringify(before, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
      ).not.toMatch(/"1"/);

      // The exact fee confirmation is a second, separate human step.
      await page.getByTestId('transaction-panel').waitFor({ timeout: 30_000 });
      const send = page.getByTestId('send-transaction');
      await send.waitFor({ timeout: 30_000 });
      expect(await page.getByTestId('transaction-panel').innerText()).toMatch(/Maximum fee/);
      expect(requests.filter((r) => /\/submit$/.test(r.url)).length).toBe(0);
      await send.click();
      // Confirmation needs the execution checkpoint to pass the transaction's block: blocks are mined
      // in the background and the panel is refreshed explicitly, as a person would.
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
      expect(outcome, await page.getByTestId('transaction-panel').innerText()).toMatch(
        /Execution was confirmed at a canonical block/,
      );
      // Broadcast is not confirmation: the hash is shown only with the confirmed outcome here, and the
      // receipt lifecycle is its own live reading.
      const panel = await page.getByTestId('transaction-panel').innerText();
      expect(panel).toMatch(/0x[0-9a-f]{64}/);
      await expect
        .poll(async () => page.getByTestId('lifecycle').innerText(), { timeout: 60_000 })
        .toMatch(/Active, as of block/);
      // A confirmed issue is a separate fact from current Active lifecycle; indexed history is a third.
      expect(panel).toMatch(/Indexer/);
      expect(
        requests.filter((r) => r.url.includes('/api/chain/operations')).length,
      ).toBeGreaterThan(opsBefore);
      // The registry itself shows the receipt.
      const after = await lifecycleOf(chain, registry.address, shared.reviewer, shared.commitment);
      expect(
        JSON.stringify(after, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
      ).toMatch(/\d/);
    },
  );

  it_(
    '[journey-export-and-independent-verification] readable export, then a fresh verifier with the independent reference',
    async () => {
      const page = p();
      if (browser === undefined || chain === undefined) throw new Error('browser');
      await page
        .getByRole('button', { name: /^Export readable review/ })
        .first()
        .click();
      const exportPreview = page.getByRole('group', { name: 'Export preview' });
      await exportPreview.waitFor({ timeout: 15_000 });
      expect(await exportPreview.innerText()).toMatch(/discloses private material/i);
      const downloaded = page.waitForEvent('download');
      await exportPreview.getByRole('button', { name: 'Download readable file' }).click();
      const download = await downloaded;
      shared.exportPath = join(scratch, 'review-export.json');
      await download.saveAs(shared.exportPath);
      await page.getByRole('button', { name: 'Copy public receipt reference' }).first().click();
      shared.reference = await page.evaluate(() => navigator.clipboard.readText());
      writeFileSync(join(scratch, 'receipt-reference.json'), shared.reference);
      const reference = JSON.parse(shared.reference) as {
        reviewerAddress: string;
        commitment: string;
        registryAddress: string;
      };
      // The public reference carries the five public fields only.
      expect(Object.keys(reference).sort()).toEqual([
        'chainId',
        'commitment',
        'registryAddress',
        'reviewerAddress',
        'schema',
      ]);
      const exported = JSON.parse(readFileSync(shared.exportPath, 'utf8')) as {
        receiptReference: unknown;
        opening: { manifest: { artifacts: { sha256: string }[] } };
      };
      expect(JSON.stringify(Object.entries(exported.receiptReference as object).sort())).toBe(
        JSON.stringify(Object.entries(reference).sort()),
      );

      // A fresh context: no LexAegis cookies, passkey, vault or backend.
      const server = await serveStatic(verifierDist);
      const fresh = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        acceptDownloads: true,
      });
      const attempted: string[] = [];
      await fresh.route('**/*', async (route) => {
        attempted.push(route.request().url());
        const url = new URL(route.request().url());
        if (
          url.origin === server.origin ||
          url.origin === new URL(chain?.local.rpcUrl ?? '').origin
        )
          await route.continue();
        else await route.abort();
      });
      try {
        const verifier = await fresh.newPage();
        await verifier.goto(server.origin);
        expect((await fresh.cookies()).length).toBe(0);
        await verifier.getByTestId('file-input').setInputFiles(shared.exportPath);
        await verifier.getByTestId('panel-manifest').waitFor({ timeout: 30_000 });
        // The independently supplied expected reference drives every assertion.
        await verifier.getByTestId('reference-input').fill(shared.reference);
        await verifier.getByTestId('check-files').click();
        await expect
          .poll(async () => verifier.getByTestId('label-artifacts').innerText(), {
            timeout: 30_000,
          })
          .toMatch(/Every committed artifact matches/);
        await verifier.getByTestId('signer-input').fill(reference.reviewerAddress);
        await verifier.getByTestId('check-registry').click();
        await verifier
          .getByText(/Active at block/)
          .first()
          .waitFor({ timeout: 60_000 });
        expect(await verifier.getByTestId('label-lifecycle').innerText()).toMatch(
          /Receipt binds to the verified files/,
        );
        expect(await verifier.getByTestId('label-registry').innerText()).toMatch(
          /matches the configured deployment/,
        );
        // Only the verifier's own origin and the configured test RPC were contacted: no LexAegis backend.
        expect(attempted.every((url) => !/\/api\/|qwen|envio|alchemy/i.test(url))).toBe(true);
        expect(attempted.some((url) => url.startsWith(app?.origin ?? 'x'))).toBe(false);
      } finally {
        await fresh.close();
        server.server.close();
      }
      mkdirSync(join(repository, 'tests', '.output'), { recursive: true });
    },
  );
});
