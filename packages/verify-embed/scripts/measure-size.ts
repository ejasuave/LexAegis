/**
 * pnpm --filter @lexaegis/verify-embed size: measures the shipped browser module including every
 * bundled dependency (protocol, SDK, zod, viem helpers). Reports raw bytes (the unminified bundle),
 * minified bytes and gzip bytes (level 9) of the minified module. No target is asserted.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const raw = readFileSync(join(dist, 'proof-of-review-embed.js'));
const minified = readFileSync(join(dist, 'proof-of-review-embed.min.js'));
const gzip = gzipSync(minified, { level: 9 });
const viteVersion = (
  JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'vite', 'package.json'),
      'utf8',
    ),
  ) as { version: string }
).version;
console.log(
  JSON.stringify({
    tool: `vite ${viteVersion} (library mode, ES, target es2022); gzip via node:zlib level 9`,
    node: process.version,
    rawBytes: raw.byteLength,
    minifiedBytes: minified.byteLength,
    gzipBytes: gzip.byteLength,
  }),
);
