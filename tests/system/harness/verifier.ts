import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { repository } from './services';

/** Builds the standalone verifier for a loopback test chain and serves it from its own origin. */
export function buildVerifier(
  outDir: string,
  mode: 'loopback-test' | 'production',
  env: Record<string, string>,
): void {
  execFileSync(
    'pnpm',
    [
      'exec',
      'vite',
      'build',
      '--mode',
      mode,
      '--outDir',
      outDir,
      '--emptyOutDir',
      '--logLevel',
      'error',
    ],
    { cwd: join(repository, 'apps', 'verifier'), env: { ...process.env, ...env }, stdio: 'ignore' },
  );
}

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

export function serveStatic(root: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    const file = resolve(root, path === '/' ? 'index.html' : path.slice(1));
    try {
      if (!file.startsWith(`${root}/`)) throw new Error('outside');
      response
        .writeHead(200, {
          'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
          // Hashed build output is immutable, as a real static host serves it.
          ...(path.startsWith('/assets/') && {
            'cache-control': 'public, max-age=31536000, immutable',
          }),
        })
        .end(readFileSync(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      done({
        server,
        origin: `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`,
      });
    }),
  );
}
