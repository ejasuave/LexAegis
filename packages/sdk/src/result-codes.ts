import { PORTABLE_ERROR_CODES, type PortableErrorCode } from '@lexaegis/protocol/portable';
import { PROTOCOL_ERROR_CODES, type ProtocolErrorCode } from '@lexaegis/protocol/v1';
import { BUDGET_FAILURES, type BudgetFailure } from './registry/budget';
import { REGISTRY_ERROR_CODES, type RegistryErrorCode } from './registry/errors';
import { LIVE_UNKNOWN_REASONS, type LiveUnknownReason } from './registry/live-reader';
import { RPC_CONFIG_ERRORS, type RpcConfigError } from './registry/rpc-client';
import { REPORT_ISSUE_CODES, type ReportIssueCode } from './verification/report';

/*
 * The documented catalog of every stable code the SDK can return: what causes it and whether the
 * same call can succeed later. It is data only. A test fails when a code exists without an entry
 * (or an entry without a code), so the table in README.md cannot silently drift.
 *
 * A code never carries artifact content, labels, hashes, openings, endpoints or credentials.
 */

export const RESULT_CODE_FAMILIES = [
  'protocol',
  'export',
  'registry',
  'report-issue',
  'live-reason',
  'budget',
  'rpc-config',
] as const;
export type ResultCodeFamily = (typeof RESULT_CODE_FAMILIES)[number];

/**
 * Whether repeating the same call can succeed.
 * - `no`: the input is wrong or the observation is final; changing nothing changes nothing.
 * - `after-fix`: the caller must correct input, configuration or policy first.
 * - `transient`: the network, provider or budget stopped the read; the same call may succeed later.
 * - `informational`: not a failure; it describes what was and was not evaluated.
 */
export type Retryability = 'no' | 'after-fix' | 'transient' | 'informational';

export interface ResultCodeInfo {
  readonly family: ResultCodeFamily;
  readonly code: string;
  /** What produced it, in one sentence. */
  readonly cause: string;
  readonly retry: Retryability;
}

type Row = readonly [code: string, retry: Retryability, cause: string];
const rows = (family: ResultCodeFamily, list: readonly Row[]): ResultCodeInfo[] =>
  list.map(([code, retry, cause]) => ({ family, code, cause, retry }));

const protocol: Record<ProtocolErrorCode, readonly [Retryability, string]> = {
  INPUT_TOO_LARGE: ['no', 'The input exceeds a size limit.'],
  INVALID_UTF8: ['no', 'The bytes are not valid UTF-8.'],
  BYTE_ORDER_MARK: ['no', 'The input starts with a byte-order mark.'],
  INVALID_JSON: ['no', 'Not strict JSON (comment, trailing comma or content, bad grammar).'],
  DUPLICATE_KEY: ['no', 'An object repeats a member name, including after escape decoding.'],
  NESTING_TOO_DEEP: ['no', 'Containers are nested deeper than 32.'],
  UNSAFE_NUMBER: ['no', 'A number is not a safe plain integer literal.'],
  LONE_SURROGATE: ['no', 'A string or member name contains an unpaired UTF-16 surrogate.'],
  FORBIDDEN_KEY: ['no', 'A member name could manipulate prototypes.'],
  UNSUPPORTED_VALUE: ['no', 'Object input is not plain JSON data.'],
  UNSUPPORTED_VERSION: ['no', 'The schema identifier is a version this SDK does not support.'],
  UNKNOWN_FIELD: ['no', 'An object has a field the v1 schema does not define.'],
  SCHEMA_INVALID: ['no', 'A value does not match its v1 schema.'],
  TOO_MANY_ARTIFACTS: ['no', 'More than 128 artifacts are declared.'],
  DUPLICATE_ARTIFACT_ID: ['no', 'Two artifacts share an ID.'],
  SOURCE_ARTIFACT_REQUIRED: ['no', 'No artifact has the role source.'],
  DECISION_LOG_ARTIFACT_INVALID: ['no', 'The manifest does not have exactly one decision log.'],
  DUPLICATE_SCOPE_ID: ['no', 'An approval scope ID is listed twice.'],
  UNRESOLVED_ARTIFACT_REFERENCE: ['no', 'A scope or decision-log ID names no artifact.'],
  SCOPE_INCOMPLETE: ['no', 'The approval scope does not cover every artifact.'],
  DECISION_LOG_REFERENCE_INVALID: [
    'no',
    'decisionLogArtifactId names an artifact that is not the decision log.',
  ],
  SUPERSEDES_CONTEXT_MISMATCH: [
    'no',
    'The declared predecessor is on another chain, registry or reviewer.',
  ],
  ARTIFACT_TOO_LARGE: ['no', 'An artifact is larger than 10 MiB.'],
  ARTIFACTS_TOO_LARGE: ['no', 'The artifacts together exceed 32 MiB.'],
  ARTIFACT_INPUT_INVALID: [
    'after-fix',
    'Supplied artifact bytes are malformed (not bytes, shared or detached).',
  ],
  ARTIFACT_MISSING: ['after-fix', 'A committed artifact was not supplied.'],
  ARTIFACT_DUPLICATE: ['after-fix', 'The same artifact ID was supplied twice.'],
  ARTIFACT_EXTRA: ['after-fix', 'A supplied artifact is not in the manifest.'],
  ARTIFACT_LENGTH_MISMATCH: ['no', 'Supplied bytes have a different length than committed.'],
  ARTIFACT_DIGEST_MISMATCH: ['no', 'Supplied bytes hash to a different digest than committed.'],
  INVALID_HEX: ['no', 'Not strict lowercase 0x-prefixed hexadecimal.'],
  INVALID_BYTE_LENGTH: ['no', 'A decoded value is not the required byte length.'],
  CRYPTO_UNAVAILABLE: ['after-fix', 'This runtime has no Web Crypto digest or secure randomness.'],
};

