/**
 * Writes (or with --check, verifies) the generated JSON Schemas and protocol descriptor in
 * packages/protocol/schemas/v1. Content comes from the implementation's own schemas and
 * constants, so these files cannot drift silently.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGeneratedFiles, serializeGeneratedFile } from '../src/v1/json-schema';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'v1');
const check = process.argv.includes('--check');
let stale = 0;

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

mkdirSync(outDir, { recursive: true });
for (const [file, content] of Object.entries(buildGeneratedFiles())) {
  const path = join(outDir, file);
  const expected = serializeGeneratedFile(content);
  if (!check) {
    writeFileSync(path, expected);
    console.log(`wrote schemas/v1/${file}`);
    continue;
  }
  const actual = readOrNull(path);
  if (actual !== expected) {
    stale += 1;
    console.error(`STALE schemas/v1/${file}: run "pnpm protocol:generate"`);
  }
}

if (check) {
  if (stale > 0) process.exit(1);
  console.log('generated protocol artifacts are up to date');
}
