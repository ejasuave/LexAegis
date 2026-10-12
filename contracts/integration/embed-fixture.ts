/**
 * TEST HARNESS ONLY. Builds the verify-embed bundle and serves it, plain HTML pages, deliberately
 * public SYNTHETIC packages and a recording CORS proxy in front of a throwaway Anvil chain that has
 * the unchanged registry deployed. The five lifecycle receipts are created by real local
 * transactions signed with Anvil's published development key, which lives only here and never in
 * the widget bundle. Local compatibility evidence: not a Monad deployment and not live evidence.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PreparedReviewPackage, ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import { prepareLocalPackage } from './harness';
import { exportBytes, startLocalRegistry, type LocalRegistry } from './local-registry';

const repository = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EMBED_DIST = join(repository, 'packages', 'verify-embed', 'dist');

export type RpcMode = 'pass' | 'down' | 'wrong-chain' | 'hang' | 'slow-first';

export interface RpcRecord {
  readonly method: string;
  readonly body: string;
}

export interface Receipts {
  readonly active: PreparedReviewPackage;
  readonly revoked: PreparedReviewPackage;
  readonly superseded: PreparedReviewPackage;
  readonly replacement: PreparedReviewPackage;
  readonly notFound: PreparedReviewPackage;
}

export interface EmbedFixture {
  readonly chain: LocalRegistry;
  readonly receipts: Receipts;
  readonly pageOrigin: string;
  readonly otherOrigin: string;
  readonly rpcUrl: string;
  readonly rpcRecords: RpcRecord[];
  readonly packageRequests: { url: string; headers: IncomingMessage['headers'] }[];
  rpcMode: RpcMode;
  /** Per-path static content; tests add pages and packages. */
  readonly pages: Map<string, string>;
  readonly packages: Map<
    string,
    {
      body: Uint8Array | string;
      status?: number;
      redirectTo?: string;
      delayMs?: number;
      headers?: Record<string, string>;
    }
  >;
  hostConfig(overrides?: Record<string, unknown>): Record<string, unknown>;
  stop(): Promise<void>;
}

export const attributesOf = (reference: ReceiptReferenceV1, extra = ''): string =>
  `chain-id="${reference.chainId}" registry="${reference.registryAddress}" reviewer="${reference.reviewerAddress}" commitment="${reference.commitment}" ${extra}`;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve(`http://127.0.0.1:${String(port)}`);
    }),
  );
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export async function startEmbedFixture(): Promise<EmbedFixture> {
  execFileSync('pnpm', ['--filter', '@lexaegis/verify-embed', 'build'], {
    cwd: repository,
    stdio: 'ignore',
  });
  const chain = await startLocalRegistry();
  const mkPackage = (
    supersedes: ReceiptReferenceV1 | null = null,
    caseId: 'legal' | 'legal-revised' = 'legal',
  ) => prepareLocalPackage(caseId, chain.binding, supersedes);
  const active = await mkPackage();
  const revoked = await mkPackage();
  const superseded = await mkPackage();
  const replacement = await mkPackage(superseded.reference, 'legal-revised');
  const notFound = await mkPackage();
  await chain.issue(active);
  await chain.issue(revoked);
  await chain.revoke(revoked.reference);
  await chain.issue(superseded);
  await chain.supersede(superseded.reference, replacement);
  await chain.mine();

  const pages = new Map<string, string>();
  const packages: EmbedFixture['packages'] = new Map();
  const packageRequests: EmbedFixture['packageRequests'] = [];
  const rpcRecords: RpcRecord[] = [];
  let calls = 0;

  const serveStatic = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', 'http://x');
    if (url.pathname === '/embed.js' || url.pathname === '/embed.min.js') {
      const file =
        url.pathname === '/embed.js' ? 'proof-of-review-embed.js' : 'proof-of-review-embed.min.js';
      response
        .writeHead(200, { 'content-type': 'text/javascript' })
        .end(readFileSync(join(EMBED_DIST, file)));
      return;
    }
    const page = pages.get(url.pathname);
    if (page !== undefined) {
      response.writeHead(200, { 'content-type': 'text/html' }).end(page);
      return;
    }
    const item = packages.get(url.pathname);
    if (item !== undefined) {
      packageRequests.push({ url: request.url ?? '', headers: request.headers });
      const send = (): void => {
        if (item.redirectTo !== undefined) {
          response.writeHead(302, { ...CORS, location: item.redirectTo }).end();
          return;
        }
        response
          .writeHead(item.status ?? 200, {
            ...CORS,
            'content-type': 'application/json',
            ...item.headers,
          })
          .end(item.body);
      };
      if (item.delayMs !== undefined) setTimeout(send, item.delayMs);
      else send();
      return;
    }
    response.writeHead(404, CORS).end();
  };
  const pageServer = createServer(serveStatic);
  const otherServer = createServer(serveStatic);
  const pageOrigin = await listen(pageServer);
  const otherOrigin = await listen(otherServer);

  const fixture: EmbedFixture = {
    chain,
    receipts: { active, revoked, superseded, replacement, notFound },
    pageOrigin,
    otherOrigin,
    rpcUrl: '',
    rpcRecords,
    packageRequests,
    rpcMode: 'pass',
    pages,
    packages,
    hostConfig: () => ({}),
    stop: () => Promise.resolve(),
  };
  const mutable = fixture as { -readonly [K in keyof EmbedFixture]: EmbedFixture[K] };

  const proxy = createServer((request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let method = '(unparsed)';
        try {
          method = (JSON.parse(body) as { method?: string }).method ?? '(none)';
        } catch {
          // recorded as unparsed
        }
        rpcRecords.push({ method, body });
        calls += 1;
        if (fixture.rpcMode === 'down') {
          response.writeHead(503, CORS).end('unavailable');
          return;
        }
        if (fixture.rpcMode === 'hang') return;
        if (fixture.rpcMode === 'slow-first' && calls === 1)
          await new Promise((resolve) => setTimeout(resolve, 1200));
        const upstream = await fetch(chain.local.rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        let text = await upstream.text();
        if (fixture.rpcMode === 'wrong-chain' && method === 'eth_chainId')
          text = text.replace(/"result":"0x[0-9a-f]+"/, '"result":"0x1"');
        response.writeHead(200, { ...CORS, 'content-type': 'application/json' }).end(text);
      })();
    });
  });
  const rpcOrigin = await listen(proxy);
  mutable.rpcUrl = `${rpcOrigin}/`;
  mutable.hostConfig = (overrides = {}) => ({
    deployments: [{ policy: chain.policy, rpcUrl: `${rpcOrigin}/` }],
    packageOrigins: [pageOrigin],
    allowLoopbackHttp: true,
    ...overrides,
  });
  mutable.stop = async () => {
    for (const server of [pageServer, otherServer, proxy]) server.closeAllConnections();
    await Promise.all(
      [pageServer, otherServer, proxy].map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
    await chain.stop();
  };
  return fixture;
}

/** A plain HTML page: one registration module and the given element markup. */
export function pageHtml(
  hostConfig: unknown,
  elements: string,
  options: { readonly bundle?: string; readonly extraScript?: string } = {},
): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>embed test</title>
<script type="module">
  import { registerProofOfReviewStatus } from '${options.bundle ?? '/embed.js'}';
  window.registration = registerProofOfReviewStatus(${JSON.stringify(hostConfig)});
  ${options.extraScript ?? ''}
</script>
${elements}`;
}

export const packageBytes = (prepared: PreparedReviewPackage): Uint8Array => exportBytes(prepared);
