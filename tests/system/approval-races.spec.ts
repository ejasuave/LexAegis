import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import { createPublicClient, http, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeExecuteCalldata, encodeInvalidateNonceCalldata } from '@lexaegis/sdk/transactions';
import { chainDefinition, fund } from './harness/chain';
import {
  addMatterAndDocument,
  confirmFactsAndCheck,
  createAccountAndVault,
  decideRecordAndFreeze,
} from './harness/flows';
import { Client } from './harness/http';
import { forgedApprovalViolations } from './harness/oracles';
import { isBlocked } from './harness/services';
import { startSuite, type Suite } from './harness/suite';

/*
 * SYSTEM EVIDENCE (browser_scripted and local_integration). Approval and transaction boundaries on the
 * production build with a real registry on a loopback Anvil: the server's parsed-transaction identity
 * checks against forged raw transactions, and approval/Send races driven through rendered controls with
 * a controlled clock. An action signature becomes executable when disclosed; Stop, lock, closing a
 * dialog and quote expiry cannot retract it. A controller-scoped EOA key is not hardware-isolated: these
 * tests establish application behaviour, not protection against compromised same-origin JavaScript.
 */

const CASES = [
  'approval-server-rejects-forged-transactions',
  'approval-ticket-and-state-races',
  'approval-send-confirmation-and-quote-races',
] as const;

let suite: Suite | undefined;
beforeAll(async () => {
  const started = await startSuite({ name: 'approvals', cases: CASES, localChain: true });
  if (!isBlocked(started)) suite = started;
}, 900_000);
afterAll(async () => {
  await suite?.stop();
});

const run = (name: string, fn: (suite: Suite) => Promise<void>) =>
  it(name, async (context) => {
    if (suite === undefined) context.skip();
    else await fn(suite);
  });

const publicClient = (s: Suite) =>
  createPublicClient({
    chain: chainDefinition(10143),
    transport: http(s.chain?.local.rpcUrl ?? ''),
  });

