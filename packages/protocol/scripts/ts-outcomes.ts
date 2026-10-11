/**
 * Prints what the TypeScript implementation produces for every published case, as one JSON object
 * keyed by case ID. It computes no expectation. The Python checker reads this file to compare the
 * two implementations (see examples/python-verify).
 *
 *   tsx scripts/ts-outcomes.ts > outcomes.json
 */
import { readFileSync } from 'node:fs';
import { ASSET_PATH } from './test-vectors';
import { outcomeOf, type VectorCase } from '../src/interop/run-case';

const asset = JSON.parse(readFileSync(ASSET_PATH, 'utf8')) as { cases: VectorCase[] };
const outcomes: Record<string, unknown> = {};
for (const vector of asset.cases) outcomes[vector.id] = await outcomeOf(vector);
process.stdout.write(`${JSON.stringify(outcomes)}\n`);
