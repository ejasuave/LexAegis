import {
  parseReceiptReference,
  parseReviewExport,
  registryPolicySchema,
  verifyOffline,
  type OfflineVerification,
  type ReceiptReferenceV1,
  type VerificationReportV1,
} from '@lexaegis/sdk';
import { verifyReceipt, type FetchLike, type VerifyReceiptFailure } from '@lexaegis/sdk/verify';
import type { CommonOptions } from './args.js';
import {
  MAX_SMALL_FILE_BYTES,
  resolvePolicy,
  resolveRpc,
  type ResolvedPolicy,
  type ResolvedRpc,
} from './config.js';
import { EXIT, type CliErrorCode, type ExitCode } from './exit.js';
import { readBoundedFile } from './files.js';
import { projectReport, type CliFailure, type CliResult } from './output.js';

/** The largest package accepted: the protocol's 48 MiB bundle limit. */
export const MAX_PACKAGE_BYTES = 48 * 1024 * 1024;
const REFERENCE_SCHEMA = 'lexaegis.receipt-ref.v1';

export interface Environment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  /** Test seam for the network. Production uses the platform fetch. */
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
}

const cliFailure = (code: CliErrorCode, subject?: string): CliFailure => ({
  source: 'cli',
  code,
  ...(subject !== undefined && { subject }),
});

function result(
  command: 'verify' | 'status',
  exit: ExitCode,
  parts: Partial<Omit<CliResult, 'command' | 'exit'>> = {},
): CliResult {
  return {
    command,
    exit,
    filesEvaluated: false,
    report: null,
    error: null,
    rpcSource: null,
    notes: [],
    ...parts,
  };
}

/** Chain ID and registry as the caller typed them, validated by the SDK's own schemas. */
function readContext(
  values: CommonOptions['values'],
): { ok: true; chainId: string; registryAddress: string } | { ok: false; subject: string } {
  const chain = registryPolicySchema.shape.chainId.safeParse(values['chain-id']);
  if (!chain.success) return { ok: false, subject: '--chain-id' };
  const registry = registryPolicySchema.shape.registryAddress.safeParse(values.registry);
  if (!registry.success) return { ok: false, subject: '--registry' };
  return { ok: true, chainId: chain.data, registryAddress: registry.data };
}

/** Exit code for a finished report. Order matters: an untrusted chain is never read as a status. */
function exitForReport(report: VerificationReportV1, requireFiles: boolean): ExitCode {
  if (
    requireFiles &&
    (report.manifestIntegrity !== 'match' || report.artifactIntegrity !== 'match')
  ) {
    return EXIT.INTEGRITY;
  }
  if (
    report.registryIdentity !== 'match' ||
    report.receiptBinding === 'mismatch' ||
    report.chainStatus === 'unknown'
  ) {
    return EXIT.CHAIN_UNTRUSTED;
  }
  switch (report.chainStatus) {
    case 'revoked':
      return EXIT.REVOKED;
    case 'superseded':
      return EXIT.SUPERSEDED;
    case 'not_found':
      return EXIT.NOT_FOUND;
    case 'active':
      return EXIT.OK;
    default:
      return EXIT.CHAIN_UNTRUSTED;
  }
}

function verificationFailure(failure: VerifyReceiptFailure): CliFailure {
  return {
    source: 'verification',
    code: failure.code,
    ...('path' in failure && failure.path !== undefined && { path: failure.path }),
  };
}

interface Trust {
  readonly policy: ResolvedPolicy | null;
  readonly rpc: ResolvedRpc | null;
}

/** Resolves the deployment pin and RPC endpoint, or the error that makes them unusable. */
async function resolveTrust(
  options: CommonOptions,
  context: { chainId: string; registryAddress: string },
  environment: Environment,
): Promise<{ ok: true; trust: Trust } | { ok: false; failure: CliFailure; exit: ExitCode }> {
  const policy = await resolvePolicy({
    chainId: context.chainId,
    registryAddress: context.registryAddress,
    deploymentPath: options.values.deployment,
  });
  if (!policy.ok) {
    return {
      ok: false,
      failure: cliFailure(policy.code, policy.subject),
      exit: policy.code === 'DEPLOYMENT_PINS_MISSING' ? EXIT.CHAIN_UNTRUSTED : EXIT.USAGE,
    };
  }
  const rpc = resolveRpc({
    flag: options.values.rpc,
    env: environment.env,
    known: policy.value,
    allowLoopbackHttp: options.allowLoopbackHttp,
  });
  if (!rpc.ok) return { ok: false, failure: cliFailure(rpc.code, rpc.subject), exit: EXIT.USAGE };
  return { ok: true, trust: { policy: policy.value, rpc: rpc.value } };
}