describe('[approval-server-rejects-forged-transactions] the server parses the outer transaction itself', () => {
  run(
    'rejects a different destination, calldata, value, creation, type, chain, sender, fee cap, gas or nonce, and broadcasts none of them',
    async (s) => {
      const client = new Client({ baseUrl: s.app.baseUrl, origin: s.app.origin });
      const stranger = new Client({ baseUrl: s.app.baseUrl, origin: s.app.origin });
      await client.signIn();
      if (s.chain === null || s.registry === null) throw new Error('chain');
      await fund(s.chain, client.address, 10n * 10n ** 18n);
      const registry = s.registry.address;
      const request = { kind: 'invalidate_nonce', expectedNonce: '0' };
      const created = await client.postJson('/api/chain/operations', {
        idempotencyKey: `k${randomUUID().replaceAll('-', '')}`,
        request,
      });
      expect(created.status, created.text).toBe(200);
      const operationId = (created.json() as { operation: { operationId: string } }).operation
        .operationId;
      const quoted = await client.postJson(`/api/chain/operations/${operationId}/quote`, {
        request,
        signature: null,
      });
      expect(quoted.status, quoted.text).toBe(200);
      const quote = (quoted.json() as { quote: Record<string, string> }).quote;
      const calldata = encodeInvalidateNonceCalldata('0') as Hex;
      const base = {
        type: 'eip1559' as const,
        chainId: 10143,
        to: registry,
        data: calldata,
        value: 0n,
        gas: BigInt(quote.gasLimit ?? '0'),
        maxFeePerGas: BigInt(quote.maxFeePerGas ?? '0'),
        maxPriorityFeePerGas: BigInt(quote.maxPriorityFeePerGas ?? '0'),
        nonce: Number(quote.transactionNonce),
      };
      const sign = (patch: object, account = client.account) =>
        account.signTransaction({ ...base, ...patch } as never);
      const executeCalldata = encodeExecuteCalldata(
        {
          reviewer: client.address,
          action: 0,
          commitment: `0x${'11'.repeat(32)}`,
          replacementCommitment: `0x${'00'.repeat(32)}`,
          nonce: '0',
          deadline: '4102444800',
        },
        `0x${'22'.repeat(65)}`,
      ) as Hex;
      const variants: [string, Promise<string> | string, string][] = [
        ['a different destination', sign({ to: `0x${'99'.repeat(20)}` }), 'TRANSACTION_REJECTED'],
        ['trailing calldata', sign({ data: `${calldata}00` }), 'TRANSACTION_REJECTED'],
        ['a non-zero value', sign({ value: 1n }), 'TRANSACTION_REJECTED'],
        ['contract creation', sign({ to: undefined }), 'TRANSACTION_REJECTED'],
        [
          'a legacy transaction',
          client.account.signTransaction({
            type: 'legacy',
            chainId: 10143,
            to: registry,
            data: calldata,
            gas: base.gas,
            gasPrice: base.maxFeePerGas,
            nonce: base.nonce,
          }),
          'TRANSACTION_REJECTED',
        ],
        ['a delegation (EIP-7702) type', '0x04c0', 'TRANSACTION_REJECTED'],
        [
          'an access list',
          sign({ accessList: [{ address: registry, storageKeys: [] }] }),
          'TRANSACTION_REJECTED',
        ],
        ['another chain ID', sign({ chainId: 31337 }), 'TRANSACTION_REJECTED'],
        ['another sender', sign({}, stranger.account), 'SENDER_MISMATCH'],
        [
          'a higher fee cap than quoted',
          sign({ maxFeePerGas: base.maxFeePerGas * 2n }),
          'FIELDS_MISMATCH',
        ],
        ['a different gas limit', sign({ gas: base.gas + 1n }), 'FIELDS_MISMATCH'],
        ['a different account nonce', sign({ nonce: base.nonce + 1 }), 'FIELDS_MISMATCH'],
        [
          'a different invalidation argument',
          sign({ data: encodeInvalidateNonceCalldata('5') as Hex }),
          'FIELDS_MISMATCH',
        ],
        [
          'an execute call for an invalidation operation',
          sign({ data: executeCalldata }),
          'FIELDS_MISMATCH',
        ],
      ];
      const countBefore = await publicClient(s).getTransactionCount({
        address: client.address as Hex,
      });
      for (const [name, rawPromise, reason] of variants) {
        const raw = await rawPromise;
        const reply = await client.postJson(`/api/chain/operations/${operationId}/submit`, {
          request,
          quote,
          signedTransaction: raw,
        });
        expect(reply.status, name).toBeGreaterThanOrEqual(400);
        expect((reply.json() as { reason?: string }).reason, name).toBe(reason);
      }
      // Nothing was broadcast: the account's transaction count did not move and the operation is still quoted.
      expect(await publicClient(s).getTransactionCount({ address: client.address as Hex })).toBe(
        countBefore,
      );
      const phase = await s.services.pool.query<{ phase: string }>(
        'select phase from chain_operations where id = $1',
        [operationId],
      );
      expect(phase.rows[0]?.phase).toBe('quoted');

      // A client-supplied "approved" flag, ticket or signature field is not an approval: the closed
      // request schema refuses it, whatever else the body holds, and nothing advances or broadcasts.
      // The same oracle is shown to fire on a faulted observation (negative-controls).
      const flagged = await client.postJson(`/api/chain/operations/${operationId}/submit`, {
        request,
        quote,
        signedTransaction: await sign({}),
        approved: true,
        approvalTicket: 'forged',
      });
      const phaseAfterFlag = await s.services.pool.query<{ phase: string }>(
        'select phase from chain_operations where id = $1',
        [operationId],
      );
      expect(
        forgedApprovalViolations({
          status: flagged.status,
          phaseBefore: 'quoted',
          phaseAfter: phaseAfterFlag.rows[0]?.phase ?? '',
          transactionCountBefore: countBefore,
          transactionCountAfter: await publicClient(s).getTransactionCount({
            address: client.address as Hex,
          }),
        }),
      ).toEqual([]);

      // The exact transaction is accepted; an exact retry is the same transaction, never a second one.
      const good = await sign({});
      const first = await client.postJson(`/api/chain/operations/${operationId}/submit`, {
        request,
        quote,
        signedTransaction: good,
      });
      expect(first.status, first.text).toBe(200);
      const hash = (first.json() as { transactionHash: string }).transactionHash;
      const again = await client.postJson(`/api/chain/operations/${operationId}/submit`, {
        request,
        quote,
        signedTransaction: good,
      });
      expect(again.status, again.text).toBe(200);
      expect((again.json() as { transactionHash: string }).transactionHash).toBe(hash);
      expect(await publicClient(s).getTransactionCount({ address: client.address as Hex })).toBe(
        countBefore + 1,
      );
      // A different valid transaction under the same operation after one began is a hash conflict.
      const other = await sign({ maxPriorityFeePerGas: base.maxPriorityFeePerGas });
      expect(other).toBe(good); // same fields give the same bytes; a changed field is refused below
      const changed = await sign({ gas: base.gas + 1n });
      const refused = await client.postJson(`/api/chain/operations/${operationId}/submit`, {
        request,
        quote,
        signedTransaction: changed,
      });
      expect(refused.status).toBeGreaterThanOrEqual(400);
    },
  );
});

