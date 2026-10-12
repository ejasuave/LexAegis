import { join } from 'node:path';
import type { Page } from 'playwright';
import { confirmFact, has, SYNTHETIC_FACTS, waitForTestId } from './browser';
import { repository } from './services';

/*
 * Reusable rendered-control flows. Each step is a click, a typed value or a file choice a person
 * could make; none writes approval state, calls a private function or posts to an API directly.
 */

export const PDFS = join(repository, 'fixtures', 'documents-v1', 'pdfs');

export interface Account {
  readonly address: string;
}

export async function createAccountAndVault(page: Page, origin: string): Promise<Account> {
  await page.goto(`${origin}/vault`);
  await page.getByRole('button', { name: 'Create account and sign in' }).click();
  if (!(await waitForTestId(page, 'account-status', 'Account ready')))
    throw new Error('account not ready');
  const address = (await page.getByTestId('account-address').getAttribute('title')) ?? '';
  await page.getByRole('button', { name: 'Create vault' }).click();
  if (!(await waitForTestId(page, 'vault-status', 'Saved'))) throw new Error('vault not created');
  return { address };
}

export async function addMatterAndDocument(page: Page, title: string): Promise<void> {
  await page.getByLabel('New matter title').fill(title);
  await page.getByRole('button', { name: 'Create matter' }).click();
  await page
    .getByRole('button', { name: new RegExp(title) })
    .first()
    .waitFor({ timeout: 15_000 });
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByTestId('pdf-input').setInputFiles(join(PDFS, 'discrepancy-2000.pdf'));
  if (!(await has(page, /discrepancy-2000\.pdf: saved encrypted/, 40_000)))
    throw new Error('import failed');
  await page.getByRole('button', { name: 'Next page' }).click();
  await has(page, /Total settlement payment: GBP 24,000/);
}

export async function confirmFactsAndCheck(page: Page): Promise<void> {
  for (const [field, slot, quote] of SYNTHETIC_FACTS)
    if (!(await confirmFact(page, field, slot, quote)))
      throw new Error(`fact ${slot} not confirmed`);
  await page.getByRole('button', { name: 'Run checks' }).click();
  if (!(await has(page, 'Checked the current inputs.'))) throw new Error('checks did not run');
}

export async function decideRecordAndFreeze(page: Page, reason: string): Promise<string> {
  const decisions = page.getByTestId('decisions-panel');
  for (let index = 0; index < 20; index += 1) {
    const row = decisions
      .locator('li[data-finding]')
      .filter({ has: page.getByRole('button', { name: 'Accept unresolved concern' }) })
      .first();
    if ((await row.count()) === 0) break;
    await row.getByRole('button', { name: 'Accept unresolved concern' }).click();
    await row.getByLabel(/^Reason/).fill(reason);
    await row.getByRole('button', { name: 'Save my decision' }).click();
    await page.waitForTimeout(200);
  }
  await page.getByTestId('record-decisions').click();
  if (!(await has(page, /Recording is not approval/))) throw new Error('decisions not recorded');
  await page.getByTestId('build-preview').click();
  await has(page, 'Review memo');
  await page.getByTestId('freeze-package').click();
  if (!(await waitForTestId(page, 'frozen-package', 'Saved and checked')))
    throw new Error('freeze failed');
  const frozen = await page.getByTestId('frozen-package').innerText();
  return /0x[0-9a-f]{64}/.exec(frozen)?.[0] ?? '';
}

/** Clears only this origin's cookies and web storage; the authenticator's credential stays. */
export async function clearOriginState(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    for (const database of await indexedDB.databases())
      if (database.name !== undefined) indexedDB.deleteDatabase(database.name);
    for (const key of await caches.keys()) await caches.delete(key);
  });
}

/**
 * From a frozen package to a confirmed local registry receipt and the readable export, exactly as the
 * full journey does it. Returns the downloaded file and the public receipt reference copied from the UI.
 */
export async function approveSendAndExport(
  page: Page,
  scratch: string,
): Promise<{ exportPath: string; reference: string }> {
  await page.getByTestId('preview-approval').click();
  await page.getByTestId('approval-details').waitFor({ timeout: 30_000 });
  await page.getByTestId('approve-package').click();
  const send = page.getByTestId('send-transaction');
  await send.waitFor({ timeout: 60_000 });
  await send.click();
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
  if (!/Execution was confirmed at a canonical block/.test(outcome))
    throw new Error('the local transaction was not confirmed');
  await page
    .getByRole('button', { name: /^Export readable review/ })
    .first()
    .click();
  const preview = page.getByRole('group', { name: 'Export preview' });
  await preview.waitFor({ timeout: 15_000 });
  const downloaded = page.waitForEvent('download');
  await preview.getByRole('button', { name: 'Download readable file' }).click();
  const exportPath = join(scratch, `export-${String(Date.now())}.json`);
  await (await downloaded).saveAs(exportPath);
  await page.getByRole('button', { name: 'Copy public receipt reference' }).first().click();
  const reference = await page.evaluate(() => navigator.clipboard.readText());
  return { exportPath, reference };
}
