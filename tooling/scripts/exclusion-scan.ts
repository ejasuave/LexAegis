/** Production exclusion: built artifacts and the production import graph contain no test paths. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scanArtifacts, scanImportGraph, type Finding } from '../src/exclusion';
import { ROOT } from './lib';

const artifactRoots = ['apps/web/.next/static', 'apps/web/.next/server', 'apps/verifier/dist'].map(
  (p) => join(ROOT, p),
);
const missing = artifactRoots.filter((root) => !existsSync(root));
if (missing.length > 0) {
  console.error(
    `ARTIFACTS_MISSING: ${missing.map((m) => m.replace(`${ROOT}/`, '')).join(', ')} (run pnpm build first)`,
  );
  process.exit(2);
}

// The registry fixture key is read at scan time and never printed.
const vectors = JSON.parse(
  readFileSync(join(ROOT, 'fixtures/registry-v1/vectors.json'), 'utf8'),
) as { signer: { privateKey: string } };
const findings: Finding[] = scanArtifacts(artifactRoots, {
  extraSecrets: [vectors.signer.privateKey],
});

function* routeFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* routeFiles(path);
    else if (/^(page|layout|route)\.tsx?$/.test(entry.name)) yield path;
  }
}

findings.push(
  ...scanImportGraph({
    root: ROOT,
    entries: [...routeFiles(join(ROOT, 'apps/web/src/app'))],
    alias: new Map([['@/', join(ROOT, 'apps/web/src')]]),
  }),
  ...scanImportGraph({ root: ROOT, entries: [join(ROOT, 'apps/verifier/src/main.tsx')] }),
);

for (const pkg of ['protocol', 'sdk', 'vault', 'agent']) {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, 'packages', pkg, 'package.json'), 'utf8'),
  ) as { exports: Record<string, unknown> };
  const entries = Object.values(manifest.exports)
    .filter((v): v is string => typeof v === 'string' && v.endsWith('.ts'))
    .map((v) => join(ROOT, 'packages', pkg, v));
  findings.push(...scanImportGraph({ root: ROOT, entries }));
}

for (const finding of findings) console.error(`${finding.rule}  ${finding.file}`);
console.log(
  findings.length === 0
    ? 'production exclusion: clean (web client/server output, verifier output, package and app import graphs)'
    : `${findings.length} finding(s)`,
);
process.exit(findings.length === 0 ? 0 : 1);
