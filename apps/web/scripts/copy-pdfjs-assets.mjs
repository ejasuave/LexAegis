// Copies the pinned pdf.js character maps and standard fonts into public/pdfjs so the parser
// loads them from this origin. Nothing is fetched from a third party and nothing is committed.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('pdfjs-dist/package.json'));
const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'pdfjs');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts'])
  cpSync(join(root, dir), join(target, dir), { recursive: true });
process.stdout.write('pdf.js assets copied to public/pdfjs\n');
