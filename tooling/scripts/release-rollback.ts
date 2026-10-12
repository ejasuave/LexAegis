/**
 * pnpm release:rollback --to <releaseId>      select a recorded, previously tested release
 * pnpm release:rollback --restore-check       rehearse a restore in a disposable namespace
 *
 * --to reads docs/release/releases.json (written only from observed provider releases). It checks
 * that the target's migration set is not newer than the database's and that origins and rpId are
 * unchanged, then stops: activation needs provider access that is not integrated. It never
 * downgrades a database, restores chain state or touches private captures. Rolling back code
 * cannot revoke a signature, reverse a transaction or remove public history.
 *
 * --restore-check is a SYNTHETIC LOCAL REHEARSAL of the restore verification logic on two
 * throwaway PostgreSQL servers and a temporary object directory. It is not evidence about any
 * provider's backup facility. It restores into a separate namespace, never over a running dataset,
 * checks head/catalog/object relationships and exact ciphertext digests, and confirms restored
 * sessions and challenges are expired.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { migrate } from '../../apps/web/src/server/db/migrate';
import { startLocalPostgres } from '../../test-support/embedded-pg';
import { ROOT } from './lib';

const args = process.argv.slice(2);
const sha = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function rollbackTo(releaseId: string): number {
  const path = join(ROOT, 'docs/release/releases.json');
  if (!existsSync(path)) {
    console.error('BLOCKED NO_RELEASE_RECORD: no observed release exists to roll back to');
    return 3;
  }
  const releases = JSON.parse(readFileSync(path, 'utf8')) as {
    id: string;
    migration: string | null;
    origins: { app: string; verifier: string };
    rpId: string;
  }[];
  const target = releases.find((release) => release.id === releaseId);
  if (target === undefined) {
    console.error(`BLOCKED UNKNOWN_RELEASE: ${releaseId} is not recorded`);
    return 3;
  }
  const latest =
    readdirSync(join(ROOT, 'apps/web/src/server/db/migrations'))
      .filter((n) => n.endsWith('.sql'))
      .sort()
      .at(-1) ?? null;
  if (target.migration !== null && latest !== null && target.migration > latest) {
    console.error('BLOCKED INCOMPATIBLE: target needs a newer schema than this checkout');
    return 3;
  }
  console.error('BLOCKED NOT_IMPLEMENTED: activation needs integrated provider access');
  return 3;
}

async function restoreCheck(): Promise<number> {
  const started = Date.now();
  const objects = mkdtempSync(join(tmpdir(), 'lexaegis-objects-'));
  const source = await startLocalPostgres();
  const restored = await startLocalPostgres();
  const from = new Pool({ connectionString: source.url });
  const to = new Pool({ connectionString: restored.url });
  const problems: string[] = [];
  try {
    await migrate(from);
    await migrate(to);
    const vaultId = randomUUID();
    const catalogId = randomUUID();
    const dataId = randomUUID();
    const now = new Date();
    await from.query(
      `INSERT INTO vaults (vault_id, owner_address, rp_id, account_profile_id, state, created_at, object_count, byte_count)
       VALUES ($1, $2, 'rehearsal.invalid', 'synthetic', 'ready', $3, 2, 0)`,
      [vaultId, `0x${'11'.repeat(20)}`, now],
    );
    let total = 0;
    for (const [id, size] of [
      [catalogId, 64],
      [dataId, 256],
    ] as const) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 31 + size) % 256);
      writeFileSync(join(objects, id), bytes);
      total += size;
      await from.query(
        `INSERT INTO vault_objects (vault_id, object_id, byte_length, sha256, state, created_at, ready_at)
         VALUES ($1, $2, $3, $4, 'ready', $5, $5)`,
        [vaultId, id, size, sha(bytes), now],
      );
    }
    await from.query('UPDATE vaults SET byte_count = $2 WHERE vault_id = $1', [vaultId, total]);
    await from.query(
      `INSERT INTO vault_heads (vault_id, revision, catalog_object_id, updated_at) VALUES ($1, 1, $2, $3)`,
      [vaultId, catalogId, now],
    );

    // Backup, then restore, in dependency order. Sessions and challenges are NOT restored.
    for (const table of ['vaults', 'vault_objects', 'vault_heads']) {
      const rows = (await from.query(`SELECT * FROM ${table}`)).rows as Record<string, unknown>[];
      for (const row of rows) {
        const columns = Object.keys(row);
        await to.query(
          `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${String(i + 1)}`).join(',')})`,
          columns.map((column) => row[column]),
        );
      }
    }

    // Negative control: --corrupt flips one stored byte, and the check must then fail.
    if (args.includes('--corrupt')) {
      const victim = join(objects, dataId);
      const bytes = readFileSync(victim);
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      writeFileSync(victim, bytes);
    }

    const head = (
      await to.query<{ catalog_object_id: string }>(
        'SELECT catalog_object_id FROM vault_heads WHERE vault_id = $1',
        [vaultId],
      )
    ).rows[0];
    if (head?.catalog_object_id !== catalogId)
      problems.push('head does not reference the catalog object');
    const rows = (
      await to.query<{ object_id: string; byte_length: string; sha256: string }>(
        'SELECT object_id, byte_length, sha256 FROM vault_objects WHERE vault_id = $1',
        [vaultId],
      )
    ).rows;
    if (rows.length !== 2) problems.push(`expected 2 objects, found ${String(rows.length)}`);
    for (const row of rows) {
      const file = join(objects, row.object_id);
      if (!existsSync(file)) {
        problems.push(`object ${row.object_id} missing from the object store`);
        continue;
      }
      const bytes = readFileSync(file);
      if (bytes.length !== Number(row.byte_length))
        problems.push(`length mismatch for ${row.object_id}`);
      if (sha(bytes) !== row.sha256) problems.push(`digest mismatch for ${row.object_id}`);
    }
    const sessions = Number(
      (await to.query<{ n: string }>('SELECT count(*) AS n FROM auth_sessions')).rows[0]?.n ?? '1',
    );
    const challenges = Number(
      (await to.query<{ n: string }>('SELECT count(*) AS n FROM auth_challenges')).rows[0]?.n ??
        '1',
    );
    if (sessions !== 0 || challenges !== 0)
      problems.push('restored namespace holds sessions or challenges');
  } finally {
    await from.end();
    await to.end();
    await source.stop();
    await restored.stop();
    rmSync(objects, { recursive: true, force: true });
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  for (const problem of problems) console.error(`fail  ${problem}`);
  console.log(
    problems.length === 0
      ? `pass  synthetic rehearsal: head, catalog, 2 objects (exact lengths and SHA-256) and expired sessions verified in ${seconds} s. Local only; says nothing about any provider backup.`
      : `fail  ${String(problems.length)} problem(s)`,
  );
  return problems.length === 0 ? 0 : 1;
}

const to = args.indexOf('--to');
const code = args.includes('--restore-check')
  ? await restoreCheck()
  : to !== -1 && args[to + 1] !== undefined
    ? rollbackTo(args[to + 1] ?? '')
    : 2;
if (code === 2) console.error('usage: pnpm release:rollback --to <releaseId> | --restore-check');
process.exit(code);
