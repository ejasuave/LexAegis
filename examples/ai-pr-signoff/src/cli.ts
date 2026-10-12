import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { createPublicClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseReceiptReference } from '@lexaegis/protocol/v1';
import { proofOfReviewRegistryAbi } from '@lexaegis/sdk/registry';
import { FULL_DISCLOSURE_NOTICE, buildReadableExport } from './export.js';
import { TARGET_MODES, checkTarget, type TargetMode } from './guards.js';
import { INPUT_LIMITS, readBoundedFile } from './inputs.js';
import {
  createFilePendingLog,
  issueSignoff,
  type Confirmations,
  type SignoffPreview,
} from './issue.js';
import { inputDigests, prepareSignoffPackage } from './package.js';
import {
  createDirectoryStore,
  generateStorageKey,
  parseStorageKey,
  type EvidenceStore,
} from './storage.js';
import { viemChainAccess } from './chain.js';
import { verifySignoff } from './verify.js';

/*
 * Commands (see README.md):
 *   hash      print the SHA-256 digests the decision file must contain
 *   keygen    print a new random storage key (never written to disk)
 *   prepare   build the package, preserve it encrypted, print the PUBLIC reference. Issues nothing.
 *   issue     the explicit, guarded, two-confirmation public write. Needs --broadcast.
 *   verify    read-only check of a readable export against a reference you were given
 *   export    explicit, labelled full-disclosure readable export of a preserved package
 * Secrets come from environment variables only, never from arguments:
 *   AI_PR_SIGNOFF_STORAGE_KEY   prepare, issue, export (32 random bytes, base64url)
 *   AI_PR_SIGNOFF_OPERATOR_KEY  issue ONLY (a dedicated synthetic testnet operator key)
 *   AI_PR_SIGNOFF_RPC_URL       issue, verify (public endpoint, no credentials)
 */

const MAX_JSON_BYTES = 256 * 1024;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readJson(path: string): unknown {
  const file = readBoundedFile(path, MAX_JSON_BYTES);
  if (!file.ok) fail(`cannot read ${path}: ${file.code}`);
  try {
    return JSON.parse(new TextDecoder().decode(file.bytes));
  } catch {
    return fail(`${path} is not JSON`);
  }
}

function required<T>(value: T | undefined, usage: string): T {
  if (value === undefined) return fail(`usage: ${usage}`);
  return value;
}

async function openStore(directory: string, owner: string): Promise<EvidenceStore> {
  const text = process.env.AI_PR_SIGNOFF_STORAGE_KEY;
  if (text === undefined)
    return fail('set AI_PR_SIGNOFF_STORAGE_KEY (run `keygen` once and keep it)');
  const key = parseStorageKey(text);
  if (key === null) return fail('AI_PR_SIGNOFF_STORAGE_KEY must be 32 random bytes, base64url');
  const store = await createDirectoryStore(directory, key, owner);
  if (!store.ok) return fail(`storage unavailable: ${store.code}`);
  return store.data;
}

const sentence = (preview: SignoffPreview): string =>
  [
    'EXACT PACKAGE (this is what you would approve):',
    ...preview.files.map(
      (file) =>
        `  - ${file.label ?? '(unlabelled)'} [${file.role}, ${file.mediaType}, ${file.byteLength} bytes]`,
    ),
    `  profile: ${preview.profile.id} v${preview.profile.version}`,
    `  chain ${preview.reference.chainId}, registry ${preview.reference.registryAddress}`,
    `  reviewer ${preview.reviewerAddress}`,
    `  commitment ${preview.reference.commitment}`,
    `  action ${preview.action}, registry nonce ${preview.registryNonce}, deadline ${preview.deadline}, value ${preview.valueWei}`,
  ].join('\n');

