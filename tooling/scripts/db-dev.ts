/**
 * pnpm db:dev: a throwaway local PostgreSQL for development, migrated and ready. Loopback only;
 * the data directory is temporary and removed on exit. Set the printed DATABASE_URL in .env.
 */
import { Pool } from 'pg';
import { migrate } from '../../apps/web/src/server/db/migrate';
import { startLocalPostgres } from '../../test-support/embedded-pg';

const postgres = await startLocalPostgres(54329);
const pool = new Pool({ connectionString: postgres.url });
await migrate(pool);
await pool.end();
console.log(
  `Local PostgreSQL is running (throwaway, loopback only).\n\nDATABASE_URL=${postgres.url}\n\nPress Ctrl+C to stop and delete it.`,
);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void postgres.stop().finally(() => process.exit(0));
  });
}
setInterval(() => undefined, 1 << 30);
