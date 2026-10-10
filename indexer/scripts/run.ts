import { spawn } from 'node:child_process';
import { readOrCreateGeneration } from './generation';
import { indexerRoot } from './binding';

/** Starts the pinned Envio CLI with the persisted generation. Never resets anything. */
const mode = process.argv[2];
if (mode !== 'dev' && mode !== 'start') {
  console.error('usage: run.ts dev|start');
  process.exit(2);
}
const generation = readOrCreateGeneration();
const child = spawn('pnpm', ['exec', 'envio', mode], {
  cwd: indexerRoot,
  stdio: 'inherit',
  env: { ...process.env, ENVIO_INDEX_GENERATION: generation },
});
child.on('exit', (code) => process.exit(code ?? 1));