const exportCodes: Record<PortableErrorCode, readonly [Retryability, string]> = {
  INPUT_TOO_LARGE: ['no', 'The export file is larger than 48 MiB.'],
  INPUT_MALFORMED: ['no', 'The file is not strict JSON (see cause for the parser code).'],
  WRONG_FORMAT_ENCRYPTED_BACKUP: ['no', "This is an encrypted backup; it needs its owner's vault."],
  WRONG_FORMAT_CONTEXT_EXPORT: [
    'no',
    'This is a saved context export; it holds no review package.',
  ],
  UNRECOGNISED_FORMAT: ['no', 'The file is not a Proof of Review export.'],
  UNSUPPORTED_VERSION: ['no', 'A review export of a version this SDK does not support.'],
  UNKNOWN_FIELD: ['no', 'The export has a field the v1 envelope does not define.'],
  SCHEMA_INVALID: ['no', 'The export envelope does not match its schema.'],
  OPENING_TOO_LARGE: ['no', 'The manifest or opening is larger than 1 MiB.'],
  ARTIFACT_SET_MISMATCH: [
    'no',
    'Artifact entries are not exactly the manifest artifacts, once each, in order.',
  ],
  ARTIFACT_ENCODING_INVALID: ['no', 'Artifact bytes are not canonical unpadded base64url.'],
  ARTIFACT_TOO_LARGE: ['no', 'One artifact is larger than 10 MiB.'],
  ARTIFACTS_TOO_LARGE: ['no', 'The artifacts together exceed 32 MiB.'],
};

const registry: Record<RegistryErrorCode, readonly [Retryability, string]> = {
  SNAPSHOT_INVALID: ['after-fix', 'The prepared snapshot is not a real PreparedReviewPackage.'],
  REFERENCE_INVALID: ['after-fix', 'A receipt reference does not match its schema.'],
  UNSUPPORTED_VERSION: ['no', 'A reference of an unsupported version.'],
  NONCE_INVALID: ['after-fix', 'The registry action nonce is not a canonical uint256 decimal.'],
  DEADLINE_INVALID: ['after-fix', 'The deadline is zero or not a canonical uint256 decimal.'],
  ZERO_COMMITMENT: ['no', 'A commitment is bytes32(0), which is reserved.'],
  SUPERSEDES_UNEXPECTED: [
    'after-fix',
    'ISSUE was requested for a package that names a predecessor; use SUPERSEDE.',
  ],
  SUPERSEDES_REQUIRED: [
    'after-fix',
    'SUPERSEDE was requested for a package that names no predecessor.',
  ],
  SUPERSEDES_MISMATCH: ['after-fix', 'The package names a different predecessor than supplied.'],
  CONTEXT_MISMATCH: [
    'after-fix',
    'Chain, registry or reviewer differ between the package and the predecessor.',
  ],
  REPLACEMENT_EQUALS_PREVIOUS: ['no', 'A replacement cannot be the commitment it replaces.'],
  ACTION_INVALID: ['after-fix', 'The action does not match its schema.'],
  CHAIN_ID_INVALID: ['after-fix', 'The chain ID is not valid.'],
  REGISTRY_ADDRESS_INVALID: ['after-fix', 'The registry address is not valid.'],
  DOMAIN_MISMATCH: [
    'after-fix',
    'The signing domain differs from the one the action was built for.',
  ],
  TYPED_DATA_INVALID: ['after-fix', 'The typed data does not match its schema.'],
  CONTEXT_INVALID: ['after-fix', 'The chain or registry context is not valid.'],
  EMPTY_RESPONSE: ['transient', 'A call returned no data (for example an address without code).'],
  RESPONSE_MALFORMED: ['no', 'Return data is not the expected shape.'],
  STATUS_UNKNOWN: ['no', 'The receipt status is outside the known enum.'],
  LOG_MALFORMED: ['no', 'A log does not decode as a registry event.'],
  LOG_ADDRESS_MISMATCH: ['no', 'A log was emitted by another address.'],
  EVENT_UNKNOWN: ['no', 'The log is not one of the four registry events.'],
  ERROR_UNKNOWN: ['no', 'The revert data is not a known registry error.'],
  OPENING_INVALID: ['after-fix', 'The opening does not match its schema.'],
  OBSERVATION_INVALID: ['no', 'The observed record does not match its schema.'],
};

