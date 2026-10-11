/**
 * SHA-256 baselines of protected protocol, vector, registry and ABI files.
 *   tsx baselines.ts --write      record docs/protected-baselines.json (refuses to overwrite)
 *   tsx baselines.ts --check      compare the working tree with the recorded baseline
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ROOT } from './lib';

const PROTECTED = [
  'fixtures/protocol-v1',
  'fixtures/registry-v1',
  'packages/protocol/src/v1',
  'packages/protocol/schemas/v1',
  'contracts/src',
  'contracts/artifacts/registry-v1.json',
  'contracts/foundry.toml',
  'contracts/toolchain.json',
  'packages/sdk/src/registry/generated/registry-abi.ts',
];
const COMPILED = 'contracts/out/ProofOfReviewRegistry.sol/ProofOfReviewRegistry.json';
const BASELINE = join(ROOT, 'docs', 'protected-baselines.json');
/** Additive extensions: exact hashes of files a later chapter added or extended. The baseline is never rewritten. */
const ADDITIONS = join(ROOT, 'docs', 'protected-baseline-additions.json');

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function* walk(path: string): Generator<string> {
  if (statSync(path).isFile()) {
    yield path;
    return;
  }
  for (const entry of readdirSync(path).sort()) yield* walk(join(path, entry));
}

function current() {
  const files: Record<string, string> = {};
  for (const item of PROTECTED) {
    for (const file of walk(join(ROOT, item)))
      files[relative(ROOT, file).split(sep).join('/')] = sha(readFileSync(file));
  }
  let compiled: { abiSha256: string; deployedBytecodeSha256: string } | null = null;
  if (existsSync(join(ROOT, COMPILED))) {
    const artifact = JSON.parse(readFileSync(join(ROOT, COMPILED), 'utf8')) as {
      abi: unknown;
      deployedBytecode: { object: string };
    };
    compiled = {
      abiSha256: sha(JSON.stringify(artifact.abi)),
      deployedBytecodeSha256: sha(artifact.deployedBytecode.object),
    };
  }
  return { files, compiled };
}

const now = current();
if (process.argv.includes('--write')) {
  if (existsSync(BASELINE))
    throw new Error('baseline already recorded; it is never rewritten to hide a change');
  writeFileSync(
    BASELINE,
    `${JSON.stringify({ schema: 'lexaegis.protected-baselines.v1', recordedAt: new Date().toISOString(), compiledArtifact: COMPILED, ...now }, null, 2)}\n`,
  );
  console.log(
    `recorded ${Object.keys(now.files).length} protected files${now.compiled ? ' and the compiled registry' : ' (compiled registry unavailable)'}`,
  );
} else {
  const recorded = JSON.parse(readFileSync(BASELINE, 'utf8')) as {
    files: Record<string, string>;
    compiled: typeof now.compiled;
  };
  const additions = existsSync(ADDITIONS)
    ? (JSON.parse(readFileSync(ADDITIONS, 'utf8')) as { files: Record<string, { sha256: string }> })
        .files
    : {};
  // An addition is accepted only at its recorded hash; any further edit is a problem again.
  const accepted = (file: string) => additions[file]?.sha256 === now.files[file];
  const problems: string[] = [];
  for (const [file, hash] of Object.entries(recorded.files)) {
    if (now.files[file] === undefined) problems.push(`MISSING ${file}`);
    else if (now.files[file] !== hash && !accepted(file)) problems.push(`CHANGED ${file}`);
  }
  for (const file of Object.keys(now.files))
    if (recorded.files[file] === undefined && !accepted(file)) problems.push(`ADDED ${file}`);
  if (now.compiled === null)
    problems.push('UNVERIFIED compiled registry artifact is missing (not evidence of equality)');
  else if (JSON.stringify(now.compiled) !== JSON.stringify(recorded.compiled))
    problems.push('CHANGED compiled registry ABI or bytecode');
  for (const problem of problems) console.error(problem);
  console.log(
    problems.length === 0
      ? `protected baselines match (${Object.keys(recorded.files).length} files, compiled registry)`
      : `${problems.length} problem(s)`,
  );
  process.exit(problems.length === 0 ? 0 : 1);
}
