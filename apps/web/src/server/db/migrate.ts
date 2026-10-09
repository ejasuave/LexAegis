import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Applies each migration file once, in name order, inside its own transaction. An advisory
 * lock makes concurrent runners (several instances starting together) apply each file once.
 */
export async function migrate(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(4172001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (row) => row.name,
      ),
    );
    for (const name of readdirSync(MIGRATIONS)
      .filter((file) => file.endsWith('.sql'))
      .sort()) {
      if (done.has(name)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(MIGRATIONS, name), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        applied.push(name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(4172001)').catch(() => undefined);
    client.release();
  }
  return applied;
}
