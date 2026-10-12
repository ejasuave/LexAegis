import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { migrate } from '../../../apps/web/src/server/db/migrate';
import {
  localS3Available,
  startLocalS3,
  type LocalS3,
} from '../../../apps/web/src/test-support/local-s3';
import {
  startScriptedQwenServer,
  type ScriptedQwenServer,
} from '../../../apps/web/src/test-support/scripted-qwen-server';
import { startAnvil, type LocalChain } from '../../../contracts/scripts/lib/anvil';
import { startLocalPostgres, type LocalPostgres } from '../../../test-support/embedded-pg';
import {
  checkBucket,
  checkDatabase,
  checkLocalChain,
  checkLoopback,
  type GuardFailure,
} from './guards';
import { ResourceLedger } from './ledger';
import { waitUntil } from './poll';

/*
 * Isolated local services. Each start validates the endpoint, namespace and (for the chain) the
 * actual node identity BEFORE returning. A missing service is a typed `blocked` result with an issue
 * code: there is no in-memory production fallback.
 */

export const repository = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export type Blocked = {
  readonly blocked: true;
  readonly code: 'SERVICE_UNAVAILABLE' | 'PREREQUISITE_MISSING';
  readonly reason: GuardFailure | 'S3_NOT_INSTALLED' | 'START_FAILED';
};

export interface SystemServices {
  readonly ledger: ResourceLedger;
  readonly postgres: LocalPostgres;
  readonly pool: Pool;
  readonly s3: LocalS3;
  readonly provider: ScriptedQwenServer;
  stop(): Promise<void>;
}

export async function startSystemServices(): Promise<SystemServices | Blocked> {
  const ledger = new ResourceLedger();
  if (!localS3Available())
    return { blocked: true, code: 'PREREQUISITE_MISSING', reason: 'S3_NOT_INSTALLED' };
  try {
    const postgres = await startLocalPostgres();
    ledger.record({ kind: 'postgres', name: 'embedded', cleanup: () => postgres.stop() });
    const database = checkDatabase(postgres.url);
    if (!database.ok) {
      await ledger.cleanup();
      return { blocked: true, code: 'SERVICE_UNAVAILABLE', reason: database.code };
    }
    const pool = new Pool({ connectionString: postgres.url });
    pool.on('connect', (client) => client.on('error', () => undefined));
    pool.on('error', () => undefined);
    ledger.record({ kind: 'pool', name: 'primary', cleanup: () => pool.end() });
    await migrate(pool);
    const s3 = await startLocalS3();
    ledger.record({ kind: 's3', name: s3.bucket, cleanup: () => s3.stop() });
    const bucket = checkBucket(s3.endpoint, s3.bucket);
    if (!bucket.ok) {
      await ledger.cleanup();
      return { blocked: true, code: 'SERVICE_UNAVAILABLE', reason: bucket.code };
    }
    const provider = await startScriptedQwenServer();
    ledger.record({ kind: 'provider', name: 'scripted', cleanup: () => provider.stop() });
    const loopback = checkLoopback(provider.baseUrl);
    if (!loopback.ok) {
      await ledger.cleanup();
      return { blocked: true, code: 'SERVICE_UNAVAILABLE', reason: loopback.code };
    }
    return {
      ledger,
      postgres,
      pool,
      s3,
      provider,
      stop: async () => {
        await ledger.cleanup();
      },
    };
  } catch {
    await ledger.cleanup();
    return { blocked: true, code: 'SERVICE_UNAVAILABLE', reason: 'START_FAILED' };
  }
}

export interface SystemChain {
  readonly local: LocalChain;
  readonly chainId: string;
  stop(): Promise<void>;
}

/**
 * Starts a throwaway Anvil and proves, by asking the node, that it is Anvil on a loopback endpoint
 * before anything is deployed to it. `chainId` 10143 is permitted only because the node identifies
 * itself as Anvil: the application's unchanged configuration expects that chain ID.
 */
export async function startSystemChain(
  chainId = 31337,
  options: { readonly allowPublicChainId?: boolean } = {},
): Promise<SystemChain | Blocked> {
  try {
    const local = await startAnvil(chainId);
    const reported = String(BigInt((await local.transport.request('eth_chainId', [])) as string));
    const clientVersion = String(await local.transport.request('web3_clientVersion', []));
    const guard = checkLocalChain(
      local.rpcUrl,
      { chainId: reported, clientVersion },
      { allowPublicChainIdOnAnvil: options.allowPublicChainId === true },
    );
    if (!guard.ok) {
      await local.stop();
      return { blocked: true, code: 'SERVICE_UNAVAILABLE', reason: guard.code };
    }
    return { local, chainId: reported, stop: () => local.stop() };
  } catch {
    return { blocked: true, code: 'PREREQUISITE_MISSING', reason: 'START_FAILED' };
  }
}

export const isBlocked = (value: unknown): value is Blocked =>
  typeof value === 'object' && value !== null && 'blocked' in value;

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

export interface WebApp {
  readonly origin: string;
  readonly port: number;
  readonly distDir: string;
  stop(): Promise<void>;
}

function runNext(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['exec', 'next', ...args], {
      cwd: join(repository, 'apps', 'web'),
      env,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * Builds and starts the PRODUCTION web application on a free loopback port. The origin uses
 * `localhost` so WebAuthn accepts it. The caller supplies only non-secret synthetic configuration.
 */
export async function startWebApp(options: {
  readonly name: string;
  readonly env: Readonly<Record<string, string>>;
  readonly reuseBuild?: boolean;
}): Promise<WebApp | Blocked> {
  const port = await freePort();
  const origin = `http://localhost:${String(port)}`;
  const distDir = `.next-system-${options.name}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEXT_DIST_DIR: distDir,
    NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_APP_ORIGIN: origin,
    NEXT_PUBLIC_WEBAUTHN_RP_ID: 'localhost',
    WEB_PORT: String(port),
    ...options.env,
  };
  if (options.reuseBuild !== true && (await runNext(['build'], env)) !== 0)
    return { blocked: true, code: 'PREREQUISITE_MISSING', reason: 'START_FAILED' };
  const child: ChildProcess = spawn('pnpm', ['exec', 'next', 'start', '--port', String(port)], {
    cwd: join(repository, 'apps', 'web'),
    env,
    stdio: 'ignore',
    detached: true,
  });
  try {
    await waitUntil(
      'web application health',
      async () => {
        try {
          return (await fetch(`${origin}/api/health`)).ok ? true : null;
        } catch {
          return null;
        }
      },
      { timeoutMs: 60_000, intervalMs: 250 },
    );
  } catch {
    stopChild(child);
    return { blocked: true, code: 'SERVICE_UNAVAILABLE', reason: 'START_FAILED' };
  }
  return {
    origin,
    port,
    distDir,
    stop: () => {
      stopChild(child);
      return Promise.resolve();
    },
  };
}

function stopChild(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // already gone
  }
}