const reportIssues: Record<ReportIssueCode, readonly [Retryability, string]> = {
  EXPECTATION_FROM_FILE: [
    'informational',
    'The expected reference came from the file itself: no protection against a substituted bundle.',
  ],
  MANIFEST_NOT_SUPPLIED: ['informational', 'Reference-only mode: no manifest was checked.'],
  ARTIFACTS_NOT_SUPPLIED: ['informational', 'No artifact bytes were supplied.'],
  ARTIFACTS_NOT_EVALUATED: [
    'informational',
    'The manifest did not match, so artifacts were not evaluated.',
  ],
  DECLARED_REFERENCE_CONFLICT: [
    'no',
    'The file declares a different reference than the one expected.',
  ],
  CONTEXT_MISMATCH: [
    'no',
    'The opening is for a different chain, registry or reviewer than expected.',
  ],
  COMMITMENT_MISMATCH: ['no', 'The opening does not recompute the expected commitment.'],
  ARTIFACT_MISSING: ['after-fix', 'A committed artifact was not supplied (integrity unknown).'],
  ARTIFACT_LENGTH_MISMATCH: ['no', 'A supplied artifact has the wrong length.'],
  ARTIFACT_DIGEST_MISMATCH: ['no', 'A supplied artifact has the wrong digest.'],
  ARTIFACT_NOT_IN_MANIFEST: ['no', 'A supplied file is not committed by the manifest.'],
  NETWORK_NOT_REQUESTED: ['informational', 'No live check was requested: chain status is unknown.'],
  REGISTRY_POLICY_MISSING: ['after-fix', 'A live check needs a registry policy.'],
  REGISTRY_POLICY_INVALID: ['after-fix', 'The registry policy or RPC endpoint is not valid.'],
  REGISTRY_POLICY_MISMATCH: [
    'no',
    'The reference names a chain or registry the policy does not trust.',
  ],
  LIVE_RPC_UNAVAILABLE: ['transient', 'The RPC endpoint could not be read.'],
  LIVE_WRONG_CHAIN: ['no', 'The endpoint serves another chain ID than the policy.'],
  LIVE_GENESIS_MISMATCH: ['no', "The endpoint's genesis block is not the pinned one."],
  LIVE_FINALIZED_UNAVAILABLE: ['transient', 'The endpoint reports no finalized block.'],
  LIVE_BELOW_DEPLOYMENT: ['transient', 'The selected block is before the deployment block.'],
  LIVE_CODE_MISMATCH: ['no', "The registry code differs from the policy's runtime-code hash."],
  LIVE_PROTOCOL_MISMATCH: ['no', 'The registry reports a different protocol version.'],
  LIVE_BLOCK_CHANGED: ['transient', 'The pinned block hash changed during the read.'],
  LIVE_RESPONSE_INVALID: ['transient', 'The endpoint returned an unexpected response.'],
  LIVE_DEADLINE: ['transient', 'The 20 second budget ended.'],
  LIVE_ATTEMPTS_EXHAUSTED: ['transient', 'The attempt budget ended.'],
  LIVE_TIMEOUT: ['transient', 'A single read timed out.'],
  LIVE_ABORTED: ['transient', 'The caller cancelled the check.'],
  BINDING_NOT_EVALUATED: [
    'informational',
    'No verified opening was available to bind to the record.',
  ],
  OPENING_CONTEXT_MISMATCH: [
    'no',
    'The opening and the reference disagree on chain, registry or reviewer.',
  ],
  RECEIPT_TUPLE_MISMATCH: ['no', 'The observed record is for a different tuple than requested.'],
  PREDECESSOR_MISMATCH: ['no', "The record's predecessor is not the one the manifest declares."],
  IMPOSSIBLE_RECORD: ['no', 'The record could not have been produced by the registry.'],
  SUCCESSOR_LIMIT_EXHAUSTED: [
    'informational',
    'More than 8 successor links exist; the history is incomplete.',
  ],
  SUCCESSOR_CYCLE: ['no', 'The successor chain loops.'],
  SUCCESSOR_LINK_INVALID: ['no', 'A successor record is not reciprocal or not a valid receipt.'],
  SUCCESSOR_UNREADABLE: ['transient', 'A successor could not be read.'],
  SIGNER_POLICY_ABSENT: ['informational', 'No signer policy was supplied: acceptance is unknown.'],
  SIGNER_POLICY_ERROR: ['after-fix', 'The signer policy threw or answered with an invalid value.'],
};

