/**
 * LOCAL-ONLY isolated harness for the widget path of docs/QUICKSTART.md. Starts a throwaway Anvil
 * chain with the unchanged registry and real local receipts (active, revoked, superseded, never
 * issued), writes what a host page needs to <dir>/harness.json, and stays up until <dir>/stop exists
 * or it is interrupted. It serves nothing and needs no LexAegis application, login or backend.
 *
 *   pnpm embed:harness <directory>
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startSyntheticChain } from './embed-example';

const directory = resolve(process.argv[2] ?? '');
if (process.argv[2] === undefined) {
  process.stderr.write('usage: pnpm embed:harness <directory>\n');
  process.exit(2);
}
mkdirSync(join(directory, 'packages'), { recursive: true });
const { chain, references, activeExport } = await startSyntheticChain();
writeFileSync(join(directory, 'packages', 'active.json'), activeExport);
writeFileSync(
  join(directory, 'harness.json'),
  `${JSON.stringify(
    {
      note: 'LOCAL throwaway chain and SYNTHETIC receipts. Not a live deployment.',
      hostConfig: {
        deployments: [{ policy: chain.policy, rpcUrl: `${chain.local.rpcUrl}/` }],
        allowLoopbackHttp: true,
      },
      references,
    },
    null,
    2,
  )}\n`,
);
process.stdout.write('harness ready\n');

const stop = async (): Promise<never> => {
  await chain.stop();
  return process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
while (!existsSync(join(directory, 'stop'))) await new Promise((done) => setTimeout(done, 200));
await stop();