describe('[approval-ticket-and-state-races] approval tickets and live state', () => {
  run(
    'one explicit approval consumes one ticket; cancelling, a changed nonce, an unreadable network and duplicate clicks never sign twice',
    async (s) => {
      const { page } = await s.newSession();
      const account = await createAccountAndVault(page, s.app.origin);
      if (s.chain === null) throw new Error('chain');
      await fund(s.chain, account.address, 10n * 10n ** 18n);
      await addMatterAndDocument(page, 'SYSTEM-approval-race');
      await confirmFactsAndCheck(page);
      await decideRecordAndFreeze(page, 'Approval race check.');
      const signed = () => page.getByTestId('approval-signed').count();
      const preview = async () => {
        await page.getByTestId('preview-approval').click();
        await page.getByTestId('approval-details').waitFor({ timeout: 30_000 });
      };
      const operationRows = async () =>
        (
          await s.services.pool.query<{ n: number }>(
            'select count(*)::int n from chain_operations where owner = $1',
            [account.address.toLowerCase()],
          )
        ).rows[0]?.n;

      // Cancelling a preview discards its ticket: nothing is signed and the details are gone.
      await preview();
      await page.getByRole('button', { name: 'Cancel preview' }).click();
      await expect
        .poll(() => page.getByTestId('approval-details').count(), { timeout: 10_000 })
        .toBe(0);
      expect(await signed()).toBe(0);

      // The registry nonce changes between preview and approval (the live reading is patched in flight).
      let nonce: string | null = null;
      let unreadable = false;
      await page.route('**/api/chain/state/**', async (route) => {
        if (unreadable) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, status: 'unknown', reason: 'rpc_failed' }),
          });
          return;
        }
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        if (nonce !== null) body.registryNonce = nonce;
        await route.fulfill({ response, json: body });
      });
      await preview();
      nonce = '7';
      await page.getByTestId('approve-package').click();
      expect(
        await has(
          page,
          'The network state changed, so the preview was discarded. Nothing was signed.',
        ),
      ).toBe(true);
      expect(await signed()).toBe(0);
      nonce = null;

      // An unreadable network is "unknown", never "unchanged": nothing is signed.
      await preview();
      unreadable = true;
      await page.getByTestId('approve-package').click();
      expect(
        await has(
          page,
          'The network state could not be read. That is not the same as “not published”.',
        ),
      ).toBe(true);
      expect(await signed()).toBe(0);
      unreadable = false;
      expect(await operationRows()).toBe(0);

      // A real preview and a double click: one signing, one transaction stage, one operation.
      await preview();
      await page.getByTestId('approve-package').dblclick();
      await page.getByTestId('send-transaction').waitFor({ timeout: 60_000 });
      expect(await signed()).toBe(1);
      await expect.poll(operationRows, { timeout: 10_000 }).toBe(1);
      expect(await page.getByTestId('tx-stage').innerText()).toMatch(/./);
      await page.unroute('**/api/chain/state/**');
    },
  );
});

