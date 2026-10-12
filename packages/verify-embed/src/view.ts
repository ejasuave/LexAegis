import type { ConfigReason } from './config';
import type { InputReason } from './inputs';
import type { IntegrityOutcome } from './package-check';
import type { LifecycleState, StatusObservation } from './status';

/*
 * Pure text for the widget. Every outcome has words as well as an icon, and none is stronger than
 * what was observed: an Active record is a current observed lifecycle only. Nothing here says
 * "valid", "verified", "trusted" or "approved".
 */

export type IconKind =
  | LifecycleState
  | 'checking'
  | 'config'
  | 'match'
  | 'mismatch'
  | 'incomplete'
  | 'unsupported'
  | 'unavailable'
  | 'not-checked';

export const LIFECYCLE_WORDS: Readonly<Record<LifecycleState, string>> = {
  active: 'active',
  revoked: 'revoked',
  superseded: 'superseded',
  not_found: 'not found',
  unknown: 'unknown',
};

export const LIFECYCLE_MEANING: Readonly<Record<LifecycleState, string>> = {
  active:
    'The registry currently records this receipt as active. This is not a check of the files, the reviewer or the content.',
  revoked: 'The registry records that this receipt was revoked.',
  superseded: 'The registry records that this receipt was replaced by a later one.',
  not_found: 'A successful read of the configured registry found no such receipt.',
  unknown: 'The current status could not be established.',
};

const CONFIG_TEXT: Readonly<Record<ConfigReason | InputReason, string>> = {
  CONFIG_MISSING: 'The host page has not configured a trusted registry deployment.',
  CONFIG_INVALID: 'The host configuration is invalid.',
  CONFIG_RPC_REJECTED: 'The host configuration names an RPC endpoint that is not allowed.',
  CONFIG_ORIGIN_REJECTED: 'The host configuration names an origin that is not allowed.',
  CONFIG_DUPLICATE_DEPLOYMENT: 'The host configuration lists the same deployment twice.',
  ATTRIBUTE_MISSING: 'The element needs chain-id, registry, reviewer and commitment.',
  REFERENCE_INVALID: 'The receipt reference attributes are not valid.',
  RPC_URL_NOT_ALLOWED: 'The rpc-url attribute is not allowed by the host configuration.',
  DEPLOYMENT_NOT_TRUSTED: 'This chain and registry are not a deployment the host trusts.',
};

export const configText = (reason: ConfigReason | InputReason): string => CONFIG_TEXT[reason];

const ISSUE_TEXT: Readonly<Record<string, string>> = {
  LIVE_RPC_UNAVAILABLE: 'The RPC endpoint could not be reached.',
  LIVE_WRONG_CHAIN: 'The endpoint reports a different chain.',
  LIVE_GENESIS_MISMATCH: 'The endpoint is a different chain from the trusted deployment.',
  LIVE_CODE_MISMATCH: 'The registry code is not the trusted code.',
  LIVE_PROTOCOL_MISMATCH: 'The registry reports a different protocol version.',
  LIVE_FINALIZED_UNAVAILABLE: 'No sufficiently final block was available.',
  LIVE_BELOW_DEPLOYMENT: 'The chain has not reached the registry deployment block.',
  LIVE_BLOCK_CHANGED: 'The chain changed during the read.',
  LIVE_RESPONSE_INVALID: 'The endpoint returned an invalid response.',
  LIVE_DEADLINE: 'The read took too long.',
  LIVE_TIMEOUT: 'The read took too long.',
  LIVE_ATTEMPTS_EXHAUSTED: 'The read used its request allowance.',
  LIVE_ABORTED: 'The read was cancelled.',
  REGISTRY_POLICY_INVALID: 'The trusted deployment record or endpoint is invalid.',
  REGISTRY_POLICY_MISMATCH: 'The reference names a deployment the host does not trust.',
  RECEIPT_TUPLE_MISMATCH: 'The registry record does not match this reference.',
  IMPOSSIBLE_RECORD: 'The registry returned an inconsistent record.',
};

/** A compact reason for an `unknown`, from the first issue the SDK reported. */
export function unknownReason(observation: StatusObservation): string {
  for (const code of observation.issues) {
    const text = ISSUE_TEXT[code];
    if (text !== undefined) return text;
  }
  return 'No successful read of the registry was completed.';
}

export const INTEGRITY_WORDS: Readonly<Record<IntegrityOutcome['kind'], string>> = {
  match: 'matching',
  mismatch: 'mismatched',
  incomplete: 'incomplete',
  unsupported: 'unsupported',
  unavailable: 'unavailable',
};

export const INTEGRITY_MEANING: Readonly<Record<IntegrityOutcome['kind'], string>> = {
  match:
    'The supplied files are exactly the files this reference commits to. This says nothing about the registry status.',
  mismatch: 'The supplied files are not the files this reference commits to.',
  incomplete: 'The supplied package does not contain everything needed to check this reference.',
  unsupported: 'This file is not a readable review export this widget can check.',
  unavailable: 'The package could not be retrieved or read, so the files were not checked.',
};

const REASON_TEXT: Readonly<Record<string, string>> = {
  NOT_CONFIGURED: 'No package URL is configured.',
  ORIGIN_NOT_ALLOWED: 'The package URL is not on an origin the host approved.',
  FETCH_FAILED: 'The download failed (network, CORS or a refused redirect).',
  HTTP_STATUS: 'The server did not return the package.',
  TIMEOUT: 'The download took too long.',
  TOO_LARGE: 'The package is larger than the allowed size.',
  ABORTED: 'The check was cancelled.',
  MALFORMED_PACKAGE: 'The file is not a well-formed review export.',
  WRONG_FORMAT_ENCRYPTED_BACKUP: 'This is an encrypted backup, which needs its owner.',
  WRONG_FORMAT_CONTEXT_EXPORT: 'This is a saved-context file, not a review package.',
  UNRECOGNISED_FORMAT: 'The file format is not recognised.',
  UNSUPPORTED_VERSION: 'This export version is not supported.',
  ARTIFACT_SET_MISMATCH: 'The files in the package are not the files its manifest lists.',
  ARTIFACT_ENCODING_INVALID: 'A file in the package is not encoded correctly.',
  ARTIFACT_MISSING: 'A file listed by the manifest is missing.',
  DECLARED_REFERENCE_CONFLICT: 'The package declares a different receipt reference.',
};

export const reasonText = (reason: string): string => REASON_TEXT[reason] ?? '';
