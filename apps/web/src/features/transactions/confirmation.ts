import type { OperationView } from './api-client';

/*
 * The one place a "receipt confirmed" signal is born. It is derived by the transaction
 * controller from an operation the server reported as confirmed (the server checks the
 * configured chain, the successful execution, the expected event and its canonicality policy),
 * and only after this check binds it to the exact action this tab signed. A canvas, a model
 * message, the indexer, a hydrated history or a transaction hash alone can never produce one.
 */

export interface ConfirmationScope {
  readonly chainId: string;
  readonly registryAddress: string;
}

/** What the reviewer's own signed action said, held in memory by the controller. */
export interface ExpectedAction {
  readonly chainId: string;
  readonly registryAddress: string;
  readonly reviewer: string;
  readonly commitment: string;
  readonly nonce: string;
}

export interface ConfirmationSignal {
  readonly kind: 'confirmed' | 'invalidated';
  /** Stable event identity: chain, registry and transaction. Never replayed, never reused. */
  readonly id: string;
  /** For an invalidation, the id of the confirmation it withdraws. */
  readonly operationId: string;
  readonly transactionHash: string;
  readonly blockNumber: string;
  readonly commitment: string;
  readonly reviewer: string;
  readonly chainId: string;
  readonly registryAddress: string;
}

const HASH = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;

export const confirmationId = (scope: ConfirmationScope, transactionHash: string): string =>
  `${scope.chainId}:${scope.registryAddress.toLowerCase()}:${transactionHash.toLowerCase()}`;

/** Null unless every binding holds; the caller then emits nothing. */
export function verifyConfirmation(
  operation: OperationView,
  expected: ExpectedAction | null,
  scope: ConfirmationScope | null,
): ConfirmationSignal | null {
  if (expected === null || scope === null) return null;
  if (operation.kind !== 'execute' || operation.phase !== 'confirmed') return null;
  // An execution through someone else's transaction is shown, but is not this action's celebration.
  if (operation.executedViaAnotherTransaction) return null;
  const hash = operation.transactionHash?.toLowerCase() ?? null;
  const block = operation.blockNumber;
  if (hash === null || !HASH.test(hash) || block === null || !DECIMAL.test(block)) return null;
  if (
    expected.chainId !== scope.chainId ||
    expected.registryAddress.toLowerCase() !== scope.registryAddress.toLowerCase()
  ) {
    return null;
  }
  if (operation.account.toLowerCase() !== expected.reviewer.toLowerCase()) return null;
  if (
    operation.commitment === null ||
    operation.commitment.toLowerCase() !== expected.commitment.toLowerCase()
  ) {
    return null;
  }
  if (operation.registryNonce !== expected.nonce) return null;
  return {
    kind: 'confirmed',
    id: confirmationId(scope, hash),
    operationId: operation.operationId,
    transactionHash: hash,
    blockNumber: block,
    commitment: expected.commitment.toLowerCase(),
    reviewer: expected.reviewer.toLowerCase(),
    chainId: scope.chainId,
    registryAddress: scope.registryAddress.toLowerCase(),
  };
}
