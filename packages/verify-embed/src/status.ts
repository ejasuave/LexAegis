import { verifyReceipt, type VerifyReceiptInput } from '@lexaegis/sdk/verify';
import type { FetchLike } from '@lexaegis/sdk/verify';
import { EMBED_LIMITS, deploymentKey, type ResolvedConfig } from './config';
import type { InputSnapshot } from './inputs';

/*
 * One bounded, read-only status read through the SDK. The widget adds no registry logic and no new
 * enum: the SDK's lifecycle result is mapped to the five visible words, and everything that is not
 * an authoritative read of the configured registry is `unknown`, never `not_found`.
 */

export const LIFECYCLE_STATES = [
  'active',
  'revoked',
  'superseded',
  'not_found',
  'unknown',
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export interface CheckpointContext {
  readonly blockNumber: string;
  readonly blockTimestamp: string;
}

export interface StatusObservation {
  readonly state: LifecycleState;
  readonly observedAt: string;
  readonly checkpoint: CheckpointContext | null;
  /** Content-free SDK issue codes, for the compact explanation of an `unknown`. */
  readonly issues: readonly string[];
}

export interface ReadStatusOptions {
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

const unknown = (issues: readonly string[], observedAt: string): StatusObservation => ({
  state: 'unknown',
  observedAt,
  checkpoint: null,
  issues,
});

export async function readStatus(
  input: InputSnapshot,
  config: ResolvedConfig,
  options: ReadStatusOptions = {},
): Promise<StatusObservation> {
  const now = options.now ?? (() => new Date());
  const deployment = config.deployments.get(
    deploymentKey(input.reference.chainId, input.reference.registryAddress),
  );
  if (deployment === undefined) return unknown(['DEPLOYMENT_NOT_TRUSTED'], now().toISOString());

  const request: VerifyReceiptInput = {
    mode: 'reference-only',
    expectedReference: input.reference,
    referenceOrigin: 'independent',
    live: {
      policy: deployment.policy,
      transport: {
        kind: 'rpc',
        url: input.rpcUrl,
        ...(options.fetch !== undefined && { fetch: options.fetch }),
        ...(config.allowLoopbackHttp && { allowLoopbackHttp: true }),
      },
    },
    budget: { totalMs: EMBED_LIMITS.refreshMs, maxAttempts: EMBED_LIMITS.refreshAttempts },
    ...(options.signal !== undefined && { signal: options.signal }),
    now,
  };
  let result;
  try {
    result = await verifyReceipt(request);
  } catch {
    return unknown(['LIVE_RPC_UNAVAILABLE'], now().toISOString());
  }
  if (!result.ok) return unknown([result.error.code], now().toISOString());
  const { report } = result.data;
  const issues = report.issues.map((issue) => issue.code);
  // Only a read of the configured, identity-checked registry can establish any lifecycle word,
  // including absence.
  if (report.registryIdentity !== 'match' || report.chainStatus === 'unknown')
    return unknown(issues, report.observedAt);
  return {
    state: report.chainStatus,
    observedAt: report.observedAt,
    checkpoint:
      report.checkpoint === null
        ? null
        : {
            blockNumber: report.checkpoint.blockNumber,
            blockTimestamp: report.checkpoint.blockTimestamp,
          },
    issues,
  };
}
