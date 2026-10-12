/*
 * The detection oracles behind the critical system assertions. Each takes what a test OBSERVED and
 * returns the violations it finds ([] means "the invariant held"). The owning specs call them on real
 * observations; negative-controls.spec.ts feeds them deliberately faulted observations and requires
 * every one to be flagged, so a passing owning test cannot be vacuous. Test-only: never shipped, and
 * there is no fault switch in any product code.
 */

export interface ObservedReply {
  readonly status: number;
  /** The application error code, or null when the body carries none. */
  readonly code: string | null;
}

/**
 * Another account's resource must answer exactly like an unknown one (no existence leak) and never
 * succeed; an anonymous caller is refused before any lookup.
 */
export function ownershipViolations(observed: {
  readonly foreign: ObservedReply;
  readonly unknown: ObservedReply;
  readonly anonymous?: ObservedReply;
}): string[] {
  const found: string[] = [];
  if (observed.foreign.status >= 200 && observed.foreign.status < 300)
    found.push('FOREIGN_RESOURCE_SERVED');
  if (observed.foreign.status !== observed.unknown.status) found.push('FOREIGN_STATUS_DIFFERS');
  if (observed.foreign.code !== observed.unknown.code) found.push('FOREIGN_CODE_DIFFERS');
  if (observed.anonymous !== undefined && observed.anonymous.status !== 401)
    found.push('ANONYMOUS_NOT_REFUSED');
  return found;
}

/**
 * A sealed artifact must open when intact and must not open when any byte changed. `open` reports
 * only whether plaintext was returned.
 */
export async function tamperViolations(
  open: (bytes: Uint8Array) => Promise<boolean>,
  intact: Uint8Array,
  position: number,
): Promise<string[]> {
  const found: string[] = [];
  if (!(await open(intact))) found.push('INTACT_ARTIFACT_REFUSED');
  const changed = Uint8Array.from(intact);
  changed[position] = (changed[position] ?? 0) ^ 0xff;
  if (await open(changed)) found.push('TAMPERED_ARTIFACT_OPENED');
  return found;
}

/**
 * A client-supplied "approved" flag, ticket or signature field must change nothing: the request is
 * refused and the operation neither advances nor broadcasts.
 */
export function forgedApprovalViolations(observed: {
  readonly status: number;
  readonly phaseBefore: string;
  readonly phaseAfter: string;
  readonly transactionCountBefore: number;
  readonly transactionCountAfter: number;
}): string[] {
  const found: string[] = [];
  if (observed.status < 400) found.push('FORGED_APPROVAL_ACCEPTED');
  if (observed.phaseAfter !== observed.phaseBefore) found.push('OPERATION_ADVANCED');
  if (observed.transactionCountAfter !== observed.transactionCountBefore)
    found.push('TRANSACTION_BROADCAST');
  return found;
}

/**
 * After a confirmation, a later observation that disagrees about the canonical block is a
 * contradiction: it is reported as one, is not a second confirmation, and neither moves nor removes
 * the stored confirmation.
 */
export function chainContradictionViolations(observed: {
  readonly mismatch: string | null;
  readonly outcome: string;
  readonly storedPhase: string;
  readonly storedBlockHashBefore: string;
  readonly storedBlockHashAfter: string;
}): string[] {
  const found: string[] = [];
  if (observed.mismatch !== 'CONTRADICTS_CONFIRMED') found.push('CONTRADICTION_NOT_REPORTED');
  if (observed.outcome === 'confirmed') found.push('RECONFIRMED_ON_CONTRADICTION');
  if (observed.storedPhase !== 'confirmed') found.push('STORED_CONFIRMATION_REMOVED');
  if (observed.storedBlockHashAfter !== observed.storedBlockHashBefore)
    found.push('STORED_BLOCK_HASH_MOVED');
  return found;
}