/** Why no live read can be made, as a CLI failure; null when both pieces exist. */
function missingTrust(trust: Trust): CliFailure | null {
  if (trust.policy === null) return cliFailure('DEPLOYMENT_PINS_MISSING', '--deployment');
  if (trust.rpc === null) return cliFailure('RPC_NOT_CONFIGURED', '--rpc');
  return null;
}

export async function runVerify(
  parsed: { readonly packagePath: string } & CommonOptions,
  environment: Environment,
): Promise<CliResult> {
  const context = readContext(parsed.values);
  if (!context.ok)
    return result('verify', EXIT.USAGE, {
      error: cliFailure('USAGE_VALUE_INVALID', context.subject),
    });

  // 1. Capture every local input before anything asynchronous touches the network.
  const file = await readBoundedFile(parsed.packagePath, MAX_PACKAGE_BYTES);
  if (!file.ok) {
    // An oversize package is a package that fails verification; an unreadable path is a usage error.
    return file.code === 'INPUT_TOO_LARGE'
      ? result('verify', EXIT.INTEGRITY, { error: { source: 'export', code: 'INPUT_TOO_LARGE' } })
      : result('verify', EXIT.USAGE, { error: cliFailure(file.code, '<package-path>') });
  }
  let independent: ReceiptReferenceV1 | null = null;
  const referencePath = parsed.values['expected-reference'];
  if (referencePath !== undefined) {
    const raw = await readBoundedFile(referencePath, MAX_SMALL_FILE_BYTES);
    if (!raw.ok)
      return result('verify', EXIT.USAGE, { error: cliFailure(raw.code, '--expected-reference') });
    const reference = parseReceiptReference(raw.bytes);
    if (!reference.ok) {
      return result('verify', EXIT.USAGE, {
        error: cliFailure('USAGE_VALUE_INVALID', '--expected-reference'),
      });
    }
    if (
      reference.data.chainId !== context.chainId ||
      reference.data.registryAddress !== context.registryAddress
    ) {
      return result('verify', EXIT.USAGE, {
        error: cliFailure('CONFIG_CONTRADICTORY', '--expected-reference'),
      });
    }
    independent = reference.data;
  }
  const trust = await resolveTrust(parsed, context, environment);
  if (!trust.ok) return result('verify', trust.exit, { error: trust.failure });

  // 2. Decode the package with the SDK's strict decoder. Nothing in it is a path, URL or command.
  const decoded = parseReviewExport(file.bytes);
  if (!decoded.ok) {
    return result('verify', EXIT.INTEGRITY, {
      error: {
        source: 'export',
        code: decoded.error.code,
        ...(decoded.error.path !== undefined && { path: decoded.error.path }),
      },
    });
  }
  const declared = decoded.data.declaredReference;
  // Without an independent reference the expectation is the file's own claim, pinned to the
  // chain and registry the caller named. It is labelled file-declared and offers no protection.
  const expectedReference: ReceiptReferenceV1 = independent ?? {
    schema: REFERENCE_SCHEMA,
    chainId: context.chainId,
    registryAddress: context.registryAddress,
    reviewerAddress: declared.reviewerAddress,
    commitment: declared.commitment,
  };
  const referenceOrigin = independent === null ? 'file-declared' : 'independent';
  const notes =
    independent === null
      ? ['no --expected-reference: the file was checked against its own declaration']
      : [];

  // 3. Full integrity and reference checks come first, with no network.
  const offline = await verifyOffline({
    mode: 'full-package',
    expectedReference,
    referenceOrigin,
    declaredReference: declared,
    opening: decoded.data.opening,
    artifacts: decoded.data.artifacts,
  });
  if (!offline.ok) {
    return result('verify', EXIT.INTEGRITY, {
      filesEvaluated: true,
      notes,
      error: {
        source: 'verification',
        code: offline.error.code,
        ...(offline.error.path !== undefined && { path: offline.error.path }),
      },
    });
  }
  return finishVerify(offline.data, trust.trust, parsed, environment, notes);
}

