import { Pool } from 'pg';
import { loadServerConfig } from '../env';

/*
 * PostgreSQL access. Not marked server-only so the migration script and database tests can
 * load it; ESLint keeps it out of every browser-reachable folder.
 */

let pool: Pool | null | undefined;

/** The shared pool, or null when DATABASE_URL is absent or invalid. Nothing falls back to memory. */
export function getPool(): Pool | null {
  if (pool !== undefined) return pool;
  const loaded = loadServerConfig(process.env);
  const url = loaded.ok ? loaded.config.database.url : undefined;
  pool = url === undefined ? null : new Pool({ connectionString: url, max: 10 });
  // An idle-client error must not crash the process or log a connection string.
  pool?.on('error', () => undefined);
  return pool;
}

export async function closePoolForTests(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}
