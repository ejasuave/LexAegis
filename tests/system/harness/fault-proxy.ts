import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';

/*
 * A loopback JSON-RPC proxy in front of the local node, with injectable faults. It forwards every call
 * to the upstream node and applies the first matching rule:
 *   - `lose_response`: the call IS forwarded (a send is accepted by the node), then the connection is
 *     destroyed, as with a timeout after the network accepted a transaction.
 *   - `fail`: the call is NOT forwarded and the client gets an HTTP 503 (an outage, or bytes lost
 *     before the node saw them).
 *   - `rewrite`: the result is replaced (a changing block hash, a wrong chain ID, missing history).
 * It models transport behaviour only. It is not evidence of how Alchemy or Monad behave.
 */

export type FaultMode = 'lose_response' | 'fail' | 'rewrite';

export interface FaultRule {
  readonly method: string;
  readonly mode: FaultMode;
  /** How many matching calls to affect; unlimited when absent. */
  readonly times?: number;
  readonly rewrite?: (result: unknown, params: readonly unknown[]) => unknown;
  /** When present, the rule applies only if this returns true. */
  readonly when?: (params: readonly unknown[]) => boolean;
}

export interface FaultProxy {
  readonly url: string;
  /** Every JSON-RPC call received, in order (method and a one-line view of the params). */
  readonly calls: { readonly method: string; readonly params: readonly unknown[] }[];
  add(rule: FaultRule): void;
  clear(): void;
  count(method: string): number;
  stop(): Promise<void>;
}

interface RpcCall {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown[];
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

export async function startFaultProxy(upstream: string, port = 0): Promise<FaultProxy> {
  const rules: { rule: FaultRule; used: number }[] = [];
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const body = JSON.parse(await readBody(request)) as RpcCall | RpcCall[];
      const batch = Array.isArray(body);
      const outputs: unknown[] = [];
      let lose = false;
      let fail = false;
      for (const call of batch ? body : [body]) {
        const params = call.params ?? [];
        calls.push({ method: call.method, params });
        const entry = rules.find(
          (candidate) =>
            candidate.rule.method === call.method &&
            (candidate.rule.times === undefined || candidate.used < candidate.rule.times) &&
            (candidate.rule.when?.(params) ?? true),
        );
        if (entry !== undefined) entry.used += 1;
        if (entry?.rule.mode === 'fail') {
          fail = true;
          continue;
        }
        const forwarded = (await (
          await fetch(upstream, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(call),
          })
        ).json()) as { result?: unknown };
        if (entry?.rule.mode === 'lose_response') lose = true;
        if (entry?.rule.mode === 'rewrite' && 'result' in forwarded)
          forwarded.result = entry.rule.rewrite?.(forwarded.result, params);
        outputs.push(forwarded);
      }
      if (lose) {
        request.socket.destroy();
        return;
      }
      if (fail) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unavailable' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(batch ? outputs : outputs[0]));
    })().catch(() => {
      request.socket.destroy();
    });
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('proxy has no port');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    calls,
    add: (rule) => rules.push({ rule, used: 0 }),
    clear: () => {
      rules.length = 0;
    },
    count: (method) => calls.filter((call) => call.method === method).length,
    stop: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}