/** Two separate typed confirmations at a terminal. A flag cannot answer them. */
function terminalConfirmations(): Confirmations {
  const ask = async (prompt: string, expected: string): Promise<boolean> => {
    const lines = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await lines.question(
        `${prompt}\nType "${expected}" to continue, anything else cancels: `,
      );
      return answer.trim() === expected;
    } finally {
      lines.close();
    }
  };
  return {
    snapshot: (preview) =>
      ask(
        `${sentence(preview)}\nApproving records that you approve THIS package. It does not show the code is correct or safe.`,
        `approve ${preview.reference.commitment.slice(0, 10)}`,
      ),
    send: (summary) =>
      ask(
        `${sentence(summary)}\ntransaction ${summary.transactionHash}\nmaximum fee ${summary.maxFeeWei.toString()} wei. The transaction and the registry record are public and cannot be recalled.`,
        `send ${summary.reference.commitment.slice(0, 10)}`,
      ),
  };
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'hash') {
  const { values } = parseArgs({
    args: rest,
    options: { diff: { type: 'string' }, summary: { type: 'string' } },
  });
  const diff = readBoundedFile(
    required(values.diff, 'hash --diff <file> --summary <file>'),
    INPUT_LIMITS.diff,
  );
  const summary = readBoundedFile(
    required(values.summary, 'hash --diff <file> --summary <file>'),
    INPUT_LIMITS.summary,
  );
  if (!diff.ok || !summary.ok) fail('cannot read the inputs');
  process.stdout.write(
    `${JSON.stringify(await inputDigests(diff.bytes, summary.bytes), null, 2)}\n`,
  );
} else if (command === 'keygen') {
  process.stderr.write(
    'New storage key. It protects the preserved package and is NOT stored anywhere: keep it safe.\nIt is separate from every signing key. Losing it makes the preserved package unreadable.\n',
  );
  process.stdout.write(`${generateStorageKey()}\n`);
} else if (command === 'prepare') {
  const usage =
    'prepare --diff <f> --summary <f> --decision <f> --policy <f> --evidence-dir <dir> --out <dir>';
  const { values } = parseArgs({
    args: rest,
    options: {
      diff: { type: 'string' },
      summary: { type: 'string' },
      decision: { type: 'string' },
      policy: { type: 'string' },
      'evidence-dir': { type: 'string' },
      out: { type: 'string' },
    },
  });
  const diff = readBoundedFile(required(values.diff, usage), INPUT_LIMITS.diff);
  const summary = readBoundedFile(required(values.summary, usage), INPUT_LIMITS.summary);
  const decision = readBoundedFile(required(values.decision, usage), INPUT_LIMITS.decision);
  if (!diff.ok || !summary.ok || !decision.ok)
    fail('cannot read the inputs (regular files within the size limits)');
  const policy = readJson(required(values.policy, usage)) as {
    chainId?: string;
    registryAddress?: string;
  };
  let reviewer = '';
  try {
    reviewer =
      (JSON.parse(new TextDecoder().decode(decision.bytes)) as { reviewer?: string }).reviewer ??
      '';
  } catch {
    fail('the decision file is not JSON');
  }
  const prepared = await prepareSignoffPackage(
    { diff: diff.bytes, summary: summary.bytes, decision: decision.bytes },
    {
      chainId: policy.chainId ?? '',
      registryAddress: policy.registryAddress ?? '',
      reviewerAddress: reviewer,
    },
  );
  if (!prepared.ok) fail(`cannot prepare: ${prepared.code}`);
  const store = await openStore(required(values['evidence-dir'], usage), reviewer);
  const saved = await store.save(prepared.prepared);
  if (!saved.ok) fail(`could not preserve the package: ${saved.code}`);
  const out = required(values.out, usage);
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'receipt-reference.json'),
    `${JSON.stringify(prepared.prepared.reference, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ status: 'prepared and preserved (encrypted); NOT approved, NOT issued', reference: prepared.prepared.reference }, null, 2)}\n`,
  );
} else if (command === 'issue') {
  const usage =
    'issue --broadcast --target <monad-testnet|local-loopback> --reference <f> --policy <f> --evidence-dir <dir> --pending-dir <dir>';
  const { values } = parseArgs({
    args: rest,
    options: {
      broadcast: { type: 'boolean' },
      target: { type: 'string' },
      reference: { type: 'string' },
      policy: { type: 'string' },
      'evidence-dir': { type: 'string' },
      'pending-dir': { type: 'string' },
    },
  });
  // --broadcast only ENABLES the guarded workflow below. It is not approval of anything.
  if (values.broadcast !== true) fail(`refusing without --broadcast. ${usage}`);
  const mode = required(values.target, usage) as TargetMode;
  if (!TARGET_MODES.includes(mode)) fail(`--target must be one of: ${TARGET_MODES.join(', ')}`);
  if (mode === 'monad-testnet' && (!process.stdin.isTTY || !process.stderr.isTTY))
    fail('a public issue needs an interactive terminal: it cannot run unattended or in CI');
  const target = checkTarget(
    mode,
    readJson(required(values.policy, usage)),
    process.env.AI_PR_SIGNOFF_RPC_URL ?? '',
  );
  if (!target.ok) fail(`target refused: ${target.code}`);
  const parsedReference = parseReceiptReference(readJson(required(values.reference, usage)));
  if (!parsedReference.ok) fail('the reference file is not a receipt reference');
  const reference = parsedReference.data;
  if (
    reference.chainId !== target.policy.chainId ||
    reference.registryAddress !== target.policy.registryAddress
  )
    fail('the reference names a different chain or registry than the trusted deployment record');
  // The operator key is read here and nowhere else. It is never printed or written.
  const keyText = process.env.AI_PR_SIGNOFF_OPERATOR_KEY;
  if (keyText === undefined || !/^0x[0-9a-fA-F]{64}$/.test(keyText))
    fail('set AI_PR_SIGNOFF_OPERATOR_KEY (a dedicated synthetic testnet operator key)');
  if (keyText === process.env.AI_PR_SIGNOFF_STORAGE_KEY)
    fail('the storage key must differ from the signing key');
  const account = privateKeyToAccount(keyText as Hex);
  const store = await openStore(
    required(values['evidence-dir'], usage),
    account.address.toLowerCase(),
  );
  const publicClient = createPublicClient({ transport: http(target.rpcUrl) });
  const chain = viemChainAccess({
    publicClient,
    executor: account,
    registryAddress: target.policy.registryAddress as Hex,
    chainId: Number(target.policy.chainId),
    live: {
      policy: target.policy,
      transport: {
        kind: 'rpc',
        url: target.rpcUrl,
        ...(mode === 'local-loopback' && { allowLoopbackHttp: true }),
      },
    },
    readNonce: (reviewer) =>
      publicClient.readContract({
        address: target.policy.registryAddress as Hex,
        abi: proofOfReviewRegistryAbi,
        functionName: 'nonceOf',
        args: [reviewer as Hex],
      }),
  });
  const result = await issueSignoff({
    reference,
    signer: {
      address: account.address,
      signTypedData: (typedData) => account.signTypedData(typedData),
    },
    chain,
    store,
    pending: createFilePendingLog(required(values['pending-dir'], usage)),
    confirm: terminalConfirmations(),
  });
  process.stdout.write(
    `${JSON.stringify(result, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`,
  );
  process.exit(result.status === 'confirmed' || result.status === 'already_recorded' ? 0 : 1);
} else if (command === 'verify') {
  const usage = 'verify --export <file> --expected-reference <file> [--policy <file>]';
  const { values } = parseArgs({
    args: rest,
    options: {
      export: { type: 'string' },
      'expected-reference': { type: 'string' },
      policy: { type: 'string' },
      local: { type: 'boolean' },
    },
  });
  const file = readBoundedFile(required(values.export, usage), 48 * 1024 * 1024);
  if (!file.ok) fail(`cannot read the export: ${file.code}`);
  const rpcUrl = process.env.AI_PR_SIGNOFF_RPC_URL;
  const result = await verifySignoff({
    exportBytes: file.bytes,
    expectedReference: readJson(required(values['expected-reference'], usage)),
    ...(values.policy !== undefined &&
      rpcUrl !== undefined &&
      rpcUrl !== '' && {
        live: { policy: readJson(values.policy), rpcUrl, allowLoopbackHttp: values.local === true },
      }),
  });
  if (!result.ok) fail(`could not verify: ${result.error.source}`);
  process.stdout.write(`${JSON.stringify(result.data.report, null, 2)}\n`);
} else if (command === 'export') {
  const usage =
    'export --reference <file> --evidence-dir <dir> --owner <0x..> --out <file> --full-disclosure';
  const { values } = parseArgs({
    args: rest,
    options: {
      reference: { type: 'string' },
      'evidence-dir': { type: 'string' },
      owner: { type: 'string' },
      out: { type: 'string' },
      'full-disclosure': { type: 'boolean' },
    },
  });
  if (values['full-disclosure'] !== true)
    fail(`${FULL_DISCLOSURE_NOTICE}\nPass --full-disclosure to proceed. ${usage}`);
  const parsed = parseReceiptReference(readJson(required(values.reference, usage)));
  if (!parsed.ok) fail('the reference file is not a receipt reference');
  const store = await openStore(
    required(values['evidence-dir'], usage),
    required(values.owner, usage).toLowerCase(),
  );
  const loaded = await store.load(parsed.data);
  if (!loaded.ok) fail(`cannot read the preserved package: ${loaded.code}`);
  writeFileSync(required(values.out, usage), buildReadableExport(parsed.data, loaded.data), {
    mode: 0o600,
  });
  process.stderr.write(`${FULL_DISCLOSURE_NOTICE}\n`);
} else {
  fail('commands: hash, keygen, prepare, issue, verify, export');
}
