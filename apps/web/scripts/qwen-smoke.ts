/**
 * pnpm qwen:smoke
 *
 * An explicit, bounded LIVE check of the configured Qwen endpoint, model and output mode, using
 * one SYNTHETIC Chapter 8 fixture (fixtures/documents-v1/pdfs/discrepancy-2000.pdf) and nothing
 * else. It is never part of CI or page startup. It spends provider tokens within the ordinary
 * per-run budget: a capability check (three completions) and two runs.
 *
 *   1. Capability checks: native tool call, the configured structured-output mode, usage, abort.
 *      A passing record is stored (when DATABASE_URL is set) so the application may treat this
 *      exact configuration as verified. A changed endpoint, model or mode has no record.
 *   2. A run through the real runtime: the model must itself request at least two read-only
 *      tools, application code executes them, and the final answer is validated locally.
 *   3. A second run that is cancelled while the provider is being waited on.
 *
 * Without credentials or capabilities the result is "blocked": a factual record that nothing was
 * called. It never substitutes a model, a region, a provider or a scripted answer.
 *
 * The evidence file holds identifiers, function names, code results, digests and outcomes for the
 * synthetic fixture. It holds no credential, endpoint URL, workspace identifier or real matter.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createQwenProvider, type RunStore } from '@lexaegis/agent';
import { createMemoryRunStore } from '@lexaegis/agent/testing';
import { resolveAssistantProvider } from '../src/server/assistant/config';
import { createPostgresRunStore } from '../src/server/assistant/run-store';
import { migrate } from '../src/server/db/migrate';
import { loadServerConfig } from '../src/server/env';
import { runSmoke } from './qwen-smoke-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const now = () => new Date();
const day = now().toISOString().slice(0, 10);
const OUT = join(ROOT, 'docs', 'evidence', `chapter09-qwen-smoke-${day}.json`);
function write(record: Record<string, unknown>): void {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`evidence: ${OUT.replace(`${ROOT}/`, '')}`);
}

function blocked(reasons: string[], detail: string): never {
  write({
    schema: 'lexaegis.qwen-smoke.v1',
    evidenceKind: 'blocked',
    executedAt: now().toISOString(),
    command: 'pnpm qwen:smoke',
    outcome: 'blocked',
    reasons,
    detail,
    providerCalls: 0,
    note: 'No provider was called. This is not a pass, a mocked result or live evidence.',
  });
  console.log(`blocked: ${reasons.join(', ')}`);
  process.exit(2);
}

// ---- Configuration ------------------------------------------------------------------------------

const loaded = loadServerConfig(process.env);
if (!loaded.ok) blocked(['CONFIG_INVALID'], `Invalid variables: ${loaded.invalidKeys.join(', ')}`);
const resolved = resolveAssistantProvider(loaded.config);
if (resolved.state === 'not_configured')
  blocked(['QWEN_NOT_CONFIGURED'], 'QWEN_API_KEY and QWEN_BASE_URL are required for a live check.');
if (resolved.state === 'invalid')
  blocked([`CONFIG_${resolved.reason}`], 'The provider configuration is invalid.');
if (resolved.provider.id !== 'qwen')
  blocked(
    ['SCRIPTED_TEST_MODE'],
    'The scripted test provider is not live evidence. Unset LEXAEGIS_TEST_MODE.',
  );

const provider = createQwenProvider(resolved.provider);
const databaseUrl = loaded.config.database.url;
let pool: Pool | null = null;
let store: RunStore;
// Without a database the check still runs, on an in-process store, but its capability record is
// not stored and the application keeps treating the configuration as unverified.
if (databaseUrl === undefined) store = createMemoryRunStore();
else {
  pool = new Pool({ connectionString: databaseUrl, max: 4 });
  pool.on('error', () => undefined);
  await migrate(pool);
  store = createPostgresRunStore(pool);
}

const result = await runSmoke({
  root: ROOT,
  provider,
  store,
  storedForApplication: pool !== null,
  evidenceKind: 'live',
  now,
  log: (line) => console.log(line),
});
write(result.record);
await pool?.end();
for (const assertion of result.assertions)
  console.log(`${assertion.ok ? 'pass' : 'FAIL'}  ${assertion.id}  (${assertion.detail})`);
console.log(
  result.outcome === 'pass'
    ? 'live smoke passed'
    : `live smoke FAILED${result.assertions.length === 0 ? `: ${result.capability.failures.join(', ')}` : ''}`,
);
process.exit(result.outcome === 'pass' ? 0 : 1);
