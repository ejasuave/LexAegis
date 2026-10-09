import { Pool } from 'pg';
import { createWalletClient, http, keccak256, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PreparedReviewPackage } from '@lexaegis/protocol/v1';
import {
  buildIssueAction,
  buildRevokeAction,
  buildSupersedeAction,
  defaultActionDeadline,
  proofOfReviewRegistryAbi as abi,
  readChainCheckpoint,
  readLiveReceipt,
  type BoundReviewAction,
  type ChainPolicy,
} from '@lexaegis/sdk/registry';
import { succeed } from '../../apps/web/src/features/account/errors';
import type { SignedReviewAction } from '../../apps/web/src/features/account/review-signing';
import { CONFIG, Clock, createHarness } from '../../apps/web/src/test-support/account-harness';
import {
  createChainClient,
  probeCapabilities,
  type ServerChainClient,
} from '../../apps/web/src/server/chain/alchemy-client';
import { migrate } from '../../apps/web/src/server/db/migrate';
import {
  DEFAULT_GRANT_WEI,
  allowLocalAnvilChainForTests,
  type ChainSettings,
} from '../../apps/web/src/server/chain/config';
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
import {
  requestTestnetFunding,
  type FundingDeps,
} from '../../apps/web/src/server/chain/testnet-funding';
import { startLocalPostgres, type LocalPostgres } from '../../test-support/embedded-pg';
import { startAnvil, type LocalChain } from '../scripts/lib/anvil';
import { accounts, creationCode, expectOk, lower, prepareLocalPackage } from './harness';

/*
 * LOCAL COMPATIBILITY EVIDENCE ONLY. The Chapter 6 server workflow (preflight, quote, submit,
 * reconcile, funding) and the browser's two-stage signing run against a throwaway Anvil chain
 * through the test-only 31337 allowance (mainnet and public chains stay refused), with real
 * PostgreSQL and the real Mera-to-viem signer. Anvil does not establish Monad gas charging,
 * reserve-balance behaviour or Alchemy support; those need the live checks (Task 15).
 */

const TESTNET = 31337;
const FUNDER = privateKeyToAccount(`0x${'77'.repeat(32)}`);
const tester = privateKeyToAccount(`0x${'88'.repeat(32)}`);

let local: LocalChain;
let postgres: LocalPostgres;
let pool: Pool;
let store: ChainStore;
let client: ServerChainClient;
let registry: Hex;
let policy: ChainPolicy;
let deps: OperationDeps;
let h: ReturnType<typeof createHarness>;
let reviewer: string;
const clock = new Clock();

const rpc = (method: string, params: unknown[] = []) => local.transport.request(method, params);
const mine = (n = 5) => rpc('anvil_mine', [`0x${n.toString(16)}`]);
async function tick(): Promise<void> {
  await mine(1);
  clock.now = Date.now();
  h.clock.now = clock.now;
}
const now = () => new Date(Date.now());

const settings: ChainSettings = {
  fundingEnabled: true,
  grantWei: DEFAULT_GRANT_WEI,
  dailyBudgetWei: parseEther('10'),
  fundingMaxFeeWei: parseEther('0.01'),
  registryMaxFeeWei: parseEther('0.2'),
  cooldownMs: 24 * 3600_000,
};

