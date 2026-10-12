import { verifyReviewExport, type VerifyReviewExportResult } from '@lexaegis/sdk/verify';

/*
 * Read-only verification of a readable review export against a reference you obtained separately.
 * It loads no operator key and no storage key, signs nothing and sends nothing; the registry is read
 * only when a trusted policy and an endpoint are supplied. Matching files and an Active receipt do
 * not show that the code is safe, who wrote it, that tests ran, or that anything may be merged: they
 * show that these exact bytes were approved by the account that signed the receipt.
 */
export interface VerifySignoffInput {
  readonly exportBytes: Uint8Array;
  readonly expectedReference: unknown;
  readonly live?: {
    readonly policy: unknown;
    readonly rpcUrl: string;
    readonly allowLoopbackHttp?: boolean;
  };
}

export function verifySignoff(input: VerifySignoffInput): Promise<VerifyReviewExportResult> {
  return verifyReviewExport({
    file: input.exportBytes,
    expectedReference: input.expectedReference,
    ...(input.live !== undefined && {
      live: {
        policy: input.live.policy,
        transport: {
          kind: 'rpc' as const,
          url: input.live.rpcUrl,
          ...(input.live.allowLoopbackHttp === true && { allowLoopbackHttp: true }),
        },
      },
    }),
  });
}
