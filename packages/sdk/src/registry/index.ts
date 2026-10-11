/**
 * Proof of Review registry v1: EIP-712 action data, the generated registry ABI, and strict
 * decoding of observed records, events and errors.
 *
 * Everything here is pure and local. Nothing reads a chain, unlocks an account, signs,
 * broadcasts or approves a review: later chapters supply the account and the transport.
 */
export * from './constants';
export {
  REGISTRY_ERROR_CODES,
  type RegistryErrorCode,
  type RegistryFailure,
  type RegistryResult,
} from './errors';
export {
  boundReviewActionSchema,
  buildTypedData,
  commitmentSchema,
  hashReviewAction,
  positiveUint256DecimalSchema,
  reviewActionSchema,
  reviewActionTypedDataSchema,
  toAbiReviewAction,
  toEip712ReviewAction,
  uint256DecimalSchema,
  type AbiReviewAction,
  type BoundReviewAction,
  type Eip712ReviewAction,
  type ReviewActionTypedData,
  type ReviewActionV1,
} from './typed-data';
export {
  buildIssueAction,
  buildRevokeAction,
  buildSupersedeAction,
  defaultActionDeadline,
} from './action-builders';
import type { proofOfReviewRegistryAbi as abi } from './generated/registry-abi';
export { proofOfReviewRegistryAbi } from './generated/registry-abi';
/**
 * The generated registry ABI as a literal type, for typed viem and ethers-style calls.
 * `contracts/integration/interface-abi.test.ts` proves the constant equals the compiler's output.
 */
export type ProofOfReviewRegistryAbi = typeof abi;
export {
  decodeReceipt,
  decodeRegistryError,
  decodeRegistryEvent,
  observedReceiptSchema,
  receiptLifecycleOf,
  registryContextSchema,
  registryEventSchema,
  registryLogSchema,
  registryRevertSchema,
  type ObservedReceipt,
  type RegistryContext,
  type RegistryEvent,
  type RegistryLog,
  type RegistryRevert,
} from './decode';
export {
  BINDING_ISSUE_CODES,
  receiptBindingSchema,
  observedRecordIssues,
  validateReceiptBinding,
  type ReceiptBinding,
} from './binding';
export {
  MONAD_MAINNET_CHAIN_ID,
  MONAD_TESTNET_CHAIN_ID,
  REGISTRY_CONTRACT_NAME,
  REGISTRY_DEPLOYMENT_SCHEMA,
  deploymentEnvironmentSchema,
  registryDeploymentSchema,
  type DeploymentEnvironment,
  type RegistryDeployment,
} from './deployment';
export {
  LIVE_UNKNOWN_REASONS,
  MONAD_EXECUTION_DELAY_BLOCKS,
  MONAD_EXECUTION_DELAY_REVISION,
  chainCheckpointSchema,
  chainPolicySchema,
  liveClientFromViem,
  readChainCheckpoint,
  readLiveReceipt,
  readReceiptAtCheckpoint,
  readProvisionalState,
  type ChainCheckpoint,
  type ChainPolicy,
  type LiveBlock,
  type LiveChainClient,
  type LiveReceiptRead,
  type LiveResult,
  type LiveUnknownReason,
  type ProvisionalState,
} from './live-reader';
