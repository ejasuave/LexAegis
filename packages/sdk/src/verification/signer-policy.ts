import { z } from 'zod';
import { nonZeroAddressSchema, type ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import type { ObservedReceipt } from '../registry/decode';
import type { SignerAcceptance } from '@lexaegis/protocol';

/**
 * A caller-owned rule for which reviewer accounts a recipient accepts. It sees the public
 * reference and, when a live read succeeded, the validated observation. It cannot read imported
 * labels, account names or the transaction sender, and nothing here certifies a professional
 * qualification: "accepted" means only that the account meets the rule the caller selected.
 */
export interface SignerAcceptancePolicy {
  /** Stable identifier shown in reports. */
  readonly id: string;
  evaluate(input: {
    readonly reference: ReceiptReferenceV1;
    readonly observation: ObservedReceipt | null;
  }): SignerAcceptance;
}

const policyIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/);

/**
 * The minimal policy: accept exactly the listed reviewer addresses (lowercase 0x addresses).
 * Any other reviewer is rejected. An empty list is refused rather than rejecting everyone.
 */
export function expectedReviewersPolicy(
  id: string,
  addresses: readonly string[],
): SignerAcceptancePolicy {
  const parsedId = policyIdSchema.parse(id);
  if (addresses.length === 0 || addresses.length > 256) throw new RangeError('addresses');
  const allowed = new Set(addresses.map((address) => nonZeroAddressSchema.parse(address)));
  return {
    id: parsedId,
    evaluate: ({ reference }) => (allowed.has(reference.reviewerAddress) ? 'accepted' : 'rejected'),
  };
}

export const signerAcceptanceResultSchema = z.enum(['accepted', 'rejected', 'unknown']);

/** Runs a caller policy defensively: an exception or a malformed answer is "unknown". */
export function evaluateSignerPolicy(
  policy: SignerAcceptancePolicy | undefined,
  reference: ReceiptReferenceV1,
  observation: ObservedReceipt | null,
): {
  readonly acceptance: SignerAcceptance;
  readonly issue: 'SIGNER_POLICY_ABSENT' | 'SIGNER_POLICY_ERROR' | null;
} {
  if (policy === undefined) return { acceptance: 'unknown', issue: 'SIGNER_POLICY_ABSENT' };
  try {
    const result = signerAcceptanceResultSchema.safeParse(
      policy.evaluate({ reference, observation }),
    );
    return result.success
      ? { acceptance: result.data, issue: null }
      : { acceptance: 'unknown', issue: 'SIGNER_POLICY_ERROR' };
  } catch {
    return { acceptance: 'unknown', issue: 'SIGNER_POLICY_ERROR' };
  }
}
