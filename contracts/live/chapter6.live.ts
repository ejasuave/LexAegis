import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { createPublicClient, formatEther, http, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PreparedReviewPackage } from '@lexaegis/protocol/v1';
import {
  buildIssueAction,
  buildRevokeAction,
  buildSupersedeAction,
  defaultActionDeadline,
  proofOfReviewRegistryAbi as abi,
  readLiveReceipt,
  type BoundReviewAction,
} from '@lexaegis/sdk/registry';
import { succeed } from '../../apps/web/src/features/account/errors';
import type { SignedReviewAction } from '../../apps/web/src/features/account/review-signing';
import { CONFIG } from '../../apps/web/src/test-support/account-harness';
import { createVaultHarness } from '../../apps/web/src/test-support/vault-harness';
import {
  createChainClient,
  probeCapabilities,
  type ServerChainClient,
} from '../../apps/web/src/server/chain/alchemy-client';
import { resolveDeployment, resolveSettings } from '../../apps/web/src/server/chain/config';
import { migrate } from '../../apps/web/src/server/db/migrate';
import { loadServerConfig } from '../../apps/web/src/server/env';
import {
  createPostgresChainStore,
  type ChainStore,
} from '../../apps/web/src/server/chain/operation-store';
import {
  createOperation,
  quoteOperation,
  reconcileOperation,
  submitOperation,
  type OperationDeps,
} from '../../apps/web/src/server/chain/operations';
import { requestTestnetFunding } from '../../apps/web/src/server/chain/testnet-funding';
import { startLocalPostgres, type LocalPostgres } from '../../test-support/embedded-pg';
import { expectOk, prepareLocalPackage } from '../integration/harness';

/*
 * LIVE EVIDENCE with scripted parts, stated plainly: the network, Alchemy endpoint, registry,
 * funding and transactions are real; the passkey is NOT. The authenticator is a scripted WebAuthn
 * double driving the real Mera functions, so step 1 is not a user-controlled credential and not
 * real-device evidence. Packages are synthetic. This is not a completed legal review.
 */

const loaded = loadServerConfig(process.env);
if (!loaded.ok) throw new Error('invalid server configuration');
const config = loaded.config;
const deployment = resolveDeployment();
if (deployment.state !== 'ready') throw new Error(`deployment is ${deployment.state}`);
const { policy } = deployment;

const timings: Record<string, number> = {};
const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  steps: {},
};
const mark = (name: string, since: number) => {
  timings[name] = Date.now() - since;
};
const step = (name: string, value: unknown) => {
  (evidence.steps as Record<string, unknown>)[name] = value;
};

let postgres: LocalPostgres;
let pool: Pool;
let store: ChainStore;
let client: ServerChainClient;
let deps: OperationDeps;
let h: ReturnType<typeof createVaultHarness>;
let reviewer: string;
let matterId: string;
const now = () => new Date();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = () => expectOk(defaultActionDeadline(String(Math.floor(Date.now() / 1000))));
const syncClock = () => {
  h.clock.now = Date.now();
};
let keyCounter = 0;
const nextKey = () => `live-run-key-${Date.now()}-${++keyCounter}`.slice(0, 64);

beforeAll(async () => {
  if (process.env.LEXAEGIS_LIVE !== '1') throw new Error('set LEXAEGIS_LIVE=1');
  const url = config.alchemy.rpcUrl;
  if (url === undefined) throw new Error('no RPC URL');
  const built = createChainClient({ rpcUrl: url, chainId: 10143 });
  if (built === null) throw new Error('endpoint refused');
  client = built;
  postgres = await startLocalPostgres();
  pool = new Pool({ connectionString: postgres.url, max: 5 });
  pool.on('error', () => undefined);
  await migrate(pool);
  store = createPostgresChainStore(pool);
  deps = {
    client,
    policy,
    store,
    now,
    randomId: () => crypto.randomUUID(),
    registryMaxFeeWei: resolveSettings(config).registryMaxFeeWei,
  };
}, 180_000);

