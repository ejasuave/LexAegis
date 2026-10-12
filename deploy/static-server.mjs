// Minimal static server for the verifier: route fallback, MIME types and security headers.
// No dependencies, no application session, no cookies.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const root = join(process.cwd(), 'dist');
const port = Number(process.env.PORT ?? 8080);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const security = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

async function resolveFile(pathname) {
  const decoded = decodeURIComponent(pathname);
  const candidate = normalize(join(root, decoded));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  try {
    const info = await stat(candidate);
    if (info.isFile()) return candidate;
  } catch {
    /* fall through to the route fallback */
  }
  // Assets with an extension that are missing are a 404; extensionless routes get the app shell.
  return extname(decoded) === '' ? join(root, 'index.html') : null;
}

createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', ...security }).end();
      return;
    }
    const { pathname } = new URL(req.url ?? '/', 'http://local');
    if (pathname === '/healthz') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...security,
      });
      res.end(
        JSON.stringify({ status: 'ok', release: process.env.LEXAEGIS_RELEASE_ID ?? 'unset' }),
      );
      return;
    }
    const file = await resolveFile(pathname);
    if (file === null) {
      res
        .writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...security })
        .end('Not found');
      return;
    }
    const body = await readFile(file);
    const immutable = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...security,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res
      .writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', ...security })
      .end('Bad request');
  }
}).listen(port, '0.0.0.0');