async function finishVerify(
  offline: OfflineVerification,
  trust: Trust,
  options: CommonOptions,
  environment: Environment,
  notes: readonly string[],
): Promise<CliResult> {
  const common = {
    mode: 'full-package' as const,
    expectedReference: offline.expectedReference,
    referenceOrigin: offline.referenceOrigin,
    offline,
    ...(environment.now !== undefined && { now: environment.now }),
    signal: environment.signal,
  };
  const intact = offline.manifestIntegrity === 'match' && offline.artifactIntegrity === 'match';
  const missing = missingTrust(trust);

  // A package that fails integrity is never sent to the network, and a missing pin is not guessed.
  if (!intact || missing !== null || trust.policy === null || trust.rpc === null) {
    const local = await verifyReceipt(common);
    if (!local.ok) return interrupted(local.error, 'verify', true, notes);
    const report = local.data.report;
    return result('verify', intact ? EXIT.CHAIN_UNTRUSTED : EXIT.INTEGRITY, {
      filesEvaluated: true,
      report: projectReport(report),
      notes: intact ? notes : [...notes, 'the registry was not read: the package failed integrity'],
      ...(intact && missing !== null && { error: missing }),
    });
  }

  const live = await verifyReceipt({
    ...common,
    live: {
      policy: trust.policy.policy,
      transport: {
        kind: 'rpc',
        url: trust.rpc.url,
        ...(environment.fetch !== undefined && { fetch: environment.fetch }),
        ...(options.allowLoopbackHttp && { allowLoopbackHttp: true }),
      },
    },
  });
  if (!live.ok) return interrupted(live.error, 'verify', true, notes);
  const exit = environment.signal.aborted
    ? EXIT.INTERRUPTED
    : exitForReport(live.data.report, true);
  return result('verify', exit, {
    filesEvaluated: true,
    report: projectReport(live.data.report),
    rpcSource: trust.rpc.source,
    notes,
    ...(environment.signal.aborted && { error: cliFailure('INTERRUPTED') }),
  });
}

function interrupted(
  failure: VerifyReceiptFailure,
  command: 'verify' | 'status',
  filesEvaluated: boolean,
  notes: readonly string[],
): CliResult {
  return failure.code === 'ABORTED'
    ? result(command, EXIT.INTERRUPTED, { filesEvaluated, notes, error: cliFailure('INTERRUPTED') })
    : result(command, EXIT.USAGE, { filesEvaluated, notes, error: verificationFailure(failure) });
}

export async function runStatus(
  parsed: CommonOptions,
  environment: Environment,
): Promise<CliResult> {
  const context = readContext(parsed.values);
  if (!context.ok)
    return result('status', EXIT.USAGE, {
      error: cliFailure('USAGE_VALUE_INVALID', context.subject),
    });
  // The reference is built only from the caller's arguments; no package is loaded.
  const reference = parseReceiptReference({
    schema: REFERENCE_SCHEMA,
    chainId: context.chainId,
    registryAddress: context.registryAddress,
    reviewerAddress: parsed.values.reviewer,
    commitment: parsed.values.commitment,
  });
  if (!reference.ok) {
    const subject =
      reference.error.path?.endsWith('commitment') === true ? '--commitment' : '--reviewer';
    return result('status', EXIT.USAGE, { error: cliFailure('USAGE_VALUE_INVALID', subject) });
  }
  const trust = await resolveTrust(parsed, context, environment);
  if (!trust.ok) return result('status', trust.exit, { error: trust.failure });
  const missing = missingTrust(trust.trust);

  const base = {
    mode: 'reference-only' as const,
    expectedReference: reference.data,
    referenceOrigin: 'independent' as const,
    ...(environment.now !== undefined && { now: environment.now }),
    signal: environment.signal,
  };
  if (missing !== null || trust.trust.policy === null || trust.trust.rpc === null) {
    const local = await verifyReceipt(base);
    if (!local.ok) return interrupted(local.error, 'status', false, []);
    return result('status', EXIT.CHAIN_UNTRUSTED, {
      report: projectReport(local.data.report),
      ...(missing !== null && { error: missing }),
    });
  }
  const live = await verifyReceipt({
    ...base,
    live: {
      policy: trust.trust.policy.policy,
      transport: {
        kind: 'rpc',
        url: trust.trust.rpc.url,
        ...(environment.fetch !== undefined && { fetch: environment.fetch }),
        ...(parsed.allowLoopbackHttp && { allowLoopbackHttp: true }),
      },
    },
  });
  if (!live.ok) return interrupted(live.error, 'status', false, []);
  const exit = environment.signal.aborted
    ? EXIT.INTERRUPTED
    : exitForReport(live.data.report, false);
  return result('status', exit, {
    report: projectReport(live.data.report),
    rpcSource: trust.trust.rpc.source,
    notes: [
      '--reviewer selects a record; it does not certify the account, and no package files were checked',
    ],
    ...(environment.signal.aborted && { error: cliFailure('INTERRUPTED') }),
  });
}
