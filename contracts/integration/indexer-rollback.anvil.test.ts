import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  type Hex,
  type LocalAccount,
} from 'viem';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PreparedReviewPackage } from '@lexaegis/protocol/v1';
import {
  buildIssueAction,
  buildRevokeAction,
  buildSupersedeAction,
  buildTypedData,
  defaultActionDeadline,
  proofOfReviewRegistryAbi as abi,
  toAbiReviewAction,
  toEip712ReviewAction,
  type BoundReviewAction,
} from '@lexaegis/sdk/registry';
import { startLocalPostgres, type LocalPostgres } from '../../test-support/embedded-pg';
import { startAnvil, type LocalChain } from '../scripts/lib/anvil';
import {
  accounts,
  creationCode,
  expectOk,
  lower,
  prepareLocalPackage,
  type LocalBinding,
} from './harness';

/*
 * LOCAL ROLLBACK EVIDENCE. The real Envio HyperIndex engine (RPC source, loopback only) indexes a
 * throwaway Anvil chain into a throwaway PostgreSQL. A real chain reorganisation is produced with
 * evm_snapshot / evm_revert and a different branch is mined. This shows the engine's rollback
 * restores projection state; it says nothing about HyperSync's production reorg guarantees.
 * Run with: pnpm test:indexer:rollback
 */

const ROOT = join(import.meta.dirname, '..', '..');
const INDEXER = join(ROOT, 'indexer');
const GAS = 1_000_000n;
let local: LocalChain;
let pg: LocalPostgres;
let pool: Pool;
let engine: ChildProcess | null = null;
let engineLog = '';
let registry: Hex;
let binding: LocalBinding;
const observations: Record<string, unknown> = {};
let branchBPackage: PreparedReviewPackage | null = null;

const client = () =>
  createPublicClient({ chain: foundry, transport: http(local.rpcUrl), pollingInterval: 50 });
const wallet = (account: LocalAccount) =>
  createWalletClient({ account, chain: foundry, transport: http(local.rpcUrl) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method: string, params: unknown[] = []): Promise<unknown> =>
  local.transport.request(method, params);

async function rows(sql: string): Promise<Record<string, unknown>[]> {
  try {
    return (await pool.query(sql)).rows as Record<string, unknown>[];
  } catch {
    return [];
  }
}
async function until<T>(label: string, probe: () => Promise<T | null>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > end)
      throw new Error(`timeout waiting for ${label}\n${engineLog.slice(-1500)}`);
    await sleep(500);
  }
}

async function deadline(): Promise<string> {
  const { timestamp } = await client().getBlock();
  return expectOk(defaultActionDeadline(timestamp.toString()));
}
async function nonceOf(): Promise<string> {
  return (
    await client().readContract({
      address: registry,
      abi,
      functionName: 'nonceOf',
      args: [accounts.reviewer.address],
    })
  ).toString();
}
async function submit(bound: BoundReviewAction): Promise<void> {
  const typed = expectOk(buildTypedData(bound, bound.chainId, bound.registryAddress));
  const action = expectOk(toAbiReviewAction(bound.action));
  const signature = await accounts.reviewer.signTypedData(expectOk(toEip712ReviewAction(typed)));
  const hash = await wallet(accounts.executor).sendTransaction({
    to: registry,
    data: encodeFunctionData({ abi, functionName: 'execute', args: [action, signature] }),
    gas: GAS,
  });
  const receipt = await client().waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('success');
}
const pkg = (id: 'legal' | 'legal-revised', supersedes: PreparedReviewPackage | null) =>
  prepareLocalPackage(id, binding, supersedes === null ? null : supersedes.reference);

async function headBlock(): Promise<number> {
  return Number(await client().getBlockNumber());
}
async function indexedProgress(): Promise<number> {
  const r = await rows('select progress_block from envio_chains');
  return r[0] === undefined ? -1 : Number(r[0]['progress_block']);
}
const receiptsByStatus = async () =>
  Object.fromEntries(
    (await rows('select substr(commitment, 1, 12) c, status from "IndexedReceipt" order by 1')).map(
      (r) => [String(r['c']), String(r['status'])],
    ),
  );
const state = async () =>
  (
    await rows('select "rawEventCount", "actionCount", "pendingSupersessions" from "RegistryState"')
  )[0];
const summary = async () =>
  (
    await rows(
      'select "nextNonce", "totalReceipts", "activeReceipts", "revokedReceipts", "supersededReceipts", "actionCount" from "ReviewerSummary"',
    )
  )[0];
