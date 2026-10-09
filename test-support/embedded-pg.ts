import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import EmbeddedPostgres from 'embedded-postgres';

export interface LocalPostgres {
  /** Loopback connection string for a throwaway database. The password is not a credential. */
  readonly url: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  await once(server, 'close');
  if (address === null || typeof address === 'string') throw new Error('no free port');
  return address.port;
}

/**
 * Starts a real PostgreSQL server (binaries from the embedded-postgres package) on a loopback
 * port with a temporary data directory, and removes both on stop. For tests and local
 * development only; deployed environments supply DATABASE_URL.
 */
export async function startLocalPostgres(port?: number): Promise<LocalPostgres> {
  const databaseDir = mkdtempSync(join(tmpdir(), 'lexaegis-pg-'));
  const chosen = port ?? (await freePort());
  const server = new EmbeddedPostgres({
    databaseDir,
    user: 'lexaegis',
    password: 'local-only',
    port: chosen,
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });
  await server.initialise();
  await server.start();
  await server.createDatabase('lexaegis');
  return {
    url: `postgres://lexaegis:local-only@127.0.0.1:${String(chosen)}/lexaegis`,
    async stop() {
      await server.stop();
      rmSync(databaseDir, { recursive: true, force: true });
    },
  };
}
