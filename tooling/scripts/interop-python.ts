/**
 * Cross-language interoperability check: the TypeScript implementation and the independent Python
 * checker both process every published case, and both are compared with the frozen expectations.
 * Neither side computes the expected values. Fails closed when Python is unavailable.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './lib';

const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
if (python.status !== 0) {
  console.error('UNAVAILABLE: python3 was not found; the interoperability check did not run');
  process.exit(2);
}

const outcomes = spawnSync(
  'pnpm',
  ['--filter', '@lexaegis/protocol', '--silent', 'vectors:ts-outcomes'],
  {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  },
);
if (outcomes.status !== 0) {
  console.error('the TypeScript outcomes could not be produced');
  process.exit(2);
}

const directory = mkdtempSync(join(tmpdir(), 'interop-'));
try {
  const file = join(directory, 'ts-outcomes.json');
  writeFileSync(file, outcomes.stdout);
  const run = spawnSync(
    'python3',
    ['-I', join(ROOT, 'examples', 'python-verify', 'verify_vectors.py'), '--ts-outcomes', file],
    { cwd: ROOT, encoding: 'utf8' },
  );
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exit(run.status ?? 2);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
