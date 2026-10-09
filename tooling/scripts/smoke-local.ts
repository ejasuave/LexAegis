/** pnpm smoke:local: thin wrapper over the shared step registry. Never reports success it did not observe. */
import { join } from 'node:path';
import { readState, recordEvidence, writeAtomic } from '../src/evidence-writer';
import { planSmoke, renderStepTable, type StepStatus } from '../src/smoke-steps';
import { ROOT, stamp } from './lib';

const state = readState(ROOT);
const chapters = state.chapters as { id: string; state: string }[];
const completed = new Set(chapters.filter((c) => c.state === 'complete').map((c) => c.id));

// Browser drivers are registered here as their chapters land. None exist yet, so none is claimed.
const drivers = new Map<string, StepStatus>();
const now = new Date().toISOString();
const report = planSmoke({ completedChapters: completed, drivers, now });

console.log(renderStepTable(report));
console.log(
  '\nComponents: local scripted harness only; no virtual authenticator, replay provider or test signer is in use. Local success could not pass live Gates B or C.',
);

const artifact = {
  schema: 'lexaegis.smoke-local.v1',
  generatedAt: now,
  status: report.status,
  steps: report.steps,
};
await writeAtomic(join(ROOT, 'docs', 'smoke-local-result.json'), JSON.stringify(artifact));
await recordEvidence({
  root: ROOT,
  results: [
    stamp({
      id: `smoke-local-${now.replace(/\D/g, '').slice(0, 14)}`,
      subject: 'smoke-local',
      command: 'pnpm smoke:local',
      evidenceClass: 'local_scripted',
      outcome:
        report.status === 'passed' ? 'pass' : report.status === 'failed' ? 'fail' : 'pending',
      reasonCodes: report.status === 'passed' ? [] : ['PENDING_STEPS'],
      evidenceRefs: [{ type: 'path', value: 'docs/smoke-local-result.json' }],
      facts: {
        stepsPassed: String(report.steps.filter((s) => s.status === 'passed').length),
        stepsTotal: String(report.steps.length),
      },
    }),
  ],
});
process.exit(report.status === 'passed' ? 0 : 1);
