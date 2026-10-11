/**
 * lexaegis-test-only
 * TEST SUPPORT. Starts the pinned VersityGW (a real S3-compatible server, POSIX backend) on a
 * loopback port with a temporary directory. Conditional-create behaviour is whatever the real
 * server does; nothing here emulates it. Install the binary with `pnpm tools:s3`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BINARY = fileURLToPath(
  new URL('../../../../.tools/versitygw/v1.8.0/versitygw', import.meta.url),
);

export interface LocalS3 {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** The directory the local server keeps objects in, for tests that inspect what was stored. */
  readonly root: string;
  stop(): Promise<void>;
}

export const localS3Available = (): boolean => existsSync(BINARY);

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

function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

export async function startLocalS3(bucket = 'lexvault'): Promise<LocalS3> {
  if (!localS3Available()) throw new Error('VersityGW is not installed: run "pnpm tools:s3"');
  const root = mkdtempSync(join(tmpdir(), 'lexaegis-s3-'));
  mkdirSync(join(root, bucket));
  const port = await freePort();
  const accessKeyId = 'lexlocalaccess';
  const secretAccessKey = 'lexlocalsecret';
  const child: ChildProcess = spawn(
    BINARY,
    [
      '--port',
      `127.0.0.1:${String(port)}`,
      '--access',
      accessKeyId,
      '--secret',
      secretAccessKey,
      'posix',
      root,
    ],
    { stdio: 'ignore' },
  );
  const exited = once(child, 'exit');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await reachable(port)) break;
    if (child.exitCode !== null) throw new Error('versitygw exited early');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    bucket,
    region: 'us-east-1',
    accessKeyId,
    secretAccessKey,
    root,
    async stop() {
      // Stops only the process this call started.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
