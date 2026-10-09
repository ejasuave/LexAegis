/** pnpm db:migrate: applies pending migrations to DATABASE_URL. Prints file names only. */
import { Pool } from 'pg';
import { migrate } from '../../apps/web/src/server/db/migrate';

const url = process.env.DATABASE_URL;
if (url === undefined || url === '') {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const pool = new Pool({ connectionString: url });
try {
  const applied = await migrate(pool);
  console.log(applied.length === 0 ? 'database is up to date' : `applied ${applied.join(', ')}`);
} finally {
  await pool.end();
}
