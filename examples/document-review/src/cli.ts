import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { prepareExample } from './prepare.js';
import { verifyExample } from './verify.js';

/** The largest file the example will read (the protocol's 48 MiB bundle limit). */
const MAX_FILE_BYTES = 48 * 1024 * 1024;

function readBounded(path: string): Uint8Array {
  // Paths come only from explicit command-line arguments, and the size is checked before reading.
  if (statSync(path).size > MAX_FILE_BYTES) throw new Error('file is larger than the 48 MiB limit');
  return readFileSync(path);
}

const readJson = (path: string): unknown => JSON.parse(new TextDecoder().decode(readBounded(path)));

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'prepare') {
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: 'string' },
      'chain-id': { type: 'string' },
      registry: { type: 'string' },
      reviewer: { type: 'string' },
      nonce: { type: 'string' },
      deadline: { type: 'string' },
    },
  });
  const { out, registry, reviewer } = values;
  const chainId = values['chain-id'];
  if (
    out === undefined ||
    chainId === undefined ||
    registry === undefined ||
    reviewer === undefined
  ) {
    fail(
      'usage: prepare --out <dir> --chain-id <id> --registry <0x..> --reviewer <0x..> [--nonce <n> --deadline <unix>]',
    );
  }
  const result = await prepareExample({
    chainId,
    registryAddress: registry,
    reviewerAddress: reviewer,
    ...(values.nonce !== undefined && { nonce: values.nonce }),
    ...(values.deadline !== undefined && { deadline: values.deadline }),
  }).catch((error: unknown) => fail(error instanceof Error ? error.message : 'failed'));
  mkdirSync(out, { recursive: true });
  const files = ['review-export.json', 'receipt-reference.json'];
  writeFileSync(join(out, 'review-export.json'), result.exportBytes);
  writeFileSync(
    join(out, 'receipt-reference.json'),
    `${JSON.stringify(result.reference, null, 2)}\n`,
  );
  if (result.typedData !== null) {
    writeFileSync(
      join(out, 'issue-typed-data.json'),
      `${JSON.stringify(result.typedData, null, 2)}\n`,
    );
    files.push('issue-typed-data.json');
  }
  // Only the public reference is printed. The opening and documents are in review-export.json.
  process.stdout.write(
    `${JSON.stringify({ status: 'prepared, not approved, not issued', reference: result.reference, files }, null, 2)}\n`,
  );
} else if (command === 'verify') {
  const { values } = parseArgs({
    args: rest,
    options: {
      bundle: { type: 'string' },
      'expected-reference': { type: 'string' },
      policy: { type: 'string' },
      reviewers: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const bundle = values.bundle;
  const expected = values['expected-reference'];
  if (bundle === undefined || expected === undefined) {
    fail(
      'usage: verify --bundle <file> --expected-reference <file> [--policy <file>] [--reviewers <file>] [--out <file>]',
    );
  }
  // The RPC address is operator configuration, never an argument. A public address only.
  const rpcUrl = process.env.REVIEW_RPC_URL;
  const live =
    rpcUrl !== undefined && rpcUrl !== '' && values.policy !== undefined
      ? { rpcUrl, policy: readJson(values.policy) }
      : undefined;
  const reviewers =
    values.reviewers === undefined
      ? undefined
      : new TextDecoder()
          .decode(readBounded(values.reviewers))
          .split(/\s+/)
          .filter((line) => line !== '');
  const output = await verifyExample({
    bundle: readBounded(bundle),
    expectedReference: readJson(expected),
    ...(live !== undefined && { live }),
    ...(reviewers !== undefined && { reviewers }),
  });
  if (!output.ok) fail(`could not verify: ${output.code}`);
  const text = `${JSON.stringify(output.report, null, 2)}\n`;
  if (values.out === undefined) process.stdout.write(text);
  else writeFileSync(values.out, text);
} else {
  fail('commands: prepare, verify');
}