beforeAll(async () => {
  allowLocalAnvilChainForTests(true);
  local = await startAnvil(TESTNET);
  postgres = await startLocalPostgres();
  pool = new Pool({ connectionString: postgres.url, max: 10 });
  pool.on('error', () => undefined);
  await migrate(pool);
  store = createPostgresChainStore(pool);

  const built = createChainClient({ rpcUrl: local.rpcUrl, chainId: TESTNET, allowLoopback: true });
  if (built === null) throw new Error('client');
  // Anvil's `finalized` tag never leaves genesis, so this local simulation reports the latest
  // block as finalized. This is a labelled simulation of Monad finality, not evidence of it.
  const simulateFinality = <T extends { getBlock: ServerChainClient['live']['getBlock'] }>(
    target: T,
  ): T => ({
    ...target,
    getBlock: (selector) =>
      target.getBlock('blockTag' in selector ? { blockTag: 'latest' } : selector),
  });
  client = {
    ...built,
    live: simulateFinality(built.live),
    monitor: simulateFinality(built.monitor),
  };

  const deployer = createWalletClient({
    account: accounts.deployer,
    transport: http(local.rpcUrl),
    chain: {
      id: TESTNET,
      name: 'local',
      nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
      rpcUrls: { default: { http: [local.rpcUrl] } },
    },
  });
  const hash = await deployer.deployContract({
    abi,
    bytecode: creationCode('ProofOfReviewRegistry.sol', 'ProofOfReviewRegistry'),
  });
  const receipt = await client.public.waitForTransactionReceipt({ hash });
  registry = lower(receipt.contractAddress ?? '0x') as Hex;
  const code = await client.public.getCode({ address: registry });
  policy = {
    chainId: '31337',
    registryAddress: registry,
    deploymentBlock: receipt.blockNumber.toString(),
    runtimeCodeKeccak256: keccak256(code ?? '0x'),
    executionDelayBlocks: 3,
    executionDelayRevision: 'local-test',
  };
  deps = {
    client,
    policy,
    store,
    now,
    randomId: () => crypto.randomUUID(),
    registryMaxFeeWei: settings.registryMaxFeeWei,
  };

  for (const to of [FUNDER.address, tester.address]) {
    await deployer.sendTransaction({ to, value: parseEther('50') });
  }
  clock.now = Date.now();
  h = createHarness({
    reviewGate: () => succeed(null),
    clock,
    config: { ...CONFIG, chainId: '31337', registryAddress: registry },
  });
  const created = await h.controller.createAndSignIn();
  if (!created.ok) throw new Error('account setup failed');
  reviewer = h.controller.getSnapshot().account?.address ?? '';
  await mine(8);
}, 120_000);

afterAll(async () => {
  allowLocalAnvilChainForTests(false);
  await pool.end();
  await postgres.stop();
  await local.stop();
});

const fundingDeps = (over: Partial<FundingDeps> = {}): FundingDeps => ({
  client,
  policy,
  store,
  settings,
  funder: FUNDER,
  now,
  randomId: () => crypto.randomUUID(),
  sleep: async () => {
    await mine(2);
  },
  pollAttempts: 6,
  ...over,
});

describe('chain access and capabilities', () => {
  it('records what the endpoint actually did and builds a finalized-minus-delay checkpoint', async () => {
    const report = await probeCapabilities(client, registry);
    expect(report).toMatchObject({
      chainId: true,
      blockReads: true,
      getCode: true,
      feeEstimation: true,
      transactionCount: true,
    });
    const checkpoint = await readChainCheckpoint(client.live, policy, now);
    expect(checkpoint.status).toBe('ok');
    if (checkpoint.status === 'ok') {
      expect(BigInt(checkpoint.data.finalizedHeight) - BigInt(checkpoint.data.blockNumber)).toBe(
        3n,
      );
    }
  });

  it('refuses a non-Alchemy endpoint and never uses a default public RPC', () => {
    expect(
      createChainClient({ rpcUrl: 'https://rpc.example.com/key', chainId: TESTNET }),
    ).toBeNull();
    expect(createChainClient({ rpcUrl: 'http://127.0.0.1:8545', chainId: TESTNET })).toBeNull();
  });
});

