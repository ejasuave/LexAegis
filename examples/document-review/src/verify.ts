import { parseReviewExport } from '@lexaegis/sdk/portable';
import {
  expectedReviewersPolicy,
  type SignerAcceptancePolicy,
  type VerificationReportV1,
} from '@lexaegis/sdk/offline';
import { verifyReceipt } from '@lexaegis/sdk/verify';

export interface VerifyOptions {
  readonly bundle: Uint8Array;
  /** The reference you were given independently of the bundle. Required: it is never read from the bundle. */
  readonly expectedReference: unknown;
  /** All three together enable the live registry check; without them chain state stays unknown. */
  readonly live?: { readonly rpcUrl: string; readonly policy: unknown };
  readonly reviewers?: readonly string[];
}

export type VerifyOutput =
  | { readonly ok: true; readonly report: VerificationReportV1 }
  | { readonly ok: false; readonly code: string };

/**
 * Reads a readable bundle and checks it against an EXPLICIT expected reference. The bundle's own
 * declared reference is passed only for a conflict check. Live reads happen only when `live` is
 * supplied; the RPC address comes from the caller, never from the bundle.
 */
export async function verifyExample(options: VerifyOptions): Promise<VerifyOutput> {
  const decoded = parseReviewExport(options.bundle);
  if (!decoded.ok) return { ok: false, code: decoded.error.code };
  const signerPolicy: SignerAcceptancePolicy | undefined =
    options.reviewers === undefined || options.reviewers.length === 0
      ? undefined
      : expectedReviewersPolicy('example.reviewers', options.reviewers);
  const result = await verifyReceipt({
    mode: 'full-package',
    expectedReference: options.expectedReference,
    referenceOrigin: 'independent',
    declaredReference: decoded.data.declaredReference,
    opening: decoded.data.opening,
    artifacts: decoded.data.artifacts,
    ...(signerPolicy !== undefined && { signerPolicy }),
    ...(options.live !== undefined && {
      live: {
        policy: options.live.policy,
        transport: { kind: 'rpc' as const, url: options.live.rpcUrl },
      },
    }),
  });
  return result.ok
    ? { ok: true, report: result.data.report }
    : { ok: false, code: result.error.code };
}
