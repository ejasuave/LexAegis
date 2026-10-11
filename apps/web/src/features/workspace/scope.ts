/*
 * Binds asynchronous work to the identity it started under. A late completion is applied only
 * if every part of the identity still holds; otherwise it is rejected and the work is treated
 * as stale. The scope is a value compared by the caller's own controller state; it carries no
 * authority and cannot be built from a model, URL or storage.
 */

export interface OperationScope {
  readonly accountAddress: string | null;
  readonly accountGeneration: number;
  readonly vaultGeneration: number;
  readonly matterId: string | null;
  readonly documentVersionIds: readonly string[];
  /** The input snapshot digest the work was computed from. */
  readonly snapshotDigest: string | null;
  /** The run, package or operation identity, when there is one. */
  readonly operationId: string | null;
}

export function scopeKey(scope: OperationScope): string {
  return JSON.stringify([
    scope.accountAddress,
    scope.accountGeneration,
    scope.vaultGeneration,
    scope.matterId,
    [...scope.documentVersionIds].sort(),
    scope.snapshotDigest,
    scope.operationId,
  ]);
}

export function sameScope(a: OperationScope, b: OperationScope): boolean {
  return scopeKey(a) === scopeKey(b);
}

/**
 * Starts work under the current scope and reports whether it may still land. `current` is read
 * again at completion time, so any change in between rejects the result.
 */
export function guard(current: () => OperationScope): {
  readonly started: OperationScope;
  readonly stillCurrent: () => boolean;
} {
  const started = Object.freeze({
    ...current(),
    documentVersionIds: [...current().documentVersionIds],
  });
  return { started, stillCurrent: () => sameScope(started, current()) };
}