describe('bounded test-MON funding', () => {
  it('funds the authenticated account once and confirms arrival at the execution checkpoint', async () => {
    const result = await requestTestnetFunding(fundingDeps(), reviewer);
    expect(result).toMatchObject({ status: 'confirmed', amountWei: DEFAULT_GRANT_WEI.toString() });
    expect(await client.public.getBalance({ address: reviewer as Hex })).toBe(DEFAULT_GRANT_WEI);
    expect(await requestTestnetFunding(fundingDeps(), reviewer)).toMatchObject({
      status: 'already_funded',
    });
  });

  it('retries the identical outbox bytes after a crash and never pays twice', async () => {
    const victim = `0x${'0d'.repeat(20)}`;
    const failing = {
      ...client,
      sendRawTransaction: () => Promise.reject(new Error('connection reset')),
    } as ServerChainClient;
    const first = await requestTestnetFunding(
      fundingDeps({ client: failing, pollAttempts: 1 }),
      victim,
    );
    expect(first.status).toBe('pending');
    const stored = await pool.query<{
      transaction_hash: string;
      outbox_raw: string;
      phase: string;
    }>('SELECT transaction_hash, outbox_raw, phase FROM funding_grants WHERE recipient = $1', [
      victim,
    ]);
    expect(stored.rows).toHaveLength(1);
    expect(keccak256(stored.rows[0]?.outbox_raw as Hex)).toBe(stored.rows[0]?.transaction_hash);
    expect(await client.public.getBalance({ address: victim as Hex })).toBe(0n);

    // The restarted process finds the unresolved grant and sends the same bytes.
    const second = await requestTestnetFunding(fundingDeps({ pollAttempts: 1 }), victim);
    expect(second).toMatchObject({
      status: 'pending',
      transactionHash: stored.rows[0]?.transaction_hash,
    });
    await mine(6);
    expect(await requestTestnetFunding(fundingDeps(), victim)).toMatchObject({
      status: 'already_funded',
    });
    expect(await client.public.getBalance({ address: victim as Hex })).toBe(DEFAULT_GRANT_WEI);
    const rows = await pool.query('SELECT phase FROM funding_grants WHERE recipient = $1', [
      victim,
    ]);
    expect(rows.rows).toHaveLength(1);
  });

  it('declines when disabled, unconfigured or on the wrong chain', async () => {
    const other = `0x${'0e'.repeat(20)}`;
    expect(
      await requestTestnetFunding(
        fundingDeps({ settings: { ...settings, fundingEnabled: false } }),
        other,
      ),
    ).toMatchObject({ status: 'disabled', faucetUrl: 'https://faucet.monad.xyz' });
    expect(await requestTestnetFunding(fundingDeps({ funder: null }), other)).toMatchObject({
      status: 'unavailable',
    });
    expect(
      await requestTestnetFunding(fundingDeps({ policy: { ...policy, chainId: '143' } }), other),
    ).toMatchObject({ status: 'unavailable' });
  });
});

interface Package {
  readonly prepared: PreparedReviewPackage;
}

async function registryNonce(address: string): Promise<string> {
  return (
    await client.public.readContract({
      address: registry,
      abi,
      functionName: 'nonceOf',
      args: [address as Hex],
    })
  ).toString();
}
const deadline = (): string =>
  expectOk(defaultActionDeadline(String(Math.floor(Date.now() / 1000))));

/** Stage one: the explicit action confirmation through the real controller. */
async function authorize(
  bound: BoundReviewAction,
  prepared: PreparedReviewPackage,
): Promise<SignedReviewAction> {
  await tick();
  const request = { action: bound, packageReference: prepared.reference };
  const ticket = h.controller.review.preview(request);
  if (!ticket.ok) throw new Error(`preview ${ticket.code}`);
  const signed = await h.controller.review.confirm(ticket.data, request);
  if (!signed.ok) throw new Error(`confirm ${signed.code}`);
  return signed.data;
}

