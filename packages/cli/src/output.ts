import type { ReceiptReferenceV1, VerificationReportV1 } from '@lexaegis/sdk';
import { EXIT_MEANING, type ExitCode } from './exit.js';

/*
 * What the CLI prints. Text and JSON are built from an allowlisted projection of the SDK report:
 * artifact IDs, profile identifiers, openings, hashes, labels and endpoints are never part of it.
 * Every dynamic string is escaped before it reaches a terminal.
 */

export const RESULT_SCHEMA = 'lexaegis.cli-result.v1';

/** The fields of VerificationReportV1 that are safe to print, in a fixed order. */
export interface PublicReport {
  readonly schema: string;
  readonly mode: VerificationReportV1['mode'];
  readonly expectedReference: ReceiptReferenceV1;
  readonly referenceOrigin: VerificationReportV1['referenceOrigin'];
  readonly manifestIntegrity: VerificationReportV1['manifestIntegrity'];
  readonly artifactIntegrity: VerificationReportV1['artifactIntegrity'];
  readonly registryIdentity: VerificationReportV1['registryIdentity'];
  readonly receiptBinding: VerificationReportV1['receiptBinding'];
  readonly chainStatus: VerificationReportV1['chainStatus'];
  readonly signerAcceptance: VerificationReportV1['signerAcceptance'];
  readonly checkpoint: VerificationReportV1['checkpoint'];
  readonly registryPolicyId: string | null;
  readonly signerPolicyId: string | null;
  readonly profileSemantics: 'not_evaluated';
  readonly history: VerificationReportV1['history'];
  readonly observedAt: string;
  readonly issues: readonly { readonly code: string }[];
}

export function projectReport(report: VerificationReportV1): PublicReport {
  return {
    schema: report.schema,
    mode: report.mode,
    expectedReference: {
      schema: report.expectedReference.schema,
      chainId: report.expectedReference.chainId,
      registryAddress: report.expectedReference.registryAddress,
      reviewerAddress: report.expectedReference.reviewerAddress,
      commitment: report.expectedReference.commitment,
    },
    referenceOrigin: report.referenceOrigin,
    manifestIntegrity: report.manifestIntegrity,
    artifactIntegrity: report.artifactIntegrity,
    registryIdentity: report.registryIdentity,
    receiptBinding: report.receiptBinding,
    chainStatus: report.chainStatus,
    signerAcceptance: report.signerAcceptance,
    checkpoint: report.checkpoint,
    registryPolicyId: report.registryPolicyId,
    signerPolicyId: report.signerPolicyId,
    profileSemantics: report.profileSemantics,
    history: report.history,
    observedAt: report.observedAt,
    // Artifact IDs stay inside the verifying process: only the stable code is printed.
    issues: report.issues.map((issue) => ({ code: issue.code })),
  };
}

export interface CliFailure {
  readonly source: 'cli' | 'export' | 'verification';
  readonly code: string;
  readonly path?: string;
  /** The option or argument at fault. Never a value. */
  readonly subject?: string;
}

export interface CliResult {
  readonly command: 'verify' | 'status' | 'none';
  readonly exit: ExitCode;
  /** Whether the package files were checked. `status` never loads a package. */
  readonly filesEvaluated: boolean;
  readonly report: PublicReport | null;
  readonly error: CliFailure | null;
  /** Where the RPC endpoint came from, or null when no read was made. The endpoint itself is never printed. */
  readonly rpcSource: 'flag' | 'environment' | 'known-public' | null;
  /** Short factual notes, for example how the expected reference was obtained. */
  readonly notes: readonly string[];
}

/** Code-point ranges that are never printed raw: control, format, separator and bidirectional controls. */
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];

/** Makes any string safe to print: unsafe characters are shown as \\uXXXX escapes. */
export function escapeText(value: string): string {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const unsafe = UNSAFE_RANGES.some(([low, high]) => code >= low && code <= high);
    out += unsafe ? `\\u${code.toString(16).padStart(4, '0')}` : character;
  }
  return out;
}

export function formatJson(result: CliResult): string {
  return `${JSON.stringify(
    {
      schema: RESULT_SCHEMA,
      command: result.command,
      exit: { code: result.exit, meaning: EXIT_MEANING[result.exit] },
      filesEvaluated: result.filesEvaluated,
      // The CLI has no signer-policy editor: acceptance is only ever `unknown` here.
      signerRequirements: 'not_evaluated',
      rpcSource: result.rpcSource,
      report: result.report,
      error: result.error,
    },
    null,
    2,
  )}\n`;
}

const label = (name: string): string => `  ${name.padEnd(20)}`;

export function formatText(result: CliResult): string {
  const lines: string[] = [];
  const { report, error } = result;
  lines.push(`Proof of Review: ${result.command === 'none' ? 'usage' : result.command}`);
  if (report !== null) {
    const ref = report.expectedReference;
    lines.push(
      `${label('receipt')}chain ${escapeText(ref.chainId)} registry ${escapeText(ref.registryAddress)}`,
      `${label('')}reviewer ${escapeText(ref.reviewerAddress)} commitment ${escapeText(ref.commitment)}`,
    );
    if (result.filesEvaluated) {
      lines.push(
        `${label('reference origin')}${escapeText(report.referenceOrigin)}${
          report.referenceOrigin === 'file-declared'
            ? ' (taken from the file: no protection against a substituted package)'
            : ''
        }`,
        `${label('package manifest')}${escapeText(report.manifestIntegrity)}`,
        `${label('package files')}${escapeText(report.artifactIntegrity)}`,
      );
    } else {
      lines.push(`${label('package files')}not evaluated (no package was supplied)`);
    }
    lines.push(
      `${label('registry identity')}${escapeText(report.registryIdentity)}${
        report.registryPolicyId === null ? '' : ` (policy ${escapeText(report.registryPolicyId)})`
      }`,
      `${label('receipt binding')}${escapeText(report.receiptBinding)}`,
      `${label('receipt status')}${escapeText(report.chainStatus)}${
        report.checkpoint === null
          ? ''
          : ` at block ${escapeText(report.checkpoint.blockNumber)} (observed ${escapeText(report.observedAt)})`
      }`,
      `${label('signer')}not evaluated (use the SDK's signer policy to decide whom you accept)`,
    );
    const codes = report.issues.map((issue) => escapeText(issue.code));
    if (codes.length > 0) lines.push(`${label('issues')}${codes.join(', ')}`);
  }
  if (result.rpcSource !== null) {
    lines.push(
      `  note: registry read through ${
        result.rpcSource === 'flag'
          ? '--rpc'
          : result.rpcSource === 'environment'
            ? 'the PROOF_OF_REVIEW_RPC_URL endpoint'
            : 'the public endpoint recorded for this deployment (you named none)'
      }; the endpoint is not printed.`,
    );
  }
  for (const note of result.notes) lines.push(`  note: ${escapeText(note)}`);
  if (error !== null) {
    lines.push(
      `  error [${error.source}]: ${escapeText(error.code)}${
        error.path === undefined ? '' : ` at ${escapeText(error.path)}`
      }${error.subject === undefined ? '' : ` (${escapeText(error.subject)})`}`,
    );
  }
  lines.push(
    `  exit ${String(result.exit)} (${EXIT_MEANING[result.exit]}). This does not establish signer acceptance, legal correctness or the reviewer's identity.`,
  );
  return `${lines.join('\n')}\n`;
}
