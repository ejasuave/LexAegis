// Applies the additive SQL migrations once, in name order, each in its own transaction, under the
// same advisory lock as apps/web/src/server/db/migrate.ts. Used as the release (pre-deploy) job
// in the production image, which has no TypeScript runner. Prints file names only.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

// The standalone output keeps dependencies in node_modules/.pnpm only, so a bare `pg` import does
// not resolve from here. Fall back to the traced store entry; its own dependencies sit beside it.
async function loadPg() {
  try {
    return (await import('pg')).default;
  } catch {
    const store = join(process.cwd(), 'node_modules', '.pnpm');
    const entry = readdirSync(store).find((name) => /^pg@\d/.test(name));
    if (entry === undefined) throw new Error('pg is not installed in this image');
    return createRequire(join(store, entry, 'node_modules', 'pg', 'index.js'))('./lib/index.js');
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  // Unconfigured is a valid, visible state (the app reports database.postgres as unconfigured).
  process.stdout.write('DATABASE_URL is not set: migrations skipped.\n');
  process.exit(0);
}
const pg = await loadPg();
const dir = process.env.MIGRATIONS_DIR ?? join(process.cwd(), 'migrations');
const pool = new pg.Pool({ connectionString: url, max: 1 });
const client = await pool.connect();
const applied = [];
try {
  await client.query('SELECT pg_advisory_lock(4172001)');
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const done = new Set(
    (await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (done.has(name)) continue;
    await client.query('BEGIN');
    try {
      await client.query(readFileSync(join(dir, name), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      applied.push(name);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  process.stdout.write(
    `${applied.length === 0 ? 'database is up to date' : `applied ${applied.join(', ')}`}
`,
  );
} finally {
  await client.query('SELECT pg_advisory_unlock(4172001)').catch(() => undefined);
  client.release();
  await pool.end();
}