afterAll(async () => {
  evidence.timingsMs = timings;
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(
    process.env.LIVE_EVIDENCE_PATH ?? 'live-evidence.json',
    JSON.stringify(evidence, null, 2),
  );
  await pool.end();
  await postgres.stop();
});

describe('live Monad testnet run', () => {
  it('0. the actual endpoint: chain, genesis, code and real capability results', async () => {
    const genesis = await client.public.getBlock({ blockNumber: 0n });
    expect(String(await client.public.getChainId())).toBe('10143');
    expect(deployment.genesisHash).toBe(genesis.hash);
    const capabilities = await probeCapabilities(client, policy.registryAddress as Hex);
    const checkpoint = await readLiveReceipt(
      client.live,
      policy,
      {
        reference: {
          schema: 'lexaegis.receipt-ref.v1',
          chainId: '10143',
          registryAddress: policy.registryAddress,
          reviewerAddress: `0x${'11'.repeat(20)}`,
          commitment: `0x${'22'.repeat(32)}`,
        } as never,
      },
      now,
    );
    step('0-capabilities', {
      capabilities,
      notFoundRead:
        checkpoint.status === 'ok'
          ? {
              lifecycle: checkpoint.data.receipt.receiptLifecycle,
              checkpoint: checkpoint.data.checkpoint,
            }
          : checkpoint,
    });
    expect(capabilities).toMatchObject({
      chainId: true,
      blockReads: true,
      finalizedTag: true,
      getCode: true,
      feeEstimation: true,
    });
    expect(checkpoint.status).toBe('ok');
  });

  it('1. create an account (scripted authenticator) and sign in', async () => {
    const started = Date.now();
    h = createVaultHarness({
      reviewGate: () => succeed(null),
      config: { ...CONFIG, chainId: '10143', registryAddress: policy.registryAddress },
    });
    syncClock();
    const created = await h.controller.createAndSignIn();
    expect(created.ok).toBe(true);
    reviewer = h.controller.getSnapshot().account?.address ?? '';
    mark('accountReady', started);
    step('1-account', { address: reviewer, authenticator: 'scripted (not a real device)' });
    const vault = await h.vault.refreshDiscovery();
    expect(vault.ok).toBe(true);
    expect((await h.vault.createVault()).ok).toBe(true);
    const matter = await h.vault.createMatter('synthetic live-run matter');
    if (!matter.ok) throw new Error('matter');
    matterId = matter.data;
  });

  it('2. one bounded test-MON grant arrives and is usable', async () => {
    const started = Date.now();
    const funder = privateKeyToAccount(config.funding.testnetFunderPrivateKey as Hex);
    const result = await requestTestnetFunding(
      {
        client,
        policy,
        store,
        settings: resolveSettings(config),
        funder,
        now,
        randomId: () => crypto.randomUUID(),
        pollAttempts: 60,
      },
      reviewer,
    );
    mark('fundsUsable', started);
    const balance = await client.public.getBalance({ address: reviewer as Hex });
    step('2-funding', { result, balanceMon: formatEther(balance) });
    expect(result).toMatchObject({ status: 'confirmed' });
    expect(balance).toBeGreaterThanOrEqual(parseEther('0.2'));
  });

  let prepared: PreparedReviewPackage;
  it('3. bind a synthetic package to the actual registry, keep the encrypted opening, verify read-back', async () => {
    prepared = await prepareLocalPackage(
      'legal',
      { chainId: '10143', registryAddress: policy.registryAddress, reviewerAddress: reviewer },
      null,
    );
    const saved = await h.vault.saveFrozenReview(matterId, prepared);
    expect(saved.ok).toBe(true);
    const verified = await h.vault.verifyStoredCapture(matterId, prepared.reference.commitment);
    expect(verified.ok).toBe(true);
    expect(h.vault.recoverableCapture(prepared.reference.commitment)).not.toBeNull();
    step('3-package', {
      commitment: prepared.reference.commitment,
      savedAndChecked: true,
      vault: 'in-memory server (scripted)',
    });
  });

  async function execute(label: string, bound: BoundReviewAction, pkg: PreparedReviewPackage) {
    syncClock();
    const request = { kind: 'execute' as const, action: bound, packageReference: pkg.reference };
    const t0 = Date.now();
    // Stage one: the explicit action confirmation (a live synthetic fixture stands in for the future review gate).
    const ticket = h.controller.review.preview({ action: bound, packageReference: pkg.reference });
    if (!ticket.ok) throw new Error(`preview ${ticket.code}`);
    const signed: SignedReviewAction = await (async () => {
      const result = await h.controller.review.confirm(ticket.data, {
        action: bound,
        packageReference: pkg.reference,
      });
      if (!result.ok) throw new Error(`confirm ${result.code}`);
      return result.data;
    })();
    const created = await createOperation(deps, reviewer, nextKey(), request);
    if (!created.ok) throw new Error(`create ${created.code}`);
    const id = created.data.operation.operationId;
    const quoted = await quoteOperation(deps, reviewer, id, request, signed.signature);
    if (!quoted.ok) throw new Error(`quote ${quoted.code}`);
    syncClock();
    const tx = h.controller.transactions.preview(quoted.data.quote, {
      kind: 'execute',
      authorization: signed,
    });
    if (!tx.ok) throw new Error(`tx preview ${tx.code}`);
    const raw = await h.controller.transactions.confirm(tx.data, quoted.data.quote, {
      kind: 'execute',
      authorization: signed,
    });
    if (!raw.ok) throw new Error(`tx confirm ${raw.code}`);
    const signedAt = Date.now() - t0;
    const sentAt = Date.now();
    const sent = await submitOperation(deps, reviewer, id, {
      quote: quoted.data.quote,
      request,
      signedTransaction: raw.data.raw,
    });
    if (!sent.ok) throw new Error(`submit ${sent.code}`);
    const broadcastMs = Date.now() - sentAt;
    let phase = sent.data.operation.phase;
    let included: number | null = null;
    let last: Awaited<ReturnType<typeof reconcileOperation>> | null = null;
    for (let i = 0; i < 90 && phase !== 'confirmed' && phase !== 'reverted'; i += 1) {
      await sleep(2000);
      last = await reconcileOperation(deps, reviewer, id, request);
      if (!last.ok) continue;
      phase = last.data.operation.phase;
      if (included === null && (phase === 'included' || phase === 'confirmed'))
        included = Date.now() - sentAt;
    }
    const confirmedMs = Date.now() - sentAt;
    const observation = last?.ok === true ? last.data.observation : null;
    const record = {
      label,
      operationId: id,
      transactionHash: raw.data.hash,
      phase,
      signatureMs: signedAt,
      broadcastMs,
      inclusionMs: included,
      confirmedMs,
      block: observation?.blockNumber ?? null,
      chargedFeeMon: observation?.chargedFeeWei
        ? formatEther(BigInt(observation.chargedFeeWei))
        : null,
      events: observation?.events.map((e) => e.eventKind) ?? [],
      quote: {
        gasLimit: quoted.data.quote.gasLimit,
        maxFeeMon: formatEther(BigInt(quoted.data.quote.maxFeeWei)),
      },
    };
    step(`exec-${label}`, record);
    return { id, request, record, raw: raw.data, quote: quoted.data.quote };
  }

  const registryNonce = async (): Promise<string> =>
    (
      await createPublicClient({ transport: http(config.alchemy.rpcUrl) }).readContract({
        address: policy.registryAddress as Hex,
        abi,
        functionName: 'nonceOf',
        args: [reviewer as Hex],
      })
    ).toString();

  it('4. ISSUE: explicit authorisation, fee inspection, Mera signature, Alchemy broadcast, confirmed execution', async () => {
    const bound = expectOk(buildIssueAction(prepared, await registryNonce(), deadline()));
    const run = await execute('ISSUE', bound, prepared);
    expect(run.record.phase).toBe('confirmed');
    expect(run.record.events).toEqual(['issued']);
    const live = await readLiveReceipt(
      client.live,
      policy,
      { reference: prepared.reference, opening: prepared.opening },
      now,
    );
    step(
      '4-live-status',
      live.status === 'ok'
        ? {
            lifecycle: live.data.receipt.receiptLifecycle,
            binding: live.data.binding?.binding,
            checkpoint: live.data.checkpoint,
          }
        : live,
    );
    expect(live).toMatchObject({
      status: 'ok',
      data: { receipt: { receiptLifecycle: 'active' }, binding: { binding: 'match' } },
    });
  });

  let replacement: PreparedReviewPackage;
  it('5a. replay of the executed action is rejected; SUPERSEDE then REVOKE are confirmed', async () => {
    const stale = expectOk(buildIssueAction(prepared, '0', deadline()));
    const replay = await createOperation(deps, reviewer, nextKey(), {
      kind: 'execute',
      action: stale,
      packageReference: prepared.reference,
    });
    step('5-replay', replay);
    expect(replay).toEqual({ ok: false, code: 'NONCE_MISMATCH' });

    replacement = await prepareLocalPackage(
      'legal-revised',
      { chainId: '10143', registryAddress: policy.registryAddress, reviewerAddress: reviewer },
      prepared.reference,
    );
    expect((await h.vault.saveFrozenReview(matterId, replacement)).ok).toBe(true);
    const supersede = expectOk(
      buildSupersedeAction(prepared.reference, replacement, await registryNonce(), deadline()),
    );
    const run = await execute('SUPERSEDE', supersede, replacement);
    expect(run.record.phase).toBe('confirmed');
    expect(run.record.events).toEqual(['issued', 'superseded']);
    const old = await readLiveReceipt(client.live, policy, { reference: prepared.reference }, now);
    const fresh = await readLiveReceipt(
      client.live,
      policy,
      { reference: replacement.reference },
      now,
    );
    step('5-after-supersede', {
      old: old.status === 'ok' && old.data.receipt.receiptLifecycle,
      fresh: fresh.status === 'ok' && fresh.data.receipt.receiptLifecycle,
    });
    expect(old).toMatchObject({ data: { receipt: { receiptLifecycle: 'superseded' } } });
    expect(fresh).toMatchObject({ data: { receipt: { receiptLifecycle: 'active' } } });

    const revoke = expectOk(
      buildRevokeAction(replacement.reference, await registryNonce(), deadline()),
    );
    const revoked = await execute('REVOKE', revoke, replacement);
    expect(revoked.record.phase).toBe('confirmed');
    const final = await readLiveReceipt(
      client.live,
      policy,
      { reference: replacement.reference },
      now,
    );
    step('5-after-revoke', final.status === 'ok' ? final.data.receipt.receiptLifecycle : final);
    expect(final).toMatchObject({ data: { receipt: { receiptLifecycle: 'revoked' } } });
  });

  it('6. lock and recover the same account; reconcile public state; decrypt the same saved package', async () => {
    h.controller.lock();
    h.vault.lock();
    syncClock();
    const again = await h.controller.recoverKnown();
    expect(again.ok).toBe(true);
    expect(h.controller.getSnapshot().account?.address).toBe(reviewer);
    expect((await h.vault.unlock()).ok).toBe(true);
    const verified = await h.vault.verifyStoredCapture(matterId, prepared.reference.commitment);
    expect(verified.ok).toBe(true);
    const unresolved = await store.listUnresolved(reviewer);
    const live = await readLiveReceipt(client.live, policy, { reference: prepared.reference }, now);
    step('6-recovery', {
      sameAddress: true,
      decryptedSamePackage: true,
      unresolvedOperations: unresolved.length,
      supersededStatus: live.status === 'ok' ? live.data.receipt.receiptLifecycle : live,
    });
    expect(unresolved).toHaveLength(0);
    expect(live).toMatchObject({ data: { receipt: { receiptLifecycle: 'superseded' } } });
  });
});