let issueCounter = 0;
/** The whole path for one action: reserve, quote, second confirmation, submit, confirm. */
async function runExecute(bound: BoundReviewAction, prepared: PreparedReviewPackage) {
  const signed = await authorize(bound, prepared);
  const request = { kind: 'execute' as const, action: bound, packageReference: prepared.reference };
  issueCounter += 1;
  const created = await createOperation(
    deps,
    reviewer,
    `idempotency-key-${String(issueCounter).padStart(8, '0')}`,
    request,
  );
  if (!created.ok) throw new Error(`create ${created.code}`);
  const id = created.data.operation.operationId;
  const quoted = await quoteOperation(deps, reviewer, id, request, signed.signature);
  if (!quoted.ok) throw new Error(`quote ${quoted.code}`);
  const ticket = h.controller.transactions.preview(quoted.data.quote, {
    kind: 'execute',
    authorization: signed,
  });
  if (!ticket.ok) throw new Error(`tx preview ${ticket.code}`);
  const raw = await h.controller.transactions.confirm(ticket.data, quoted.data.quote, {
    kind: 'execute',
    authorization: signed,
  });
  if (!raw.ok) throw new Error(`tx confirm ${raw.code}`);
  const input = { quote: quoted.data.quote, request, signedTransaction: raw.data.raw };
  const sent = await submitOperation(deps, reviewer, id, input);
  if (!sent.ok) throw new Error(`submit ${sent.code}`);
  await mine(6);
  const settled = await reconcileOperation(deps, reviewer, id, request);
  if (!settled.ok) throw new Error(`reconcile ${settled.code}`);
  return { id, request, input, raw: raw.data, sent: sent.data, settled: settled.data };
}

