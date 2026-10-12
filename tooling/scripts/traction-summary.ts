/**
 * pnpm traction:summary: validates docs/adoption/traction-log.md and prints counts per current status,
 * split by internal/external origin and audience, with evidence-reviewed and pending kept apart.
 *
 *   pnpm traction:summary [--log <file>] [--today YYYY-MM-DD] [--json]
 *
 * Read-only and offline. Exit 0: the log is valid (an empty log is valid). Exit 1: a malformed or
 * insufficiently evidenced row (reported by line number and code only, never subject, link or path).
 * Exit 2: usage. It never prints names, contact details, quotes, restricted links or private paths.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseTractionLog, renderSummary, summarize, validateTractionLog } from '../src/traction';
import { ROOT } from './lib';

const { values } = parseArgs({
  options: {
    log: { type: 'string' },
    today: { type: 'string' },
    json: { type: 'boolean' },
    root: { type: 'string' },
  },
});
const root = values.root ?? ROOT;
const today = values.today ?? new Date().toISOString().slice(0, 10);
let text: string;
try {
  text = readFileSync(values.log ?? join(root, 'docs', 'adoption', 'traction-log.md'), 'utf8');
} catch {
  process.stderr.write('cannot read the traction log\n');
  process.exit(2);
}
const result = validateTractionLog(parseTractionLog(text), { today, root });
if (result.problems.length > 0) {
  for (const problem of result.problems)
    process.stderr.write(`line ${String(problem.line)}: ${problem.code}\n`);
  process.stderr.write(`${String(result.problems.length)} problem(s): nothing is counted\n`);
  process.exit(1);
}
const summary = summarize(result.rows, today);
process.stdout.write(
  values.json === true ? `${JSON.stringify(summary, null, 2)}\n` : renderSummary(summary),
);
