/**
 * LOCAL-ONLY generator and server for examples/embed. Starts a throwaway Anvil chain, deploys the
 * unchanged registry, issues SYNTHETIC receipts with Anvil's published development key (kept in this
 * test harness, never in the widget bundle), writes examples/embed/generated/, and serves it.
 *
 *   pnpm embed:example            build the widget, generate, serve until interrupted
 *   pnpm embed:example --no-serve generate and exit (the chain stops with the process)
 *
 * The generated page is a local example: the chain, registry and receipts exist only while this
 * process runs. Nothing here touches a public network.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import { prepareLocalPackage } from '../integration/harness';
import { exportBytes, startLocalRegistry, type LocalRegistry } from '../integration/local-registry';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exampleDir = join(repository, 'examples', 'embed');
const distDir = join(repository, 'packages', 'verify-embed', 'dist');

export interface GeneratedExample {
  readonly outDir: string;
  readonly chain: LocalRegistry;
  readonly references: Record<'active' | 'revoked' | 'superseded' | 'notFound', ReceiptReferenceV1>;
  stop(): Promise<void>;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
};

/** Serves a directory with CORS for the deliberately public synthetic packages. Loopback only. */
export function serveDirectory(
  root: string,
  port = 0,
): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    const relative = path === '/' ? 'index.html' : path.slice(1);
    const file = resolve(root, relative);
    if (!file.startsWith(`${root}/`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      response
        .writeHead(200, {
          'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
          'access-control-allow-origin': '*',
        })
        .end(readFileSync(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolveServer) =>
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actual = typeof address === 'object' && address !== null ? address.port : port;
      resolveServer({ server, origin: `http://127.0.0.1:${String(actual)}` });
    }),
  );
}

export interface SyntheticChain {
  readonly chain: LocalRegistry;
  readonly references: GeneratedExample['references'];
  /** The deliberately public synthetic readable export of the Active receipt. */
  readonly activeExport: Uint8Array;
}

/** A throwaway chain with the unchanged registry and one receipt in each lifecycle state. */
export async function startSyntheticChain(): Promise<SyntheticChain> {
  const chain = await startLocalRegistry();
  const make = (
    supersedes: ReceiptReferenceV1 | null = null,
    caseId: 'legal' | 'legal-revised' = 'legal',
  ) => prepareLocalPackage(caseId, chain.binding, supersedes);
  const active = await make();
  const revoked = await make();
  const superseded = await make();
  const replacement = await make(superseded.reference, 'legal-revised');
  const notFound = await make();
  await chain.issue(active);
  await chain.issue(revoked);
  await chain.revoke(revoked.reference);
  await chain.issue(superseded);
  await chain.supersede(superseded.reference, replacement);
  await chain.mine();
  return {
    chain,
    references: {
      active: active.reference,
      revoked: revoked.reference,
      superseded: superseded.reference,
      notFound: notFound.reference,
    },
    activeExport: exportBytes(active),
  };
}

export async function generateEmbedExample(options: {
  /** The origin the page and its package will be served from: the host's one approved package origin. */
  readonly origin: string;
  readonly outDir?: string;
  readonly build?: boolean;
}): Promise<GeneratedExample> {
  if (options.build !== false)
    execFileSync('pnpm', ['--filter', '@lexaegis/verify-embed', 'build'], {
      cwd: repository,
      stdio: 'ignore',
    });
  const outDir = options.outDir ?? join(exampleDir, 'generated');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'packages'), { recursive: true });

  const { chain, references, activeExport } = await startSyntheticChain();
  writeFileSync(join(outDir, 'packages', 'active.json'), activeExport);

  // The widget bundle is copied unchanged. No signer, key or test helper is in it.
  copyFileSync(
    join(distDir, 'proof-of-review-embed.min.js'),
    join(outDir, 'proof-of-review-embed.min.js'),
  );
  const hostConfig = {
    deployments: [{ policy: chain.policy, rpcUrl: `${chain.local.rpcUrl}/` }],
    // The page and its package share an origin; the host approves exactly that one.
    packageOrigins: [options.origin],
    allowLoopbackHttp: true,
  };
  writeFileSync(
    join(outDir, 'register.js'),
    `// Generated by pnpm embed:example. The host configuration is the ONLY source of trust:\n` +
      `// the registry deployment record and the RPC endpoint below come from this local setup,\n` +
      `// not from the markup. allowLoopbackHttp is for this local example only.\n` +
      `import { registerProofOfReviewStatus } from './proof-of-review-embed.min.js';\n\n` +
      `registerProofOfReviewStatus(${JSON.stringify(hostConfig, null, 2)});\n`,
  );
  const template = readFileSync(join(exampleDir, 'index.html'), 'utf8');
  const html = template.replace(/\{\{(\w+)\.(\w+)\}\}/g, (_match, name: string, field: string) => {
    if (name === 'packageUrl') return `${options.origin}/packages/${field}.json`;
    const reference = references[name as keyof typeof references];
    const values: Record<string, string> = {
      chainId: reference.chainId,
      registry: reference.registryAddress,
      reviewer: reference.reviewerAddress,
      commitment: reference.commitment,
    };
    return values[field] ?? '';
  });
  writeFileSync(join(outDir, 'index.html'), html);
  return { outDir, chain, references, stop: () => chain.stop() };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.EMBED_EXAMPLE_PORT ?? '5180');
  const origin = `http://127.0.0.1:${String(port)}`;
  const outDir = join(exampleDir, 'generated');
  const generated = await generateEmbedExample({ origin, outDir });
  if (process.argv.includes('--no-serve')) {
    console.log(`Generated ${outDir} (the local chain stops when this command exits).`);
    await generated.stop();
    process.exit(0);
  }
  await serveDirectory(outDir, port);
  console.log(
    `Local example (throwaway chain ${generated.chain.binding.chainId}, registry ${generated.chain.registry}):`,
  );
  console.log(`  ${origin}/index.html`);
  console.log('The chain and receipts exist only while this process runs. Press Ctrl-C to stop.');
  const stop = (): void => {
    void generated.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