const liveReasons: Record<LiveUnknownReason, readonly [Retryability, string]> = {
  RPC_UNAVAILABLE: ['transient', 'A read failed or was refused.'],
  WRONG_CHAIN: ['no', 'The endpoint serves another chain.'],
  FINALIZED_UNAVAILABLE: ['transient', 'The endpoint has no finalized block.'],
  BELOW_DEPLOYMENT: ['transient', 'The selected block predates the deployment.'],
  CODE_MISMATCH: ['no', 'The registry code is not the trusted runtime code.'],
  PROTOCOL_MISMATCH: ['no', 'The registry protocol version is not the trusted one.'],
  BLOCK_CHANGED: ['transient', 'The block hash changed while reading.'],
  RESPONSE_INVALID: ['transient', 'A response had an unexpected shape.'],
  POLICY_INVALID: ['after-fix', 'The chain policy is not valid.'],
};

const budget: Record<BudgetFailure, readonly [Retryability, string]> = {
  DEADLINE: ['transient', 'The total time budget (20 s) ended.'],
  ATTEMPTS: ['transient', 'The attempt budget (64) ended.'],
  ABORTED: ['transient', "The caller's AbortSignal fired."],
  TIMEOUT: ['transient', 'One read exceeded its 5 s limit.'],
};

const rpcConfig: Record<RpcConfigError, readonly [Retryability, string]> = {
  NOT_HTTPS: [
    'after-fix',
    'The endpoint is not HTTPS (loopback HTTP only when explicitly allowed).',
  ],
  HAS_CREDENTIALS: ['after-fix', 'The endpoint URL carries user information.'],
  HAS_QUERY_OR_FRAGMENT: [
    'after-fix',
    'The endpoint URL has a query or fragment, where a key could hide.',
  ],
  MALFORMED_URL: ['after-fix', 'The endpoint is not a URL.'],
};

const fromRecord = <C extends string>(
  family: ResultCodeFamily,
  order: readonly C[],
  record: Record<C, readonly [Retryability, string]>,
): ResultCodeInfo[] =>
  rows(
    family,
    order.map((code): Row => [code, record[code][0], record[code][1]]),
  );

/** Every public code, grouped by family, in the order the source defines them. */
export const RESULT_CODE_CATALOG: readonly ResultCodeInfo[] = Object.freeze([
  ...fromRecord('protocol', PROTOCOL_ERROR_CODES, protocol),
  ...fromRecord('export', PORTABLE_ERROR_CODES, exportCodes),
  ...fromRecord('registry', REGISTRY_ERROR_CODES, registry),
  ...fromRecord('report-issue', REPORT_ISSUE_CODES, reportIssues),
  ...fromRecord('live-reason', LIVE_UNKNOWN_REASONS, liveReasons),
  ...fromRecord('budget', BUDGET_FAILURES, budget),
  ...fromRecord('rpc-config', RPC_CONFIG_ERRORS, rpcConfig),
]);

/**
 * Looks up the documented cause and retryability of a code.
 *
 * @example
 * ```ts
 * import { describeResultCode } from '@lexaegis/sdk';
 *
 * const info = describeResultCode('report-issue', 'LIVE_RPC_UNAVAILABLE');
 * console.log(info?.retry); // "transient": the same call may succeed later
 * ```
 */
export function describeResultCode(
  family: ResultCodeFamily,
  code: string,
): ResultCodeInfo | undefined {
  return RESULT_CODE_CATALOG.find((entry) => entry.family === family && entry.code === code);
}
