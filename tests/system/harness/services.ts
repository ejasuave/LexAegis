import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import type { LocalChain } from '../../../contracts/scripts/lib/anvil';
import { createLocalTransport } from '../../../contracts/scripts/lib/local-rpc';
import { resolveFoundryTool } from '../../../contracts/scripts/lib/toolchain';
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
 * Starts a throwaway Anvil on a free loopback port and proves, by asking the node, that it IS Anvil on
 * loopback before anything is deployed to it. The shared contracts tooling refuses the public Monad
 * chain IDs outright; this harness may run Anvil under 10143 only because the application's unchanged
 * configuration expects that ID, only when the caller opts in, and only after the node identifies as
 * Anvil. Nothing here can reach a public network: the endpoint is loopback by construction.
 */
export async function startSystemChain(
  chainId = 31337,
  options: { readonly allowPublicChainId?: boolean } = {},
): Promise<SystemChain | Blocked> {
  let child: ChildProcess | undefined;
  try {
    const port = await freePort();
    const rpcUrl = `http://127.0.0.1:${String(port)}`;
    child = spawn(
      resolveFoundryTool('anvil'),
      [
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--chain-id',
        String(chainId),
        '--network',
        'monad',
        '--silent',
      ],
      { stdio: 'ignore' },
    );
    const exited = once(child, 'exit');
    const transport = createLocalTransport(rpcUrl);
    const probe = await waitUntil(
      'anvil ready',
      async () => {
        try {
          const reported = BigInt(
            (await transport.request('eth_chainId', [])) as string,
          ).toString();
          const clientVersion = String(await transport.request('web3_clientVersion', []));
          return { chainId: reported, clientVersion };
        } catch {
          return null;
        }
      },
      { timeoutMs: 20_000, intervalMs: 100 },
    );
    const guard = checkLocalChain(rpcUrl, probe, {
      allowPublicChainIdOnAnvil: options.allowPublicChainId === true,
    });
    const stop = async (): Promise<void> => {
      if (child !== undefined && child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM');
      await exited;
    };
    if (!guard.ok) {
      await stop();
      return { blocked: true, code: 'SERVICE_UNAVAILABLE', reason: guard.code };
    }
    return {
      local: { rpcUrl, chainId: BigInt(probe.chainId), transport, stop },
      chainId: probe.chainId,
      stop,
    };
  } catch {
    child?.kill('SIGTERM');
    return { blocked: true, code: 'PREREQUISITE_MISSING', reason: 'START_FAILED' };
  }
}

export const isBlocked = (value: unknown): value is Blocked =>
  typeof value === 'object' && value !== null && 'blocked' in value;

async function portIsFree(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
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

export interface WebApp {
  /** The configured application origin (what a request's Origin header must equal). */
  readonly origin: string;
  /** Where the process actually listens. Equal to `origin` unless a scheme or build is overridden. */
  readonly baseUrl: string;
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
  /** Present the application as HTTPS (cookies become Secure and `__Host-`) while listening on HTTP. */
  readonly configuredScheme?: 'http' | 'https';
  /**
   * Start another process from the SAME build, on another port. It keeps the first app's configured
   * origin (public values are baked into a build) but takes its own server-side environment.
   */
  readonly sameBuildAs?: WebApp;
  /** Server output and extra environment, for the privacy observer (a log file and an egress recorder). */
  readonly serverLog?: {
    readonly stdio: ['ignore', number, number];
    readonly env: Record<string, string>;
  };
}): Promise<WebApp | Blocked> {
  // NEXT_PUBLIC_* values are baked into the build, so a reusable build needs a stable port per name.
  const stable = 3200 + (createHash('sha256').update(options.name).digest().readUInt16BE(0) % 700);
  const stableFree = options.sameBuildAs === undefined && (await portIsFree(stable));
  const reuse =
    stableFree && (options.reuseBuild === true || process.env.SYSTEM_REUSE_BUILD === '1');
  const port = stableFree ? stable : await freePort();
  const baseUrl = `http://localhost:${String(port)}`;
  const origin =
    options.sameBuildAs !== undefined
      ? options.sameBuildAs.origin
      : `${options.configuredScheme ?? 'http'}://localhost:${String(port)}`;
  const distDir = options.sameBuildAs?.distDir ?? `.next-system-${options.name}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEXT_DIST_DIR: distDir,
    NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_APP_ORIGIN: origin,
    NEXT_PUBLIC_WEBAUTHN_RP_ID: 'localhost',
    WEB_PORT: String(port),
    ...options.env,
  };
  const serverEnv: NodeJS.ProcessEnv = { ...env, ...options.serverLog?.env };
  if (options.sameBuildAs === undefined && !reuse && (await runNext(['build'], env)) !== 0)
    return { blocked: true, code: 'PREREQUISITE_MISSING', reason: 'START_FAILED' };
  const child: ChildProcess = spawn('pnpm', ['exec', 'next', 'start', '--port', String(port)], {
    cwd: join(repository, 'apps', 'web'),
    env: serverEnv,
    stdio: options.serverLog?.stdio ?? 'ignore',
    detached: true,
  });
  try {
    await waitUntil(
      'web application health',
      async () => {
        try {
          return (await fetch(`${baseUrl}/api/health`)).ok ? true : null;
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
    baseUrl,
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
