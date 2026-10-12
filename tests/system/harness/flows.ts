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