describe('ISSUE, SUPERSEDE and REVOKE through Mera, the two-stage signer and Alchemy-shaped RPC', () => {
  const state: { original?: Package; replacement?: Package } = {};

  it('ISSUE: both confirmations, durable hash, execution-checkpoint confirmation and exact events', async () => {
    await tick();
    const binding = { chainId: '31337', registryAddress: registry, reviewerAddress: reviewer };
    const prepared = await prepareLocalPackage('legal', binding, null);
    state.original = { prepared };
    const bound = expectOk(buildIssueAction(prepared, await registryNonce(reviewer), deadline()));
    const run = await runExecute(bound, prepared);
    expect(run.settled.operation).toMatchObject({
      phase: 'confirmed',
      executedViaAnotherTransaction: false,
    });
    expect(run.settled.observation?.events.map((e) => e.eventKind)).toEqual(['issued']);
    expect(run.sent.transactionHash).toBe(run.raw.hash);

    const row = await store.get(run.id, reviewer);
    expect(row?.transactionHash).toBe(run.raw.hash);
    // No signed bytes or user action signature are stored.
    const dump = JSON.stringify(await pool.query('SELECT * FROM chain_operations'));
    expect(dump).not.toContain(run.raw.raw.slice(2, 60));

    const live = await readLiveReceipt(
      client.live,
      policy,
      { reference: prepared.reference, opening: prepared.opening },
      now,
    );
    expect(live).toMatchObject({
      status: 'ok',
      data: { receipt: { receiptLifecycle: 'active' }, binding: { binding: 'match' } },
    });

    // An exact retry reconciles the stored hash and broadcasts nothing new.
    const retry = await submitOperation(deps, reviewer, run.id, run.input);
    expect(retry).toMatchObject({ ok: true, data: { transactionHash: run.raw.hash } });
  });

  it('replaying the signed action is rejected before any signature or fee', async () => {
    const prepared = state.original?.prepared as PreparedReviewPackage;
    // The action nonce has advanced, so the same package can neither be re-issued nor re-signed.
    const stale = expectOk(buildIssueAction(prepared, '0', deadline()));
    const created = await createOperation(deps, reviewer, 'idempotency-key-replay-0001', {
      kind: 'execute',
      action: stale,
      packageReference: prepared.reference,
    });
    expect(created).toEqual({ ok: false, code: 'NONCE_MISMATCH' });
  });

  it('SUPERSEDE: ReceiptIssued then ReceiptSuperseded; the old receipt is superseded, the new one active', async () => {
    const original = state.original?.prepared as PreparedReviewPackage;
    const binding = { chainId: '31337', registryAddress: registry, reviewerAddress: reviewer };
    const replacement = await prepareLocalPackage('legal-revised', binding, original.reference);
    state.replacement = { prepared: replacement };
    const bound = expectOk(
      buildSupersedeAction(
        original.reference,
        replacement,
        await registryNonce(reviewer),
        deadline(),
      ),
    );
    const run = await runExecute(bound, replacement);
    expect(run.settled.operation.phase).toBe('confirmed');
    expect(run.settled.observation?.events.map((e) => e.eventKind)).toEqual([
      'issued',
      'superseded',
    ]);
    const before = await readLiveReceipt(
      client.live,
      policy,
      { reference: original.reference },
      now,
    );
    const after = await readLiveReceipt(
      client.live,
      policy,
      { reference: replacement.reference },
      now,
    );
    expect(before).toMatchObject({ data: { receipt: { receiptLifecycle: 'superseded' } } });
    expect(after).toMatchObject({
      data: { receipt: { receiptLifecycle: 'active', predecessor: original.reference.commitment } },
    });
  });

  it('REVOKE: current status changes after the earlier confirmed transaction', async () => {
    const replacement = state.replacement?.prepared as PreparedReviewPackage;
    const bound = expectOk(
      buildRevokeAction(replacement.reference, await registryNonce(reviewer), deadline()),
    );
    const run = await runExecute(bound, replacement);
    expect(run.settled.operation.phase).toBe('confirmed');
    const live = await readLiveReceipt(
      client.live,
      policy,
      { reference: replacement.reference },
      now,
    );
    expect(live).toMatchObject({ data: { receipt: { receiptLifecycle: 'revoked' } } });
  });

  it('invalidateNonce: its own explicit intent, no ReviewAction signature, exact counter transition', async () => {
    await tick();
    const expected = await registryNonce(reviewer);
    const request = { kind: 'invalidate_nonce' as const, expectedNonce: expected };
    const created = await createOperation(deps, reviewer, 'idempotency-key-invalidate1', request);
    if (!created.ok) throw new Error(created.code);
    const id = created.data.operation.operationId;
    const quoted = await quoteOperation(deps, reviewer, id, request, null);
    if (!quoted.ok) throw new Error(quoted.code);
    const intent = { kind: 'invalidate_nonce' as const, expectedNonce: expected };
    const ticket = h.controller.transactions.preview(quoted.data.quote, intent);
    if (!ticket.ok) throw new Error(ticket.code);
    const raw = await h.controller.transactions.confirm(ticket.data, quoted.data.quote, intent);
    if (!raw.ok) throw new Error(raw.code);
    const sent = await submitOperation(deps, reviewer, id, {
      quote: quoted.data.quote,
      request,
      signedTransaction: raw.data.raw,
    });
    expect(sent.ok).toBe(true);
    await mine(6);
    const settled = await reconcileOperation(deps, reviewer, id, request);
    expect(settled).toMatchObject({ ok: true, data: { operation: { phase: 'confirmed' } } });
    expect(await registryNonce(reviewer)).toBe((BigInt(expected) + 1n).toString());
    // A stale expectation is rejected up front.
    expect(await createOperation(deps, reviewer, 'idempotency-key-invalidate2', request)).toEqual({
      ok: false,
      code: 'NONCE_MISMATCH',
    });
  });
});

