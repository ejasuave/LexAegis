/** Starts a throwaway Anvil node on a free loopback port and stops only that process. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { ChainTransport } from '@lexaegis/sdk';
import { createLocalTransport, requireLocalChain } from './local-rpc';
import { resolveFoundryTool } from './toolchain';

export interface LocalChain {
  readonly rpcUrl: string;
  readonly chainId: bigint;
  readonly transport: ChainTransport;
  /** Terminates the Anvil process this call started. Safe to call more than once. */
  stop(): Promise<void>;
}

/** Anvil's default chain ID; the registry vectors include a case for it. */
export const LOCAL_CHAIN_ID = 31337;
const READY_TIMEOUT_MS = 20_000;

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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the pinned Anvil with Monad execution rules. Its accounts are Anvil's well-known
 * development accounts: they exist only on this throwaway chain.
 */
export async function startAnvil(chainId: number = LOCAL_CHAIN_ID): Promise<LocalChain> {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
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
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2000);
  });
  const exited = once(child, 'exit');

  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  };

  const transport = createLocalTransport(rpcUrl);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`anvil exited early: ${stderr.trim()}`);
    try {
      const reported = await requireLocalChain(transport);
      if (reported !== BigInt(chainId)) throw new Error('unexpected chain ID');
      return { rpcUrl, chainId: reported, transport, stop };
    } catch (error) {
      if (Date.now() > deadline) {
        await stop();
        throw new Error(`anvil did not become ready: ${String(error)}`, { cause: error });
      }
      await delay(100);
    }
  }
}
