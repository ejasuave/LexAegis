import { chmodSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CDPSession, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyReviewExport } from '@lexaegis/sdk/verify';
import { createS3ObjectStore, objectKey } from '../../apps/web/src/server/vault/object-store';
import { has, waitForTestId } from './harness/browser';
import {
  addMatterAndDocument,
  PDFS,
  clearOriginState,
  confirmFactsAndCheck,
  createAccountAndVault,
  decideRecordAndFreeze,
} from './harness/flows';
import { startSuite, type Suite } from './harness/suite';
import { isBlocked } from './harness/services';
import { waitUntil } from './harness/poll';

/*
 * SYSTEM EVIDENCE (browser_scripted). Recovery around the UNCHANGED lexaegis.evm.bip32-prf.v1 profile,
 * its account and vault PRF salts and the configured rpId, on the production build with a real
 * PostgreSQL and S3-compatible store. The authenticator is a CDP VIRTUAL authenticator: these tests
 * demonstrate controller logic only. A new browser context is not proof of authenticator
 * synchronisation, and same-credential real-device and second-device evidence stays in Task 15.
 */

const CASES = [
  'recovery-frozen-review-after-storage-clear',
  'recovery-wrong-credential-and-missing-prf',
  'recovery-storage-faults-are-not-an-empty-vault',
  'recovery-session-limits-and-late-callbacks',
  'recovery-rollback-detection-and-limits',
] as const;
const TITLE = 'SYSTEM-recovery-matter-9d02';
const REASON = 'Recorded in the reviewer’s own words for the recovery check.';

let suite: Suite | undefined;
const run = (name: string, fn: (suite: Suite) => Promise<void>) =>
  it(name, async (context) => {
    if (suite === undefined) {
      context.skip();
      return;
    }
    await fn(suite);
  });

beforeAll(async () => {
  const started = await startSuite({ name: 'recovery', cases: CASES });
  if (isBlocked(started)) {
    return;
  }
  suite = started;
}, 600_000);
afterAll(async () => {
  await suite?.stop();
});

const count = async (suite: Suite, table: string): Promise<number> =>
  (await suite.services.pool.query<{ n: number }>(`select count(*)::int as n from ${table}`))
    .rows[0]?.n ?? -1;
const credentialCount = async (handle: {
  readonly cdp: CDPSession;
  readonly authenticatorId: string;
}): Promise<number> =>
  (await handle.cdp.send('WebAuthn.getCredentials', { authenticatorId: handle.authenticatorId }))
    .credentials.length;

