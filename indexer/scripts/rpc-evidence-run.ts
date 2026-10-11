import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createPublicClient, http, type Hex } from 'viem';
import { proofOfReviewRegistryAbi } from '@lexaegis/sdk/registry';
import { startLocalPostgres } from '../../test-support/embedded-pg';
import { INDEXED_EVENTS, MAX_REORG_DEPTH, indexerRoot, loadTestnetBinding } from './binding';

/*
 * Real HyperIndex engine, real Monad Testnet events, embedded PostgreSQL, no GraphQL layer.
 *
 * SOURCE MODE: the Alchemy RPC endpoint as the sync source. This is NOT the production HyperSync
 * source (no ENVIO_API_TOKEN here) and it is not a GraphQL read: the projection is inspected in
 * the engine's PostgreSQL tables and compared with live registry reads at the same block.
 * The endpoint URL is written to a git-ignored temporary config and removed afterwards.
 */
const rpc = process.env['ALCHEMY_MONAD_RPC_URL'];
if (rpc === undefined || rpc === '') {
  console.error('blocked: ALCHEMY_MONAD_RPC_URL is required');
  process.exit(3);
}
const endBlockArg = process.argv.indexOf('--end-block');
const endBlock = endBlockArg >= 0 ? process.argv[endBlockArg + 1] : undefined;
if (endBlock === undefined || !/^[1-9][0-9]{7,9}$/.test(endBlock)) {
  console.error('usage: rpc-evidence-run.ts --end-block <block>');
  process.exit(2);
}

const binding = loadTestnetBinding();
const configPath = resolve(indexerRoot, 'config.rpc-evidence.yaml');
const events = INDEXED_EVENTS.map((e) => `      - event: ${e}`).join('\n');
writeFileSync(
  configPath,
  `name: lexaegis-history
ecosystem: evm
schema: ./schema.graphql
handlers: src/handlers
address_format: lowercase
rollback_on_reorg: true
field_selection:
  transaction_fields:
    - hash
    - from
contracts:
  - name: ProofOfReviewRegistry
    abi_file_path: ./abi/ProofOfReviewRegistry.json
    events:
${events}
chains:
  - id: ${binding.chainId}
    start_block: ${binding.startBlock}
    end_block: ${endBlock}
    max_reorg_depth: ${String(MAX_REORG_DEPTH)}
    rpc:
      - url: ${rpc}
        for: sync
    contracts:
      - name: ProofOfReviewRegistry
        address: ${binding.registryAddress}
`,
);

const postgres = await startLocalPostgres();
const url = new URL(postgres.url);
const pool = new Pool({ connectionString: postgres.url });
pool.on('error', () => undefined);
const generation = 'gen-evidence-0001';
const child = spawn('pnpm', ['exec', 'envio', 'start', '--config', 'config.rpc-evidence.yaml'], {
  cwd: indexerRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    ENVIO_HASURA: 'false',
    ENVIO_INDEX_GENERATION: generation,
    ENVIO_PG_HOST: url.hostname,
    ENVIO_PG_PORT: url.port,
    ENVIO_PG_USER: decodeURIComponent(url.username),
    ENVIO_PG_PASSWORD: decodeURIComponent(url.password),
    ENVIO_PG_DATABASE: url.pathname.slice(1),
    ENVIO_API_TOKEN: '',
    TUI_OFF: 'true',
  },
});
let log = '';
const redact = (text: string): string => text.split(rpc).join('[rpc]');
child.stdout.on('data', (c: Buffer) => (log += redact(c.toString('utf8'))));
child.stderr.on('data', (c: Buffer) => (log += redact(c.toString('utf8'))));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rows(sql: string): Promise<Record<string, unknown>[]> {
  try {
    return (await pool.query(sql)).rows as Record<string, unknown>[];
  } catch {
    return [];
  }
}

const startedAt = new Date().toISOString();
let done = false;
for (let i = 0; i < 360 && !done; i += 1) {
  await sleep(2000);
  const state = await rows('select * from "RegistryState"');
  const meta = await rows(
    `select table_name from information_schema.tables where table_schema = 'public'`,
  );
  if (state.length === 1 && meta.length > 0) {
    const progress = await rows('select * from envio_chains');
    const block = progress[0] === undefined ? null : Number(progress[0]['progress_block']);
    if (block !== null && block >= Number(endBlock)) done = true;
  }
  if (child.exitCode !== null) break;
}

const result = {
  startedAt,
  finishedAt: new Date().toISOString(),
  engine: 'envio 3.13.0 (HyperIndex)',
  sourceMode: 'rpc (Alchemy), NOT HyperSync; no GraphQL layer (ENVIO_HASURA=false)',
  chainId: binding.chainId,
  registry: binding.registryAddress,
  startBlock: binding.startBlock,
  endBlock,
  generation,
  engineExited: child.exitCode,
  reachedEndBlock: done,
  tables: await rows(
    `select table_name from information_schema.tables where table_schema = 'public' order by 1`,
  ),
  chains: await rows('select * from envio_chains'),
  registryState: await rows('select * from "RegistryState"'),
  summaries: await rows('select * from "ReviewerSummary" order by id'),
  actions: await rows('select * from "IndexedAction" order by "blockNumber", "firstLogIndex"'),
  receipts: await rows('select * from "IndexedReceipt" order by "issuedAt", id'),
  events: await rows(
    'select id, kind, "blockNumber", "logIndex", "actionId" from "ChainEvent" order by "blockNumber", "logIndex"',
  ),
  pending: await rows(
    'select count(*)::int as count, sum((not complete)::int)::int as incomplete from "PendingSupersession"',
  ),
};

// Same-block comparison: indexed lifecycle against the live registry at the final indexed block.
const client = createPublicClient({ transport: http(rpc) });
const at = BigInt(endBlock);
const comparisons: Record<string, unknown>[] = [];
for (const r of result.receipts) {
  const live = await client.readContract({
    address: binding.registryAddress as Hex,
    abi: proofOfReviewRegistryAbi,
    functionName: 'getReceipt',
    args: [String(r['reviewer']) as Hex, String(r['commitment']) as Hex],
    blockNumber: at,
  });
  const liveStatus = ['not_found', 'active', 'revoked', 'superseded'][
    (live as { status: number }).status
  ];
  comparisons.push({
    receipt: r['id'],
    indexed: String(r['status']).toLowerCase(),
    live: liveStatus,
    block: endBlock,
    agree: String(r['status']).toLowerCase() === liveStatus,
  });
}

child.kill('SIGINT');
await sleep(1500);
child.kill('SIGKILL');
await pool.end().catch(() => undefined);
await postgres.stop();
if (existsSync(configPath)) rmSync(configPath);

const output = { ...result, comparisons, engineLogTail: log.split('\n').slice(-25) };
const out = resolve(
  indexerRoot,
  '..',
  'docs',
  'evidence',
  `chapter07-envio-rpc-source-${startedAt.slice(0, 10)}.json`,
);
writeFileSync(
  out,
  JSON.stringify(
    output,
    (_k, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v),
    2,
  ),
);
console.log(`wrote ${out}`);
console.log(
  `reached end block: ${String(done)}; actions: ${String(result.actions.length)}; receipts: ${String(result.receipts.length)}; agree: ${String(comparisons.every((c) => c['agree'] === true))}`,
);