const has = (page: Page, text: string, timeout = 15_000): Promise<boolean> =>
  page
    .getByText(text)
    .first()
    .waitFor({ timeout })
    .then(
      () => true,
      () => false,
    );

describe('[approval-send-confirmation-and-quote-races] the fee confirmation is its own step', () => {
  run(
    'an expired quote is renewed without re-signing and needs a new confirmation; a duplicate Send is one transaction',
    async (s) => {
      const { page } = await s.newSession();
      const account = await createAccountAndVault(page, s.app.origin);
      if (s.chain === null) throw new Error('chain');
      await fund(s.chain, account.address, 10n * 10n ** 18n);
      await addMatterAndDocument(page, 'SYSTEM-send-race');
      await confirmFactsAndCheck(page);
      await decideRecordAndFreeze(page, 'Send race check.');
      let submitCount = 0;
      let signCalls = 0;
      page.on('request', (request) => {
        if (/\/api\/chain\/operations\/[^/]+\/submit$/.test(request.url())) submitCount += 1;
        if (/\/api\/chain\/operations\/[^/]+\/quote$/.test(request.url())) signCalls += 1;
      });
      await page.getByTestId('preview-approval').click();
      await page.getByTestId('approval-details').waitFor({ timeout: 30_000 });
      await page.getByTestId('approve-package').click();
      await page.getByTestId('send-transaction').waitFor({ timeout: 30_000 });
      expect(signCalls).toBeGreaterThanOrEqual(1);

      // A quote lives 30 seconds. After it, Send is replaced by a renewal and nothing was sent.
      const quotesBefore = signCalls;
      await page.getByRole('button', { name: 'Renew quote' }).waitFor({ timeout: 45_000 });
      expect(await page.getByTestId('send-transaction').count()).toBe(0);
      expect(await page.getByText('This quote expired.').count()).toBeGreaterThan(0);
      expect(submitCount).toBe(0);
      await page.getByRole('button', { name: 'Renew quote' }).click();
      await page
        .getByTestId('send-transaction')
        .waitFor({ timeout: 30_000 })
        .catch(async (error: unknown) => {
          const rows = await s.services.pool.query(
            'select kind, phase, quote_hash is not null as quoted, transaction_hash from chain_operations',
          );
          throw new Error(
            `${String(error)}\n${await page.getByTestId('transaction-panel').innerText()}\n${JSON.stringify(rows.rows)}`,
          );
        });
      // Renewal re-quotes; it does not ask for or repeat the action signature, and does not send.
      expect(signCalls).toBe(quotesBefore + 1);
      expect(await page.getByTestId('approval-signed').count()).toBe(1);
      expect(submitCount).toBe(0);

      // A duplicate click is one broadcast and one transaction.
      await page.getByTestId('send-transaction').dblclick();
      await expect.poll(() => submitCount, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      await page.waitForTimeout(1_500);
      expect(submitCount).toBe(1);
      const sent = await s.services.pool.query<{ n: number }>(
        'select count(*)::int n from chain_operations where owner = $1 and transaction_hash is not null',
        [account.address.toLowerCase()],
      );
      expect(sent.rows[0]?.n).toBe(1);
    },
  );
});