describe('account and vault recovery', () => {
  let reference = '';
  let originalCommitment = '';
  let originalAddress = '';

  run(
    "[recovery-frozen-review-after-storage-clear] same derived account, decrypted bytes and commitment after only this origin's state is cleared",
    async (suite) => {
      const { page, cdp } = await suite.newSession();
      const account = await createAccountAndVault(page, suite.app.origin);
      originalAddress = account.address;
      await addMatterAndDocument(page, TITLE);
      await confirmFactsAndCheck(page);
      originalCommitment = await decideRecordAndFreeze(page, REASON);
      expect(originalCommitment).toMatch(/^0x[0-9a-f]{64}$/);
      await page.getByRole('button', { name: 'Copy public receipt reference' }).first().click();
      reference = await page.evaluate(() => navigator.clipboard.readText());
      expect(JSON.parse(reference)).toMatchObject({
        commitment: originalCommitment,
        reviewerAddress: originalAddress.toLowerCase(),
      });
      const credentialsBefore = cdp === null ? 0 : await credentialCount(cdp);
      const vaultsBefore = await count(suite, 'vaults');
      const objectsBefore = await count(suite, 'vault_objects');

      // End the application session, then clear ONLY this test origin's cookies and web storage. The
      // virtual authenticator's credential is retained: this is not a new passkey.
      // Client-side navigation keeps the unlocked state (a page load would drop it from memory).
      await page.getByRole('link', { name: 'Vault', exact: true }).click();
      await page.getByRole('button', { name: 'Lock vault' }).click();
      await page.getByRole('button', { name: 'Sign out' }).click();
      expect(await waitForTestId(page, 'backend-state', 'Signed out')).toBe(true);
      await clearOriginState(page);
      await page.reload();
      expect(await waitForTestId(page, 'account-status', 'No account')).toBe(true);

      // Recover: discoverable credential selection, fresh backend authentication, explicit vault unlock.
      await page.getByRole('button', { name: 'Recover vault' }).click();
      expect(await waitForTestId(page, 'account-status', 'Account ready')).toBe(true);
      expect(await page.getByTestId('account-address').getAttribute('title')).toBe(originalAddress);
      expect(await waitForTestId(page, 'vault-status', /Saved|Unlocked/)).toBe(true);
      expect(await waitForTestId(page, 'backend-state', 'Signed in')).toBe(true);
      // No new passkey, vault or object was created by recovery.
      expect(cdp === null ? 0 : await credentialCount(cdp)).toBe(credentialsBefore);
      expect(await count(suite, 'vaults')).toBe(vaultsBefore);
      expect(await count(suite, 'vault_objects')).toBe(objectsBefore);

      // A matching displayed address alone is not enough: the decrypted bytes must verify.
      await page
        .getByRole('button', { name: new RegExp(TITLE) })
        .first()
        .click();
      await page.getByRole('link', { name: 'Review', exact: true }).click();
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      // Opening a saved review rebuilds the recoverable capture: retrieval, decryption, verification.
      await page.getByRole('button', { name: 'Open read-only (verify now)' }).first().click();
      await page.getByTestId('frozen-readonly').first().waitFor({ timeout: 30_000 });
      // The approval ticket is never restored; the frozen package is rebuilt by retrieval.
      expect(await page.getByTestId('approval-signed').count()).toBe(0);
      await page
        .getByRole('button', { name: /^Export readable review/ })
        .first()
        .click();
      const preview = page.getByRole('group', { name: 'Export preview' });
      await preview.waitFor({ timeout: 15_000 });
      const download = page.waitForEvent('download');
      await preview.getByRole('button', { name: 'Download readable file' }).click();
      const path = join(suite.services.s3.root, '..', `recovered-${String(Date.now())}.json`);
      await (await download).saveAs(path);
      const verified = await verifyReviewExport({
        file: new Uint8Array(readFileSync(path)),
        expectedReference: JSON.parse(reference),
      });
      rmSync(path, { force: true });
      expect(verified.ok && verified.data.report).toMatchObject({
        referenceOrigin: 'independent',
        manifestIntegrity: 'match',
        artifactIntegrity: 'match',
      });
    },
  );

  run(
    '[recovery-wrong-credential-and-missing-prf] a different or PRF-less authenticator never creates a replacement vault',
    async (suite) => {
      const vaultsBefore = await count(suite, 'vaults');
      const sessionsBefore = await count(suite, 'auth_sessions');

      // A different authenticator holds a different credential: recovery finds no account and the
      // typed message says nothing was changed. It does not create a replacement account or vault.
      const stranger = await suite.newSession();
      await stranger.page.goto(`${suite.app.origin}/vault`);
      expect(await waitForTestId(stranger.page, 'account-status', 'No account')).toBe(true);
      const strangerBefore = stranger.cdp === null ? 0 : await credentialCount(stranger.cdp);
      await stranger.page.getByRole('button', { name: 'Recover account' }).click();
      expect(
        await waitForTestId(
          stranger.page,
          'account-error',
          /passkey prompt did not finish.*Nothing was changed/s,
          20_000,
        ),
      ).toBe(true);
      expect(await stranger.page.getByTestId('account-status').innerText()).toBe('No account');
      expect(stranger.cdp === null ? 0 : await credentialCount(stranger.cdp)).toBe(strangerBefore);
      expect(await count(suite, 'vaults')).toBe(vaultsBefore);
      expect(await count(suite, 'auth_sessions')).toBe(sessionsBefore);
      await stranger.context.close();

      // An authenticator without PRF cannot derive the account: a typed failure, no vault, no session,
      // and the message points to recovery rather than creating a second passkey.
      const noPrf = await suite.newSession({ prf: false });
      await noPrf.page.goto(`${suite.app.origin}/vault`);
      await noPrf.page.getByRole('button', { name: 'Create account and sign in' }).click();
      expect(
        await waitForTestId(
          noPrf.page,
          'account-error',
          /does not support the PRF feature.*use Recover account/s,
          20_000,
        ),
      ).toBe(true);
      expect(await noPrf.page.getByTestId('account-status').innerText()).toBe('No account');
      expect(await count(suite, 'vaults')).toBe(vaultsBefore);
      expect(await count(suite, 'auth_sessions')).toBe(sessionsBefore);
      await noPrf.context.close();

      // A cancelled ceremony (the user does not verify) creates nothing either.
      const cancelled = await suite.newSession();
      if (cancelled.cdp !== null)
        await cancelled.cdp.cdp.send('WebAuthn.setUserVerified', {
          authenticatorId: cancelled.cdp.authenticatorId,
          isUserVerified: false,
        });
      await cancelled.page.goto(`${suite.app.origin}/vault`);
      await cancelled.page.getByRole('button', { name: 'Create account and sign in' }).click();
      expect(
        await waitForTestId(
          cancelled.page,
          'account-error',
          /did not finish|not allowed|cancel/i,
          25_000,
        ),
      ).toBe(true);
      expect(await cancelled.page.getByTestId('account-status').innerText()).toBe('No account');
      expect(await count(suite, 'vaults')).toBe(vaultsBefore);
      expect(await count(suite, 'auth_sessions')).toBe(sessionsBefore);
      await cancelled.context.close();
    },
  );

  run(
    '[recovery-storage-faults-are-not-an-empty-vault] corrupt tag, missing ciphertext and outage never look like an empty vault',
    async (suite) => {
      const { page } = await suite.newSession();
      const account = await createAccountAndVault(page, suite.app.origin);
      const vaultRow = await suite.services.pool.query<{ vault_id: string }>(
        'select vault_id from vaults where owner_address = $1',
        [account.address.toLowerCase()],
      );
      const vaultId = vaultRow.rows[0]?.vault_id ?? '';
      const head = await suite.services.pool.query<{ catalog_object_id: string }>(
        'select catalog_object_id from vault_heads where vault_id = $1',
        [vaultId],
      );
      const catalog = head.rows[0]?.catalog_object_id ?? '';
      const file = join(
        suite.services.s3.root,
        suite.services.s3.bucket,
        'vaults',
        vaultId,
        'objects',
        catalog,
      );
      const original = readFileSync(file);
      const sessionsBefore = await count(suite, 'auth_sessions');
      const vaultsBefore = await count(suite, 'vaults');
      let objectsExpected = await count(suite, 'vault_objects');
      const reopen = async (): Promise<void> => {
        await page
          .getByRole('button', { name: 'Lock vault' })
          .click()
          .catch(() => undefined);
        await page
          .getByRole('button', { name: 'Sign out' })
          .click()
          .catch(() => undefined);
        await clearOriginState(page);
        await page.reload();
        await page.getByRole('button', { name: 'Recover vault' }).click();
      };
      const notEmpty = async (): Promise<void> => {
        // The vault is NOT presented as empty or recreated, and nothing on the server changed.
        expect(await page.getByTestId('vault-status').innerText()).not.toMatch(/Saved|Unlocked/);
        expect(await page.locator('body').innerText()).not.toMatch(/No matters yet/);
        expect(await count(suite, 'vaults')).toBe(vaultsBefore);
        expect(await count(suite, 'vault_objects')).toBe(objectsExpected);
      };

      // (a1) Bytes altered at rest: the server's stored digest no longer matches. Reported as a storage
      //      problem, never as an empty vault.
      const tampered = Buffer.from(original);
      tampered[tampered.length - 5] = (tampered[tampered.length - 5] ?? 0) ^ 0xff;
      writeFileSync(file, tampered);
      await reopen();
      await waitUntil('storage failure shown', async () =>
        (await page.getByTestId('vault-error').count()) > 0 ? true : null,
      );
      // The S3-compatible server itself refuses to serve a file whose bytes changed behind its back, so
      // the application reports a storage failure (observed), never an empty vault.
      expect(await page.getByTestId('vault-error').innerText()).toMatch(/Storage is unavailable/);
      await notEmpty();
      expect(readFileSync(file).equals(tampered)).toBe(true); // nothing overwrote the ciphertext
      writeFileSync(file, original);

      // (a2) A forged envelope that storage and the server both vouch for: an operator-level change that
      //      is consistent everywhere the server can check. Only the client's binding and AES-GCM
      //      authentication can (and must) refuse it before any plaintext exists.
      const forgedId = randomUUID();
      // Change one character of the base64url ciphertext, so the envelope still parses and only the
      // authentication tag can reveal the change.
      const envelopeText = original.toString('utf8');
      const at = envelopeText.indexOf('"ciphertext":"') + '"ciphertext":"'.length + 10;
      const swapped = envelopeText[at] === 'A' ? 'B' : 'A';
      const forgedBytes = Buffer.from(
        `${envelopeText.slice(0, at)}${swapped}${envelopeText.slice(at + 1)}`,
      );
      expect(forgedBytes.length).toBe(original.length);
      writeFileSync(file, original); // the backing file is intact again; the forgery is a NEW object
      const objects = createS3ObjectStore({
        endpoint: suite.services.s3.endpoint,
        bucket: suite.services.s3.bucket,
        region: suite.services.s3.region,
        accessKeyId: suite.services.s3.accessKeyId,
        secretAccessKey: suite.services.s3.secretAccessKey,
      });
      expect(await objects.putIfAbsent(objectKey(vaultId, forgedId), forgedBytes)).toBe('created');
      await suite.services.pool.query(
        `insert into vault_objects (vault_id, object_id, byte_length, sha256, state, created_at, ready_at)
         values ($1, $2, $3, $4, 'ready', now(), now())`,
        [
          vaultId,
          forgedId,
          forgedBytes.length,
          `0x${createHash('sha256').update(forgedBytes).digest('hex')}`,
        ],
      );
      objectsExpected += 1; // the forged row is the only addition, made by this test
      await suite.services.pool.query(
        'update vault_heads set catalog_object_id = $2 where vault_id = $1',
        [vaultId, forgedId],
      );
      await reopen();
      await waitUntil('authentication failure shown', async () =>
        (await page.getByTestId('vault-error').count()) > 0 ? true : null,
      );
      expect(await page.getByTestId('vault-error').innerText()).toMatch(
        /failed its integrity check.*not shown and not overwritten/s,
      );
      await notEmpty();
      // Restore the real head: nothing the failed recovery did changed the genuine ciphertext.
      await suite.services.pool.query(
        'update vault_heads set catalog_object_id = $2 where vault_id = $1',
        [vaultId, catalog],
      );
      writeFileSync(file, original);

      // (b) Missing ciphertext.
      rmSync(file, { force: true });
      await reopen();
      await waitUntil('missing-object failure shown', async () =>
        (await page.getByTestId('vault-error').count()) > 0 ? true : null,
      );
      expect(await page.getByTestId('vault-error').innerText()).toMatch(
        /Some stored files are missing.*Nothing was replaced/s,
      );
      await notEmpty();

      // (c) Storage outage: the bucket directory cannot be read.
      writeFileSync(file, original);
      const bucket = join(suite.services.s3.root, suite.services.s3.bucket);
      chmodSync(bucket, 0o000);
      try {
        await reopen();
        await waitUntil('outage shown', async () =>
          (await page.getByTestId('vault-error').count()) > 0 ? true : null,
        );
        expect(await page.getByTestId('vault-error').innerText()).toMatch(
          /Storage is unavailable.*does not mean it is empty/s,
        );
        await notEmpty();
      } finally {
        chmodSync(bucket, 0o755);
      }
      // The original ciphertext still recovers normally once storage is back: nothing was replaced.
      await reopen();
      expect(await waitForTestId(page, 'vault-status', /Saved|Unlocked/, 30_000)).toBe(true);
      expect(await page.getByTestId('account-address').getAttribute('title')).toBe(account.address);
      expect(await count(suite, 'vaults')).toBe(vaultsBefore);
      // No unplanned backend session proliferation beyond the explicit recoveries above.
      expect(await count(suite, 'auth_sessions')).toBeGreaterThanOrEqual(sessionsBefore);
    },
  );

  run(
    '[recovery-session-limits-and-late-callbacks] 5-minute idle and 10-minute absolute limits, clock rollback, BFCache, and a 15-minute backend expiry with no silent renewal',
    async (suite) => {
      const states = async (page: Page) => ({
        signing: await page.getByTestId('signing-state').innerText(),
        vault: await page.getByTestId('vault-status').innerText(),
        account: await page.getByTestId('account-status').innerText(),
      });
      const unlocked = (state: { signing: string; vault: string }): boolean =>
        /^Unlocked/.test(state.signing) && /Saved|Unlocked/.test(state.vault);
      const locked = (state: { signing: string; vault: string; account: string }): boolean =>
        state.signing === 'Locked' && state.vault === 'Locked' && state.account === 'Locked';

      // A. Idle: time passing alone locks the signing session and the vault; the backend login is a
      //    separate reading and is not renewed or ended by the browser.
      const idle = await suite.newSession({ clock: true });
      await createAccountAndVault(idle.page, suite.app.origin);
      expect(unlocked(await states(idle.page))).toBe(true);
      await idle.page.clock.fastForward('04:00');
      await idle.page.waitForTimeout(300);
      expect(unlocked(await states(idle.page))).toBe(true);
      await idle.page.clock.fastForward('02:00');
      await idle.page.waitForTimeout(500);
      expect(locked(await states(idle.page))).toBe(true);
      expect(await idle.page.getByTestId('backend-state').innerText()).toBe('Signed in');
      await idle.context.close();

      // B. Interaction renews the idle limit but never the absolute one.
      const absolute = await suite.newSession({ clock: true });
      await createAccountAndVault(absolute.page, suite.app.origin);
      await absolute.page.clock.fastForward('04:00');
      await absolute.page.mouse.click(300, 300);
      await absolute.page.clock.fastForward('04:00');
      await absolute.page.waitForTimeout(300);
      expect(unlocked(await states(absolute.page))).toBe(true); // 8 minutes in, 4 idle
      await absolute.page.mouse.click(300, 300);
      await absolute.page.clock.fastForward('03:00'); // 11 minutes in: past the absolute limit
      await absolute.page.waitForTimeout(500);
      expect(locked(await states(absolute.page))).toBe(true);
      await absolute.context.close();

      // C. A clock that moves backwards is an anomaly: the session locks instead of extending.
      const rollback = await suite.newSession({ clock: true });
      await createAccountAndVault(rollback.page, suite.app.origin);
      await rollback.page.clock.fastForward('01:00');
      await rollback.page.clock.setSystemTime(Date.now() - 3_600_000);
      await rollback.page.mouse.click(300, 300);
      await rollback.page.waitForTimeout(500);
      expect(locked(await states(rollback.page))).toBe(true);
      await rollback.context.close();

      // D. BFCache restoration: a persisted pageshow leaves nothing unlocked; a recovered browser needs
      //    new explicit authorisations.
      const bfcache = await suite.newSession();
      await createAccountAndVault(bfcache.page, suite.app.origin);
      expect(unlocked(await states(bfcache.page))).toBe(true);
      await bfcache.page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
      await bfcache.page.waitForTimeout(500);
      expect(locked(await states(bfcache.page))).toBe(true);
      await bfcache.context.close();

      // E. Backend expiry (15 minutes, server-side): a later save is refused with a typed message, the
      //    unsaved draft is kept, and no session is silently created or renewed.
      const expiry = await suite.newSession();
      await createAccountAndVault(expiry.page, suite.app.origin);
      const before = await count(suite, 'auth_sessions');
      await suite.services.pool.query(
        "update auth_sessions set expires_at = now() - interval '1 second'",
      );
      await expiry.page.getByLabel('New matter title').fill('SYSTEM-expiry');
      await expiry.page.getByRole('button', { name: 'Create matter' }).click();
      expect(await has(expiry.page, /Not signed in\. Sign in to your account first/, 20_000)).toBe(
        true,
      );
      expect(await expiry.page.getByTestId('vault-status').innerText()).toBe('Unsaved changes');
      expect(await count(suite, 'auth_sessions')).toBe(before);
      await expiry.context.close();
    },
  );

  run(
    '[recovery-rollback-detection-and-limits] a head already observed cannot regress; a full replay after total state loss is a documented limitation',
    async (suite) => {
      const { page } = await suite.newSession();
      const account = await createAccountAndVault(page, suite.app.origin);
      const vaultRow = await suite.services.pool.query<{ vault_id: string }>(
        'select vault_id from vaults where owner_address = $1',
        [account.address.toLowerCase()],
      );
      const vaultId = vaultRow.rows[0]?.vault_id ?? '';
      const first = await suite.services.pool.query<{
        revision: string;
        catalog_object_id: string;
      }>('select revision, catalog_object_id from vault_heads where vault_id = $1', [vaultId]);
      // Save a second revision in the active session (importing a document saves it encrypted).
      await addMatterAndDocument(page, 'SYSTEM-rollback-matter');
      const second = await suite.services.pool.query<{ revision: string }>(
        'select revision from vault_heads where vault_id = $1',
        [vaultId],
      );
      expect(Number(second.rows[0]?.revision)).toBeGreaterThan(Number(first.rows[0]?.revision));
      // The storage replays the OLD valid head while this session has already observed the newer one.
      await suite.services.pool.query(
        'update vault_heads set revision = $2, catalog_object_id = $3 where vault_id = $1',
        [vaultId, first.rows[0]?.revision, first.rows[0]?.catalog_object_id],
      );
      await page.getByTestId('pdf-input').setInputFiles(join(PDFS, 'discrepancy-2000.pdf'));
      expect(
        await has(page, /conflict|older|regress|changed|could not save|not saved|refresh/i, 25_000),
      ).toBe(true);
      const afterReplay = await suite.services.pool.query<{ revision: string }>(
        'select revision from vault_heads where vault_id = $1',
        [vaultId],
      );
      // The replayed head was not advanced by the refused save.
      expect(Number(afterReplay.rows[0]?.revision)).toBe(Number(first.rows[0]?.revision));
      // Limitation, recorded rather than hidden: after ALL local state is lost, the same valid old head is
      // indistinguishable from the truth. This assertion documents that the client cannot detect it.
      await page.getByRole('link', { name: 'Vault', exact: true }).click();
      await page.getByRole('button', { name: 'Lock vault' }).click();
      await page.getByRole('button', { name: 'Sign out' }).click();
      await clearOriginState(page);
      await page.goto(`${suite.app.origin}/vault`);
      await page.getByRole('button', { name: 'Recover vault' }).click();
      expect(await waitForTestId(page, 'vault-status', /Saved|Unlocked/, 30_000)).toBe(true);
      expect(readdirSync(suite.services.s3.root).length).toBeGreaterThan(0);
    },
  );
});
