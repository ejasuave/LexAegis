import { z } from 'zod';
import {
  parseCommitmentOpening,
  parseReceiptReference,
  type ReceiptReferenceV1,
} from '@lexaegis/protocol/v1';
import { receiptLifecycleSchema } from '@lexaegis/protocol';
import { failWith, succeed, type RegistryResult } from './errors';
import { observedReceiptSchema, type ObservedReceipt } from './decode';

export const BINDING_ISSUE_CODES = [
  /** The opening was prepared for a different chain, registry or reviewer than the reference. */
  'OPENING_CONTEXT_MISMATCH',
  /** The observed record is for a different chain, registry, reviewer or commitment. */
  'RECEIPT_TUPLE_MISMATCH',
  /** The record's predecessor is not the one the manifest declares (or declares none). */
  'PREDECESSOR_MISMATCH',
  /** A status, link and time combination the registry can never produce. */
  'IMPOSSIBLE_RECORD',
] as const;

/**
 * How an observed registry record relates to a package.
 *
 * - `match`: the record is the receipt for this package; `receiptLifecycle` is its status.
 * - `absent`: the lookup tuple is right and the registry holds no such receipt.
 * - `mismatch`: the record cannot be taken as this package's receipt; lifecycle is "unknown".
 *
 * This is one dimension only. It says nothing about file integrity (verify the opening and
 * artifacts separately), about whether the RPC source is trustworthy, or about whether the
 * reviewer is someone the caller accepts. There is no combined "valid" flag.
 */
export const receiptBindingSchema = z.strictObject({
  binding: z.enum(['match', 'mismatch', 'absent']),
  receiptLifecycle: receiptLifecycleSchema,
  issues: z.array(z.enum(BINDING_ISSUE_CODES)),
});
export type ReceiptBinding = z.infer<typeof receiptBindingSchema>;
type BindingIssue = ReceiptBinding['issues'][number];

/** True when the registry's own rules could have produced this record. */
function isPossibleRecord(record: ObservedReceipt): boolean {
  const { receiptLifecycle, predecessor, successor, commitment } = record;
  const issuedAt = BigInt(record.issuedAt);
  const updatedAt = BigInt(record.updatedAt);

  if (receiptLifecycle === 'not_found') {
    return predecessor === null && successor === null && issuedAt === 0n && updatedAt === 0n;
  }
  if (issuedAt === 0n || updatedAt < issuedAt) return false;
  if (predecessor === commitment) return false;
  if (receiptLifecycle === 'superseded') {
    // Exactly one successor, which is a different commitment and not the predecessor.
    return successor !== null && successor !== commitment && successor !== predecessor;
  }
  if (successor !== null) return false;
  // An Active receipt has not changed since it was issued.
  return receiptLifecycle === 'revoked' || updatedAt === issuedAt;
}

/**
 * Opening-free checks of an observed record against the reference it was read for: the tuple
 * matches and the registry's own rules could have produced the record. Used when no verified
 * opening is available (reference-only checks and successor links).
 *
 * @example
 * ```ts
 * import { observedRecordIssues } from '@lexaegis/sdk/registry';
 * import type { ObservedReceipt } from '@lexaegis/sdk/registry';
 * import type { ReceiptReferenceV1 } from '@lexaegis/sdk';
 *
 * declare const reference: ReceiptReferenceV1;
 * declare const record: ObservedReceipt;
 * console.log(observedRecordIssues(reference, record)); // [] when the record fits the reference
 * ```
 */
export function observedRecordIssues(
  reference: ReceiptReferenceV1,
  record: ObservedReceipt,
): BindingIssue[] {
  const issues: BindingIssue[] = [];
  if (
    record.chainId !== reference.chainId ||
    record.registryAddress !== reference.registryAddress ||
    record.reviewerAddress !== reference.reviewerAddress ||
    record.commitment !== reference.commitment
  ) {
    issues.push('RECEIPT_TUPLE_MISMATCH');
  }
  if (!isPossibleRecord(record)) issues.push('IMPOSSIBLE_RECORD');
  return issues;
}

/**
 * Compares a verified opening and its public reference with a record observed in the registry.
 *
 * The caller must already have verified the opening against the reference (verifyManifestOpening
 * or verifyReviewPackage); this pure helper does not recompute any hash. It checks that:
 * the opening, the reference and the record all name one chain, registry and reviewer; the record
 * is for the reference's commitment; and the record's predecessor equals `manifest.supersedes`,
 * or is absent when the manifest supersedes nothing.
 *
 * A Superseded record stays Superseded whatever later happened to its successor: revoking a
 * replacement never makes the earlier receipt Active again, and nothing here infers that.
 *
 * @example
 * ```ts
 * import { validateReceiptBinding } from '@lexaegis/sdk/registry';
 *
 * declare const opening: unknown; // already verified against the reference
 * declare const reference: unknown;
 * declare const observed: unknown; // a decoded registry record
 * const binding = validateReceiptBinding({ opening, reference, observed });
 * if (binding.ok) console.log(binding.data.binding); // "match" | "absent" | "mismatch"
 * ```
 */
export function validateReceiptBinding(input: {
  readonly opening: unknown;
  readonly reference: unknown;
  readonly observed: unknown;
}): RegistryResult<ReceiptBinding> {
  const reference = parseReceiptReference(input.reference);
  if (!reference.ok) return failWith('REFERENCE_INVALID', reference.error.path?.split('.'));
  const opening = parseCommitmentOpening(input.opening);
  if (!opening.ok) return failWith('OPENING_INVALID', opening.error.path?.split('.'));
  const observed = observedReceiptSchema.safeParse(input.observed);
  if (!observed.success) return failWith('OBSERVATION_INVALID', observed.error.issues[0]?.path);

  const expected = reference.data;
  const record = observed.data;
  const { context, supersedes } = opening.data.manifest;
  const issues: BindingIssue[] = [];

  if (
    context.chainId !== expected.chainId ||
    context.registryAddress !== expected.registryAddress ||
    context.reviewerAddress !== expected.reviewerAddress
  ) {
    issues.push('OPENING_CONTEXT_MISMATCH');
  }
  if (
    record.chainId !== expected.chainId ||
    record.registryAddress !== expected.registryAddress ||
    record.reviewerAddress !== expected.reviewerAddress ||
    record.commitment !== expected.commitment
  ) {
    issues.push('RECEIPT_TUPLE_MISMATCH');
  }
  if (!isPossibleRecord(record)) issues.push('IMPOSSIBLE_RECORD');
  if (
    record.receiptLifecycle !== 'not_found' &&
    record.predecessor !== (supersedes?.commitment ?? null)
  ) {
    issues.push('PREDECESSOR_MISMATCH');
  }

  if (issues.length > 0)
    return succeed({ binding: 'mismatch', receiptLifecycle: 'unknown', issues });
  if (record.receiptLifecycle === 'not_found') {
    return succeed({ binding: 'absent', receiptLifecycle: 'not_found', issues });
  }
  return succeed({ binding: 'match', receiptLifecycle: record.receiptLifecycle, issues });
}
