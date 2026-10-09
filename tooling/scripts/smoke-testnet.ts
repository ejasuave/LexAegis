/**
 * pnpm smoke:testnet [--operator-start]
 * Manual live harness. Default is a read-only preflight that prints the planned synthetic steps.
 * It refuses CI, mainnet, unknown targets and any simulated dependency, and it never runs just
 * because an assistant is working on the repository.
 */
import { guardsPass, preflightTestnet, remainingSteps } from '../src/guards';
import { recordEvidence } from '../src/evidence-writer';
import { SMOKE_STEPS, planSmoke, renderStepTable } from '../src/smoke-steps';
import { readState } from '../src/evidence-writer';
import { ROOT, stamp } from './lib';

const argv = process.argv.slice(2);
const guards = preflightTestnet(process.env, argv);
for (const guard of guards)
  console.log(
    `${guard.ok ? 'ok     ' : 'REFUSED'} ${guard.id.padEnd(20)} ${guard.ok ? '' : guard.reason}`,
  );

console.log(
  '\nPlanned synthetic steps (each needs a person at the keyboard: passkey, disclosure, review, approval, fee confirmation):',
);
const chapters = readState(ROOT).chapters as { id: string; state: string }[];
const completed = new Set(chapters.filter((c) => c.state === 'complete').map((c) => c.id));
const plan = planSmoke({
  completedChapters: completed,
  drivers: new Map(),
  now: new Date().toISOString(),
});
console.log(renderStepTable(plan));
console.log(
  `\nSteps remaining on a resume: ${remainingSteps({ runId: 'preflight', completed: {} }).length} of ${String(SMOKE_STEPS.length)}`,
);

if (!argv.includes('--operator-start')) {
  console.log('\nPreflight only. Nothing was started, signed, funded or sent.');
  process.exit(guardsPass(guards.filter((g) => g.id !== 'operator-start')) ? 0 : 1);
}
if (!guardsPass(guards)) process.exit(1);

// Guards passed, but the live journey needs features that do not exist yet. Record what is true.
await recordEvidence({
  root: ROOT,
  results: [
    stamp({
      id: `smoke-testnet-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
      subject: 'smoke-testnet',
      command: 'pnpm smoke:testnet --operator-start',
      evidenceClass: 'live_testnet',
      outcome: 'blocked',
      reasonCodes: ['PREREQUISITES_PENDING'],
      facts: { chainId: '10143', stepsCompleted: '0', stepsTotal: String(SMOKE_STEPS.length) },
    }),
  ],
});
console.log(
  '\nBlocked: the live journey cannot start until its prerequisite chapters are complete. Nothing was simulated.',
);
process.exit(1);
