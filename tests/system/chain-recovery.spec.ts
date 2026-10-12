import { randomUUID } from 'node:crypto';
import { createPublicClient, http, keccak256, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeInvalidateNonceCalldata } from '@lexaegis/sdk/transactions';
import { chainDefinition, fund } from './harness/chain';
import { Client } from './harness/http';
import { isBlocked, startWebApp } from './harness/services';
import { waitUntil } from './harness/poll';
import { startSuite, type Suite } from './harness/suite';

/*
 * SYSTEM EVIDENCE (local_integration). The transaction pipeline on the production build against a
 * loopback Anvil with the real registry, behind a fault-injecting JSON-RPC proxy. The proxy models
 * transport behaviour only (a lost response after the node accepted a send, an outage, a rewritten
 * answer). It is not evidence of Alchemy, Monad timing, Monad gas charging or Monad execution delay.
 * Operations here are explicit nonce invalidations: the same outer-transaction pipeline as ISSUE,
 * REVOKE and SUPERSEDE, which the SDK/registry integration suites exercise separately.
 */

const CASES = [
  'chain-lost-response-and-restart-recovery',
  'chain-outage-and-inconsistent-observations',
] as const;

let suite: Suite | undefined;
beforeAll(async () => {
  const started = await startSuite({
    name: 'chain-recovery',
    cases: CASES,
    evidenceClass: 'local_integration',
    localChain: true,
    faultProxy: true,
  });
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

interface Prepared {
  readonly client: Client;
  readonly operationId: string;
  readonly request: { kind: 'invalidate_nonce'; expectedNonce: string };
  readonly quote: Record<string, string>;
  readonly raw: Hex;
  readonly hash: Hex;
}

/** A funded account with one quoted invalidation and its locally signed outer transaction. */
async function prepare(
  s: Suite,
  app: { baseUrl: string; origin: string } = s.app,
): Promise<Prepared> {
  if (s.chain === null || s.registry === null) throw new Error('chain');
  const client = new Client(app);
  expect((await client.signIn()).status).toBe(200);
  await fund(s.chain, client.address, 10n * 10n ** 18n);
  const request = { kind: 'invalidate_nonce' as const, expectedNonce: '0' };
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
  const raw = await client.account.signTransaction({
    type: 'eip1559',
    chainId: 10143,
    to: s.registry.address,
    data: encodeInvalidateNonceCalldata('0') as Hex,
    value: 0n,
    gas: BigInt(quote.gasLimit ?? '0'),
    maxFeePerGas: BigInt(quote.maxFeePerGas ?? '0'),
    maxPriorityFeePerGas: BigInt(quote.maxPriorityFeePerGas ?? '0'),
    nonce: Number(quote.transactionNonce),
  });
  return { client, operationId, request, quote, raw, hash: keccak256(raw) };
}

const submit = (p: Prepared, via: Client = p.client, raw: Hex = p.raw) =>
  via.postJson(`/api/chain/operations/${p.operationId}/submit`, {
    request: p.request,
    quote: p.quote,
    signedTransaction: raw,
  });
const refresh = (p: Prepared, via: Client = p.client) =>
  via.postJson(`/api/chain/operations/${p.operationId}`, { request: p.request });
const rowOf = async (s: Suite, id: string) =>
  (
    await s.services.pool.query<{
      phase: string;
      transaction_hash: string | null;
      transaction_nonce: string | null;
    }>('select phase, transaction_hash, transaction_nonce from chain_operations where id = $1', [
      id,
    ])
  ).rows[0];

/** Refreshes until the operation reaches `phase` (blocks are mined in the background). */
async function until(p: Prepared, phase: string): Promise<Record<string, unknown>> {
  return waitUntil(
    `operation ${phase}`,
    async () => {
      const body = (await refresh(p)).json() as {
        operation?: { phase: string };
        observation?: Record<string, unknown>;
      };
      return body.operation?.phase === phase ? (body.observation ?? {}) : null;
    },
    { timeoutMs: 60_000, intervalMs: 1_000 },
  );
}

describe('[chain-lost-response-and-restart-recovery] public identity first; exact bytes; no automatic re-signing', () => {
  run(
    'the hash and nonce are durable before the node sees bytes; a lost response is recovered from chain state and the exact retry is the same transaction',
    async (s) => {
      const proxy = s.proxy;
      if (proxy === null) throw new Error('proxy');
      proxy.clear();
      const p = await prepare(s);
      const sendsBefore = proxy.count('eth_sendRawTransaction');
      // The node accepts the transaction and the response is lost.
      proxy.add({ method: 'eth_sendRawTransaction', mode: 'lose_response', times: 1 });
      const first = await submit(p);
      expect(first.status).toBeGreaterThanOrEqual(400);
      expect((first.json() as { reason?: string }).reason).toBe('SUBMISSION_UNKNOWN');
      const row = await rowOf(s, p.operationId);
      // The public identity was recorded before the send, and the outcome is unknown, not failed.
      expect(row?.transaction_hash).toBe(p.hash.toLowerCase());
      expect(row?.transaction_nonce).toBe(p.quote.transactionNonce);
      expect(row?.phase).toBe('unknown');
      expect(proxy.count('eth_sendRawTransaction') - sendsBefore).toBe(1);

      // A different set of bytes for the same operation is refused: the identity is already fixed.
      const other = await p.client.account.signTransaction({
        type: 'eip1559',
        chainId: 10143,
        to: s.registry?.address as Hex,
        data: encodeInvalidateNonceCalldata('0') as Hex,
        value: 0n,
        gas: BigInt(p.quote.gasLimit ?? '0') + 1n,
        maxFeePerGas: BigInt(p.quote.maxFeePerGas ?? '0'),
        maxPriorityFeePerGas: BigInt(p.quote.maxPriorityFeePerGas ?? '0'),
        nonce: Number(p.quote.transactionNonce),
      });
      expect((await submit(p, p.client, other)).status).toBeGreaterThanOrEqual(400);

      // Reconciliation from chain state alone finds the accepted transaction and confirms it.
      const observation = await until(p, 'confirmed');
      expect(observation.outcome).toBe('confirmed');
      expect((await rowOf(s, p.operationId))?.transaction_hash).toBe(p.hash.toLowerCase());
      // The exact retry is idempotent: nothing is sent again and no second transaction exists.
      const retry = await submit(p);
      expect(retry.status, retry.text).toBe(200);
      expect((retry.json() as { transactionHash: string }).transactionHash).toBe(p.hash);
      expect(proxy.count('eth_sendRawTransaction') - sendsBefore).toBe(1);
      expect(await publicClient(s).getTransactionCount({ address: p.client.address as Hex })).toBe(
        1,
      );
    },
  );

  run(
    'bytes lost before the node saw them leave an unknown outcome: no re-signing, no fee bump, no new operation, no funding; the same bytes complete it later',
    async (s) => {
      const proxy = s.proxy;
      if (proxy === null) throw new Error('proxy');
      proxy.clear();
      const p = await prepare(s);
      const grantsBefore = (await s.services.pool.query('select 1 from funding_grants')).rowCount;
      proxy.add({ method: 'eth_sendRawTransaction', mode: 'fail', times: 1 });
      const lost = await submit(p);
      expect(lost.status).toBeGreaterThanOrEqual(400);
      expect((await rowOf(s, p.operationId))?.phase).toBe('unknown');
      expect((await rowOf(s, p.operationId))?.transaction_hash).toBe(p.hash.toLowerCase());
      // The chain never saw it.
      expect(await publicClient(s).getTransactionCount({ address: p.client.address as Hex })).toBe(
        0,
      );

      // The server holds no key and cannot re-sign: a refresh only observes. Nothing was sent again.
      const sends = proxy.count('eth_sendRawTransaction');
      expect((await refresh(p)).status).toBe(200);
      expect(proxy.count('eth_sendRawTransaction')).toBe(sends);
      // A different operation cannot be started while this one is unresolved (no new commitment path).
      const second = await p.client.postJson('/api/chain/operations', {
        idempotencyKey: `k${randomUUID().replaceAll('-', '')}`,
        request: p.request,
      });
      expect(second.status).toBeGreaterThanOrEqual(400);
      expect((second.json() as { reason?: string }).reason).toBe('ACCOUNT_BUSY');
      // No funding was triggered by an unknown outcome.
      expect((await s.services.pool.query('select 1 from funding_grants')).rowCount).toBe(
        grantsBefore,
      );
      expect(
        (
          await s.services.pool.query('select 1 from chain_operations where owner = $1', [
            p.client.address,
          ])
        ).rowCount,
      ).toBe(1);

      // The exact same bytes, retried, complete the operation; the hash never changed.
      const retry = await submit(p);
      expect(retry.status, retry.text).toBe(200);
      expect((retry.json() as { transactionHash: string }).transactionHash).toBe(p.hash);
      await until(p, 'confirmed');
      expect(await publicClient(s).getTransactionCount({ address: p.client.address as Hex })).toBe(
        1,
      );
    },
  );

  run(
    'after a server restart a second process reads the same durable operation and reconciles it, without a key or a browser cache',
    async (s) => {
      const proxy = s.proxy;
      if (proxy === null) throw new Error('proxy');
      proxy.clear();
      const p = await prepare(s);
      proxy.add({ method: 'eth_sendRawTransaction', mode: 'lose_response', times: 1 });
      expect((await submit(p)).status).toBeGreaterThanOrEqual(400);
      // A fresh process from the same build: no memory, only the database and the chain.
      const restarted = await startWebApp({
        name: 'chain-recovery-restart',
        env: s.appEnv,
        sameBuildAs: s.app,
      });
      if (isBlocked(restarted)) throw new Error('restart did not start');
      try {
        const other = new Client(
          { baseUrl: restarted.baseUrl, origin: restarted.origin },
          undefined,
        );
        // Same account, new process: sign in again (sessions are per-process cookies here).
        Object.assign(other, { account: p.client.account });
        expect((await other.signIn()).status).toBe(200);
        const stored = await other.send(`/api/chain/operations/${p.operationId}`);
        expect(stored.status, stored.text).toBe(200);
        expect(
          (stored.json() as { operation: { transactionHash: string | null } }).operation
            .transactionHash,
        ).toBe(p.hash.toLowerCase());
        const done = await waitUntil(
          'restarted process confirms',
          async () => {
            const body = (await refresh(p, other)).json() as { operation?: { phase: string } };
            return body.operation?.phase === 'confirmed' ? true : null;
          },
          { timeoutMs: 60_000, intervalMs: 1_000 },
        );
        expect(done).toBe(true);
      } finally {
        await restarted.stop();
      }
    },
  );
});

describe('[chain-outage-and-inconsistent-observations] an unreadable or contradictory chain is never success or not_found', () => {
  run(
    'an RPC outage during monitoring is unknown, never failed, not-found or confirmed, and a confirmed record is not downgraded by a later outage',
    async (s) => {
      const proxy = s.proxy;
      if (proxy === null) throw new Error('proxy');
      proxy.clear();
      const p = await prepare(s);
      expect((await submit(p)).status).toBe(200);

      // Outage while the transaction is being watched.
      proxy.add({ method: 'eth_getTransactionReceipt', mode: 'fail' });
      proxy.add({ method: 'eth_getTransactionByHash', mode: 'fail' });
      const during = (await refresh(p)).json() as {
        operation: { phase: string };
        observation: { outcome: string };
      };
      expect(during.observation.outcome).toBe('unknown');
      expect(['submitted', 'unknown']).toContain(during.operation.phase);
      expect(during.operation.phase).not.toMatch(/cancelled|reverted|confirmed|not_found/);
      // The public state route reports unknown, never not_found, while reads fail.
      proxy.add({ method: 'eth_call', mode: 'fail' });
      const state = await new Client(s.app).send(
        `/api/chain/state/${p.client.address}/0x${'ab'.repeat(32)}`,
      );
      expect(state.status).toBe(200);
      expect((state.json() as { status: string }).status).toBe('unknown');
      expect(state.text).not.toMatch(/not_found/);
      proxy.clear();

      await until(p, 'confirmed');
      // A later outage cannot undo, or silently relabel, an established confirmation.
      proxy.add({ method: 'eth_getTransactionReceipt', mode: 'fail' });
      proxy.add({ method: 'eth_getTransactionByHash', mode: 'fail' });
      const after = (await refresh(p)).json() as { operation: { phase: string } };
      const stored = await rowOf(s, p.operationId);
      expect(['confirmed', 'unknown']).toContain(after.operation.phase);
      expect(stored?.transaction_hash).toBe(p.hash.toLowerCase());
      proxy.clear();
    },
  );

  run(
    'a changed block hash after confirmation is a contradiction and is not re-confirmed on the new hash',
    async (s) => {
      const proxy = s.proxy;
      if (proxy === null) throw new Error('proxy');
      proxy.clear();
      const p = await prepare(s);
      expect((await submit(p)).status).toBe(200);
      await until(p, 'confirmed');
      const before = (
        await s.services.pool.query<{ block_hash: string | null }>(
          'select block_hash from chain_operations where id = $1',
          [p.operationId],
        )
      ).rows[0]?.block_hash;
      expect(before).toMatch(/^0x[0-9a-f]{64}$/);
      // The same receipt now claims another canonical block hash.
      const forged = `0x${'de'.repeat(32)}`;
      proxy.add({
        method: 'eth_getTransactionReceipt',
        mode: 'rewrite',
        rewrite: (result) =>
          result !== null && typeof result === 'object' ? { ...result, blockHash: forged } : result,
      });
      proxy.add({
        method: 'eth_getBlockByNumber',
        mode: 'rewrite',
        rewrite: (result) =>
          result !== null && typeof result === 'object' ? { ...result, hash: forged } : result,
      });
      const reply = (await refresh(p)).json() as {
        operation: { phase: string };
        observation: { outcome: string; mismatch: unknown };
      };
      const stored = (
        await s.services.pool.query<{ block_hash: string | null }>(
          'select block_hash from chain_operations where id = $1',
          [p.operationId],
        )
      ).rows[0]?.block_hash;
      // Whatever the label, the forged hash must not have replaced the recorded canonical block.
      expect(stored).toBe(before);
      // The disagreement is reported as a contradiction, not as a second confirmation, and the stored
      // confirmation neither moves nor disappears.
      expect(reply.observation.mismatch).toBe('CONTRADICTS_CONFIRMED');
      expect(reply.observation.outcome).not.toBe('confirmed');
      expect(reply.operation.phase).toBe('confirmed');
      proxy.clear();
    },
  );

  run('a node reporting another chain ID is not trusted: reads become unknown', async (s) => {
    const proxy = s.proxy;
    if (proxy === null) throw new Error('proxy');
    proxy.clear();
    proxy.add({ method: 'eth_chainId', mode: 'rewrite', rewrite: () => '0x1' });
    const status = await new Client(s.app).send('/api/chain/status');
    const state = await new Client(s.app).send(
      `/api/chain/state/0x${'12'.repeat(20)}/0x${'ab'.repeat(32)}`,
    );
    proxy.clear();
    expect(status.status).toBeLessThan(500);
    expect(`${status.text}${state.text}`).not.toMatch(/not_found|"confirmed"|"active"/i);
  });
});
