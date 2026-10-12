/**
 * @lexaegis/verify-embed: the `proof-of-review-status` custom element. Importing this module
 * registers nothing, reads no global and makes no request; `registerProofOfReviewStatus` defines
 * the element from an explicit host configuration.
 */
export {
  TAG_NAME,
  createProofOfReviewStatusClass,
  registerProofOfReviewStatus,
  type RegistrationResult,
} from './proof-of-review-status';
export {
  CONFIG_REASONS,
  EMBED_LIMITS,
  hostConfigSchema,
  resolveHostConfig,
  type ConfigReason,
  type ConfigResult,
  type ProofOfReviewHostConfig,
  type ResolvedConfig,
} from './config';
export {
  OBSERVED_ATTRIBUTES,
  snapshotInputs,
  type InputSnapshot,
  type InputResult,
} from './inputs';
export {
  readStatus,
  LIFECYCLE_STATES,
  type LifecycleState,
  type StatusObservation,
} from './status';
export {
  MAX_PACKAGE_BYTES,
  checkPackage,
  downloadBounded,
  verifyPackageBytes,
  type IntegrityKind,
  type IntegrityOutcome,
} from './package-check';