describe('browser-side restrictions', () => {
  async function freshQuote() {
    await tick();
    const binding = { chainId: '31337', registryAddress: registry, reviewerAddress: reviewer };
    const prepared = await prepareLocalPackage(
      'legal',
      { ...binding, reviewerAddress: reviewer },
      null,
    );
    const bound = expectOk(buildIssueAction(prepared, await registryNonce(reviewer), deadline()));
    const signed = await authorize(bound, prepared);
    const quote = {
      operationId: crypto.randomUUID(),
      account: reviewer,
      chainId: '31337',
      registryAddress: registry,
      calldataHash: '',
      actionDigest: signed.digest,
      transactionNonce: '0',
      gasLimit: '200000',
      maxFeePerGas: '100000000000',
      maxPriorityFeePerGas: '1000000000',
      maxFeeWei: '20000000000000000',
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const { encodeExecuteCalldata, calldataHash } = await import('@lexaegis/sdk/transactions');
    quote.calldataHash = calldataHash(
      encodeExecuteCalldata(signed.action.action, signed.signature) as Hex,
    );
    return { signed, quote };
  }

  it('rejects a changed destination, calldata, fee ceiling, gas limit, digest and an expired quote', async () => {
    const { signed, quote } = await freshQuote();
    const intent = { kind: 'execute' as const, authorization: signed };
    const bad = [
      { ...quote, registryAddress: `0x${'cd'.repeat(20)}` },
      { ...quote, calldataHash: `0x${'00'.repeat(32)}` },
      { ...quote, maxFeeWei: '1' },
      { ...quote, gasLimit: '1000001', maxFeeWei: '100000100000000000' },
      { ...quote, actionDigest: `0x${'11'.repeat(32)}` },
      { ...quote, account: `0x${'cd'.repeat(20)}` },
      { ...quote, expiresAt: new Date(h.clock.now - 1000).toISOString() },
    ];
    for (const candidate of bad) {
      expect(h.controller.transactions.preview(candidate, intent).ok).toBe(false);
    }
    // A look-alike authorization object is not a released signature.
    expect(
      h.controller.transactions.preview(quote, { kind: 'execute', authorization: { ...signed } }),
    ).toEqual({ ok: false, code: 'TICKET_INVALID' });
    expect(h.controller.transactions.preview(quote, intent).ok).toBe(true);
  });

  it('a ticket confirms once; a changed quote or a look-alike ticket cannot', async () => {
    const { signed, quote } = await freshQuote();
    const intent = { kind: 'execute' as const, authorization: signed };
    const ticket = h.controller.transactions.preview(quote, intent);
    if (!ticket.ok) throw new Error('preview');
    expect(await h.controller.transactions.confirm({ ...ticket.data }, quote, intent)).toEqual({
      ok: false,
      code: 'TICKET_INVALID',
    });
    expect(
      await h.controller.transactions.confirm(
        ticket.data,
        { ...quote, gasLimit: '210000', maxFeeWei: '21000000000000000' },
        intent,
      ),
    ).toEqual({ ok: false, code: 'TICKET_INVALID' });
    // The first attempt consumed the ticket, even though it failed.
    expect(await h.controller.transactions.confirm(ticket.data, quote, intent)).toEqual({
      ok: false,
      code: 'TICKET_INVALID',
    });
  });

  it('locking drops unused tickets', async () => {
    const { signed, quote } = await freshQuote();
    const intent = { kind: 'execute' as const, authorization: signed };
    const ticket = h.controller.transactions.preview(quote, intent);
    if (!ticket.ok) throw new Error('preview');
    h.controller.lock();
    expect((await h.controller.transactions.confirm(ticket.data, quote, intent)).ok).toBe(false);
    expect(h.controller.transactions.preview(quote, intent).ok).toBe(false);
  });
});

describe('server-side restrictions on a user-signed transaction', () => {
  it('rejects wrong sender, extra calldata, value, recipient, EIP-7702, fee-cap bypass and wrong nonce', async () => {
    await tick();
    const owner = tester.address.toLowerCase();
    const binding = { chainId: '31337', registryAddress: registry, reviewerAddress: owner };
    const prepared = await prepareLocalPackage('legal', binding, null);
    const bound = expectOk(buildIssueAction(prepared, await registryNonce(owner), deadline()));
    const request = {
      kind: 'execute' as const,
      action: bound,
      packageReference: prepared.reference,
    };
    const created = await createOperation(deps, owner, 'idempotency-key-tester-001', request);
    if (!created.ok) throw new Error(created.code);
    const id = created.data.operation.operationId;
    const { buildTypedData, toEip712ReviewAction } = await import('@lexaegis/sdk/registry');
    const typed = expectOk(buildTypedData(bound, '31337', registry));
    const eip = expectOk(toEip712ReviewAction(typed));
    const signature = await tester.signTypedData(eip as never);
    const quoted = await quoteOperation(deps, owner, id, request, signature);
    if (!quoted.ok) throw new Error(quoted.code);
    const q = quoted.data.quote;
    const { encodeExecuteCalldata } = await import('@lexaegis/sdk/transactions');
    const data = encodeExecuteCalldata(bound.action, signature) as Hex;
    const good = {
      type: 'eip1559' as const,
      chainId: TESTNET,
      to: registry,
      value: 0n,
      data,
      nonce: Number(q.transactionNonce),
      gas: BigInt(q.gasLimit),
      maxFeePerGas: BigInt(q.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(q.maxPriorityFeePerGas),
      accessList: [] as never[],
    };
    const send = async (tx: Record<string, unknown>, account = tester) =>
      submitOperation(deps, owner, id, {
        quote: q,
        request,
        signedTransaction: await account.signTransaction(tx as never),
      });
    const stranger = privateKeyToAccount(`0x${'99'.repeat(32)}`);

    expect(await send(good, stranger)).toEqual({ ok: false, code: 'SENDER_MISMATCH' });
    expect(await send({ ...good, data: `${data}00` })).toEqual({
      ok: false,
      code: 'TRANSACTION_REJECTED',
    });
    expect(await send({ ...good, value: 1n })).toEqual({ ok: false, code: 'TRANSACTION_REJECTED' });
    expect(await send({ ...good, to: accounts.executor.address })).toEqual({
      ok: false,
      code: 'TRANSACTION_REJECTED',
    });
    expect(await send({ ...good, to: null })).toEqual({ ok: false, code: 'TRANSACTION_REJECTED' });
    expect(await send({ ...good, chainId: 143 })).toEqual({
      ok: false,
      code: 'TRANSACTION_REJECTED',
    });
    expect(await send({ ...good, maxFeePerGas: good.maxFeePerGas * 100n })).toEqual({
      ok: false,
      code: 'FIELDS_MISMATCH',
    });
    expect(await send({ ...good, gas: good.gas + 1n })).toEqual({
      ok: false,
      code: 'FIELDS_MISMATCH',
    });
    expect(await send({ ...good, nonce: good.nonce + 1 })).toEqual({
      ok: false,
      code: 'FIELDS_MISMATCH',
    });
    const delegated = await tester
      .signTransaction({
        type: 'eip7702',
        chainId: TESTNET,
        to: registry,
        nonce: good.nonce,
        gas: good.gas,
        maxFeePerGas: good.maxFeePerGas,
        maxPriorityFeePerGas: good.maxPriorityFeePerGas,
        authorizationList: [],
      } as never)
      .catch(() => '0x04');
    expect(
      await submitOperation(deps, owner, id, { quote: q, request, signedTransaction: delegated }),
    ).toMatchObject({ ok: false });
    // A different operation's quote is not accepted for this one.
    expect(
      await submitOperation(deps, owner, id, {
        quote: { ...q, operationId: crypto.randomUUID() },
        request,
        signedTransaction: await tester.signTransaction(good as never),
      }),
    ).toEqual({ ok: false, code: 'QUOTE_INVALID' });
    // Nothing above was broadcast, so the owner's EOA nonce is unchanged.
    expect(await client.public.getTransactionCount({ address: tester.address })).toBe(good.nonce);

    // The exact transaction is accepted, and a second operation for the account is refused meanwhile.
    const accepted = await send(good);
    expect(accepted).toMatchObject({ ok: true });
    const busy = await createOperation(deps, owner, 'idempotency-key-tester-002', {
      kind: 'invalidate_nonce',
      expectedNonce: '1',
    });
    expect(busy.ok).toBe(false);
  });
});
