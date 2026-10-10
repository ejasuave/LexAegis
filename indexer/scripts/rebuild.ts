import { spawnSync } from 'node:child_process';
import { indexerRoot } from './binding';
import { newGeneration, writeGeneration } from './generation';

/*
 * Rebuild the indexer's own disposable database from the verified deployment block under a new
 * generation. Scoped, explicit, never automatic. It refuses unless the target database is named
 * as an indexer database, is not the application's database and the operator repeats its name.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function appDatabaseName(): string | undefined {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') return undefined;
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return undefined;
  }
}

const database = process.env['ENVIO_PG_DATABASE'];
const host = process.env['ENVIO_PG_HOST'] ?? '';
const flag = process.argv.indexOf('--confirm');
const confirmed = flag >= 0 ? process.argv[flag + 1] : undefined;

function refuse(reason: string): never {
  console.error(`REBUILD_REFUSED: ${reason}`);
  process.exit(1);
}

if (database === undefined || !/^lexaegis_indexer[a-z0-9_]*$/.test(database)) {
  refuse('ENVIO_PG_DATABASE must name a lexaegis_indexer* database');
}
if (database === appDatabaseName()) refuse('target is the application database');
if (!LOOPBACK.has(host)) refuse('ENVIO_PG_HOST must be loopback');
if (confirmed !== database) refuse(`repeat the database name: --confirm ${database}`);

const generation = newGeneration();
writeGeneration(generation);
console.log(`rebuilding ${database} under ${generation}`);
const result = spawnSync('pnpm', ['exec', 'envio', 'start', '--restart'], {
  cwd: indexerRoot,
  stdio: 'inherit',
  env: { ...process.env, ENVIO_INDEX_GENERATION: generation },
});
process.exit(result.status ?? 1);