async function settle(): Promise<void> {
  const target = await headBlock();
  await until('index to reach head', async () =>
    (await indexedProgress()) >= target ? true : null,
  );
}

beforeAll(async () => {
  local = await startAnvil();
  const deployed = await wallet(accounts.deployer).deployContract({
    abi,
    bytecode: creationCode('ProofOfReviewRegistry.sol', 'ProofOfReviewRegistry'),
  });
  const receipt = await client().waitForTransactionReceipt({ hash: deployed });
  if (receipt.contractAddress == null) throw new Error('not deployed');
  registry = lower(receipt.contractAddress) as Hex;
  binding = {
    chainId: '31337',
    registryAddress: registry,
    reviewerAddress: lower(accounts.reviewer.address),
  };
  const genesis = (await client().getBlock({ blockNumber: 0n })).hash;
  const code = (await client().getCode({ address: registry })) ?? '0x';

  const generated = spawnSync(
    'pnpm',
    [
      '--filter',
      '@lexaegis/indexer',
      'exec',
      'tsx',
      'scripts/generate-config.ts',
      '--local',
      '--chain',
      '31337',
      '--registry',
      registry,
      '--start',
      receipt.blockNumber.toString(),
      '--genesis',
      genesis,
      '--code-hash',
      keccak256(code),
      '--tx',
      deployed,
      '--rpc',
      local.rpcUrl,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (generated.status !== 0) throw new Error(`config generation failed: ${generated.stderr}`);

  pg = await startLocalPostgres();
  pool = new Pool({ connectionString: pg.url });
  pool.on('error', () => undefined);
  const url = new URL(pg.url);
  engine = spawn('pnpm', ['exec', 'envio', 'start'], {
    cwd: INDEXER,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ENVIO_HASURA: 'false',
      ENVIO_INDEXER_PORT: '9931',
      ENVIO_INDEX_GENERATION: 'gen-rollback-0001',
      ENVIO_PG_HOST: url.hostname,
      ENVIO_PG_PORT: url.port,
      ENVIO_PG_USER: decodeURIComponent(url.username),
      ENVIO_PG_PASSWORD: decodeURIComponent(url.password),
      ENVIO_PG_DATABASE: url.pathname.slice(1),
      ENVIO_API_TOKEN: '',
      TUI_OFF: 'true',
    },
  });
  engine.stdout?.on('data', (c: Buffer) => (engineLog += c.toString('utf8')));
  engine.stderr?.on('data', (c: Buffer) => (engineLog += c.toString('utf8')));
  await settle();
}, 240_000);

afterAll(async () => {
  engine?.kill('SIGINT');
  await sleep(1500);
  engine?.kill('SIGKILL');
  // Teardown runs even if setup failed part-way, so each step guards itself.
  await Promise.resolve()
    .then(() => pool.end())
    .catch(() => undefined);
  await Promise.resolve()
    .then(() => pg.stop())
    .catch(() => undefined);
  await Promise.resolve()
    .then(() => local.stop())
    .catch(() => undefined);
  // Restore the generated deployment-bound files for the real deployment.
  spawnSync(
    'pnpm',
    ['--filter', '@lexaegis/indexer', 'exec', 'tsx', 'scripts/generate-config.ts'],
    { cwd: ROOT },
  );
  writeFileSync(
    join(
      ROOT,
      'docs',
      'evidence',
      `chapter07-rollback-local-${new Date().toISOString().slice(0, 10)}.json`,
    ),
    JSON.stringify(
      {
        engine:
          'envio 3.13.0 (HyperIndex), RPC source, loopback Anvil chain 31337, embedded PostgreSQL, ENVIO_HASURA=false',
        ...observations,
      },
      null,
      2,
    ),
  );
}, 60_000);

describe('[indexer-projection-reorg-and-provenance] real engine rollback on a disposable chain', () => {
  it('removes an orphaned ISSUE and restores nonce and counters when another branch wins', async () => {
    const snapshot = (await rpc('evm_snapshot')) as string;
    const a = await pkg('legal', null);
    await submit(expectOk(buildIssueAction(a, await nonceOf(), await deadline())));
    await settle();
    await until('branch A receipt', async () =>
      (await receiptsByStatus())[a.reference.commitment.slice(0, 12)] === 'ACTIVE' ? true : null,
    );
    observations['branchA'] = {
      receipts: await receiptsByStatus(),
      state: await state(),
      summary: await summary(),
    };

    await rpc('evm_revert', [snapshot]);
    await rpc('anvil_mine', ['0x1']);
    const b = await pkg('legal-revised', null);
    branchBPackage = b;
    await submit(expectOk(buildIssueAction(b, await nonceOf(), await deadline())));
    await rpc('anvil_mine', ['0x3']);
    await settle();
    await until('orphan removal', async () =>
      (await receiptsByStatus())[a.reference.commitment.slice(0, 12)] === undefined ? true : null,
    );
    const receipts = await receiptsByStatus();
    const s = await state();
    const sum = await summary();
    observations['branchB'] = { receipts, state: s, summary: sum };
    expect(receipts).toEqual({ [b.reference.commitment.slice(0, 12)]: 'ACTIVE' });
    expect(s).toMatchObject({ rawEventCount: 1, actionCount: 1, pendingSupersessions: 0 });
    expect(sum).toMatchObject({
      nextNonce: '1',
      totalReceipts: 1,
      activeReceipts: 1,
      actionCount: 1,
    });
    expect(await rows('select count(*)::int n from "ChainEvent"')).toEqual([{ n: 1 }]);
  }, 240_000);

  it('rolls back a two-log supersession, including its staging, and applies the winning REVOKE', async () => {
    if (branchBPackage === null) throw new Error('requires the first test');
    const previous = branchBPackage.reference;
    const snapshot = (await rpc('evm_snapshot')) as string;
    const next = await prepareLocalPackage('legal', binding, previous);
    await submit(expectOk(buildSupersedeAction(previous, next, await nonceOf(), await deadline())));
    await settle();
    await until('supersede indexed', async () =>
      (await summary())?.['supersededReceipts'] === 1 ? true : null,
    );
    observations['supersedeBranch'] = {
      receipts: await receiptsByStatus(),
      state: await state(),
      summary: await summary(),
    };

    await rpc('evm_revert', [snapshot]);
    await rpc('anvil_mine', ['0x1']);
    await submit(expectOk(buildRevokeAction(previous, await nonceOf(), await deadline())));
    await rpc('anvil_mine', ['0x3']);
    await settle();
    await until('revoke branch', async () =>
      (await summary())?.['revokedReceipts'] === 1 ? true : null,
    );
    const receipts = await receiptsByStatus();
    const s = await state();
    const sum = await summary();
    observations['revokeBranch'] = { receipts, state: s, summary: sum };
    expect(Object.values(receipts)).toEqual(['REVOKED']);
    expect(sum).toMatchObject({
      nextNonce: '2',
      totalReceipts: 1,
      activeReceipts: 0,
      revokedReceipts: 1,
      supersededReceipts: 0,
      actionCount: 2,
    });
    expect(s).toMatchObject({ rawEventCount: 2, actionCount: 2, pendingSupersessions: 0 });
    expect(await rows('select count(*)::int n from "PendingSupersession"')).toEqual([{ n: 0 }]);
  }, 240_000);

  it('projects a cancelled authorisation as one INVALIDATE_NONCE action without touching receipts', async () => {
    const before = await receiptsByStatus();
    const current = await nonceOf();
    const hash = await wallet(accounts.reviewer).writeContract({
      address: registry,
      abi,
      functionName: 'invalidateNonce',
      args: [BigInt(current)],
      gas: GAS,
    });
    expect((await client().waitForTransactionReceipt({ hash })).status).toBe('success');
    await settle();
    await until('invalidation indexed', async () =>
      Number((await summary())?.['actionCount']) === 3 ? true : null,
    );
    const action = (
      await rows(
        'select kind, "consumedNonce", "nextNonce", commitment from "IndexedAction" order by "consumedNonce" desc limit 1',
      )
    )[0];
    observations['invalidateNonce'] = {
      action,
      summary: await summary(),
      receiptsUnchanged: JSON.stringify(before) === JSON.stringify(await receiptsByStatus()),
    };
    expect(action).toMatchObject({
      kind: 'INVALIDATE_NONCE',
      consumedNonce: '2',
      nextNonce: '3',
      commitment: null,
    });
    expect(await receiptsByStatus()).toEqual(before);
    expect(await summary()).toMatchObject({
      nextNonce: '3',
      totalReceipts: 1,
      revokedReceipts: 1,
      actionCount: 3,
    });
  }, 120_000);
});
