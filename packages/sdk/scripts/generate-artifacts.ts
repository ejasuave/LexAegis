/**
 * Writes (or with --check, verifies) the SDK's generated JSON Schemas in packages/sdk/schemas/v1.
 * Content comes from the implementation's own schemas, so these files cannot drift silently.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { registryPolicySchema, verificationReportV1Schema } from '../src/verification/report';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'v1');
const check = process.argv.includes('--check');

const DEFINITIONS = [
  {
    file: 'verification-report.schema.json',
    id: 'urn:lexaegis:sdk:v1:verification-report',
    title: 'VerificationReportV1',
    schema: verificationReportV1Schema,
    comment:
      'An observation, not a certificate. There is no combined valid field. Integrity checks are match, mismatch or unknown; a report says nothing about evidence truth, human conduct or legal correctness (profileSemantics is not_evaluated).',
  },
  {
    file: 'registry-policy.schema.json',
    id: 'urn:lexaegis:sdk:v1:registry-policy',
    title: 'RegistryPolicy',
    schema: registryPolicySchema,
    comment:
      'Trusted caller configuration for live checks. A package can never supply or change it. Public fields only.',
  },
] as const;

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

let stale = 0;
mkdirSync(outDir, { recursive: true });
for (const definition of DEFINITIONS) {
  const { $schema, ...body } = z.toJSONSchema(definition.schema, { target: 'draft-2020-12' });
  const expected = `${JSON.stringify({ $schema, $id: definition.id, title: definition.title, $comment: definition.comment, ...body }, null, 2)}\n`;
  const path = join(outDir, definition.file);
  if (!check) {
    writeFileSync(path, expected);
    console.log(`wrote schemas/v1/${definition.file}`);
    continue;
  }
  const actual = readOrNull(path);
  if (actual !== expected) {
    stale += 1;
    console.error(`STALE schemas/v1/${definition.file}: run "pnpm sdk:generate"`);
  }
}
if (check) {
  if (stale > 0) process.exit(1);
  console.log('generated SDK artifacts are up to date');
}
