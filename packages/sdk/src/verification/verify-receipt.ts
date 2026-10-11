import type { ProtocolFailure } from '@lexaegis/protocol/v1';
import {
  BudgetError,
  LiveBudget,
  type BudgetFailure,
  type LiveBudgetOptions,
} from '../registry/budget';
import { observedRecordIssues } from '../registry/binding';
import {
  readChainCheckpoint,
  readReceiptAtCheckpoint,
  type ChainCheckpoint,
  type ChainPolicy,
  type LiveChainClient,
  type LiveResult,
  type LiveUnknownReason,
} from '../registry/live-reader';
import { createRpcLiveClient, parseRpcEndpoint, type FetchLike } from '../registry/rpc-client';
import type { ObservedReceipt } from '../registry/decode';
import {
  offlineVerificationSchema,
  verifyOffline,
  type OfflineInput,
  type OfflineVerification,
} from './offline';
import {
  VERIFICATION_REPORT_SCHEMA,
  registryPolicySchema,
  verificationReportV1Schema,
  type ChainStatus,
  type CheckResult,
  type RegistryPolicy,
  type ReportIssue,
  type ReportIssueCode,
  type SuccessorObservation,
  type VerificationReportV1,
} from './report';
import { evaluateSignerPolicy, type SignerAcceptancePolicy } from './signer-policy';

/*
 * verifyReceipt composes offline checks, optional live registry reads, receipt binding and a
 * caller's signer policy. Network access happens only when the caller supplies `live`; a parsed
 * file alone never triggers it. Failures in the live part never discard the local result.
 */

/** Maximum successor links inspected after a Superseded receipt. */
export const MAX_SUCCESSOR_LINKS = 8;

export type LiveTransport =
  | {
      readonly kind: 'rpc';
      /** Public HTTPS JSON-RPC endpoint chosen by the caller. Never taken from an imported file. */
      readonly url: string;
      readonly fetch?: FetchLike;
      /** Test-only: permits http://127.0.0.1 for an isolated local chain. */
      readonly allowLoopbackHttp?: boolean;
    }
  | { readonly kind: 'client'; readonly client: LiveChainClient };

export interface LiveOptions {
  /** The caller-trusted registry deployment. Validated against registryPolicySchema. */
  readonly policy: unknown;
  readonly transport: LiveTransport;
  /** Also read a bounded chain of successors at the same checkpoint (Superseded receipts only). */
  readonly inspectSuccessors?: boolean;
}

export interface VerifyReceiptInput extends OfflineInput {
  /**
   * An offline result already computed on this device (for example by a worker, with the artifact
   * bytes long discarded). It is re-validated and used instead of re-verifying; the other offline
   * fields are then ignored. Never accept one from an untrusted source.
   */
  readonly offline?: unknown;
  readonly live?: LiveOptions;
  readonly signerPolicy?: SignerAcceptancePolicy;
  readonly signal?: AbortSignal;
  /** Opaque tag echoed in the result so callers can discard stale results. */
  readonly generation?: number;
  /** Injected clock; the observation time is read once. */
  readonly now?: () => Date;
  readonly budget?: LiveBudgetOptions;
}

export type VerifyReceiptFailure = ProtocolFailure | { readonly code: 'ABORTED' };

export type VerifyReceiptResult =
  | {
      readonly ok: true;
      readonly data: { readonly generation: number; readonly report: VerificationReportV1 };
    }
  | { readonly ok: false; readonly error: VerifyReceiptFailure };

const LIVE_REASON_ISSUE: Record<LiveUnknownReason, ReportIssueCode> = {
  RPC_UNAVAILABLE: 'LIVE_RPC_UNAVAILABLE',
  WRONG_CHAIN: 'LIVE_WRONG_CHAIN',
  FINALIZED_UNAVAILABLE: 'LIVE_FINALIZED_UNAVAILABLE',
  BELOW_DEPLOYMENT: 'LIVE_BELOW_DEPLOYMENT',
  CODE_MISMATCH: 'LIVE_CODE_MISMATCH',
  PROTOCOL_MISMATCH: 'LIVE_PROTOCOL_MISMATCH',
  BLOCK_CHANGED: 'LIVE_BLOCK_CHANGED',
  RESPONSE_INVALID: 'LIVE_RESPONSE_INVALID',
  POLICY_INVALID: 'REGISTRY_POLICY_INVALID',
};
/** Reasons that mean the deployment the RPC shows is not the one the caller trusts. */
const IDENTITY_MISMATCH: ReadonlySet<LiveUnknownReason> = new Set([
  'WRONG_CHAIN',
  'CODE_MISMATCH',
  'PROTOCOL_MISMATCH',
]);
const BUDGET_ISSUE: Record<BudgetFailure, ReportIssueCode> = {
  DEADLINE: 'LIVE_DEADLINE',
  ATTEMPTS: 'LIVE_ATTEMPTS_EXHAUSTED',
  ABORTED: 'LIVE_ABORTED',
  TIMEOUT: 'LIVE_TIMEOUT',
};

function toChainPolicy(policy: RegistryPolicy): ChainPolicy {
  return {
    chainId: policy.chainId,
    registryAddress: policy.registryAddress,
    deploymentBlock: policy.deploymentBlock,
    runtimeCodeKeccak256: policy.runtimeCodeKeccak256,
    executionDelayBlocks: policy.executionDelayBlocks,
    executionDelayRevision: policy.executionDelayRevision,
  };
}

/** Applies the shared budget to any caller-supplied client. Reads are raced against the budget. */
function budgeted(client: LiveChainClient, budget: LiveBudget): LiveChainClient {
  const guard = <T>(run: () => Promise<T>): Promise<T> =>
    budget.run(
      (signal) =>
        new Promise<T>((resolve, reject) => {
          const stop = () => reject(new Error('stopped'));
          if (signal.aborted) {
            stop();
            return;
          }
          signal.addEventListener('abort', stop, { once: true });
          run().then(resolve, reject);
        }),
    );
  return {
    getChainId: () => guard(() => client.getChainId()),
    getBlock: (selector) => guard(() => client.getBlock(selector)),
    getCode: (args) => guard(() => client.getCode(args)),
    call: (args) => guard(() => client.call(args)),
  };
}

interface LiveOutcome {
  registryIdentity: CheckResult;
  receiptBinding: CheckResult;
  chainStatus: ChainStatus;
  checkpoint: ChainCheckpoint | null;
  observation: ObservedReceipt | null;
  history: VerificationReportV1['history'];
  registryPolicyId: string | null;
  issues: ReportIssue[];
}

const emptyOutcome = (): LiveOutcome => ({
  registryIdentity: 'unknown',
  receiptBinding: 'unknown',
  chainStatus: 'unknown',
  checkpoint: null,
  observation: null,
  history: null,
  registryPolicyId: null,
  issues: [],
});

async function runLive(
  live: LiveOptions,
  offline: OfflineVerification,
  options: Pick<VerifyReceiptInput, 'signal' | 'now' | 'budget'>,
): Promise<LiveOutcome> {
  const out = emptyOutcome();
  const parsed = registryPolicySchema.safeParse(live.policy);
  if (!parsed.success) {
    out.issues.push({ code: 'REGISTRY_POLICY_INVALID' });
    return out;
  }
  const policy = parsed.data;
  out.registryPolicyId = policy.id;
  const reference = offline.expectedReference;
  if (
    reference.chainId !== policy.chainId ||
    reference.registryAddress !== policy.registryAddress
  ) {
    // The receipt names a deployment the caller does not trust: no network read is made.
    out.registryIdentity = 'mismatch';
    out.issues.push({ code: 'REGISTRY_POLICY_MISMATCH' });
    return out;
  }

  const budget = new LiveBudget(options.budget, options.signal);
  const now = options.now ?? (() => new Date());
  try {
    let client: LiveChainClient;
    if (live.transport.kind === 'rpc') {
      const endpoint = parseRpcEndpoint(live.transport.url, {
        allowLoopbackHttp: live.transport.allowLoopbackHttp === true,
      });
      if (!endpoint.ok) {
        out.issues.push({ code: 'REGISTRY_POLICY_INVALID' });
        return out;
      }
      client = createRpcLiveClient({
        url: live.transport.url,
        budget,
        ...(live.transport.fetch !== undefined && { fetch: live.transport.fetch }),
        ...(live.transport.allowLoopbackHttp === true && { allowLoopbackHttp: true }),
      });
    } else {
      client = budgeted(live.transport.client, budget);
    }

    const unknown = (result: Extract<LiveResult<unknown>, { status: 'unknown' }>): LiveOutcome => {
      // A budget stop is the honest cause when the reader reports a generic RPC failure.
      const budgetCause = budget.lastFailure;
      if (budgetCause !== null && result.reason === 'RPC_UNAVAILABLE') {
        out.issues.push({ code: BUDGET_ISSUE[budgetCause] });
      } else {
        out.issues.push({ code: LIVE_REASON_ISSUE[result.reason] });
      }
      if (IDENTITY_MISMATCH.has(result.reason)) out.registryIdentity = 'mismatch';
      return out;
    };

    const chainPolicy = toChainPolicy(policy);
    const checkpoint = await readChainCheckpoint(client, chainPolicy, now);
    if (checkpoint.status !== 'ok') return unknown(checkpoint);

    // The caller pins the genesis block: the same chain ID on a different chain is a mismatch.
    const genesis = await client.getBlock({ blockNumber: 0n });
    if (genesis === null) {
      out.issues.push({ code: 'LIVE_RESPONSE_INVALID' });
      return out;
    }
    if (genesis.hash.toLowerCase() !== policy.genesisHash) {
      out.registryIdentity = 'mismatch';
      out.issues.push({ code: 'LIVE_GENESIS_MISMATCH' });
      return out;
    }

    const read = await readReceiptAtCheckpoint(client, chainPolicy, checkpoint.data, {
      reference,
      ...(offline.verifiedOpening !== null && { opening: offline.verifiedOpening }),
    });
    if (read.status !== 'ok') return unknown(read);

    out.registryIdentity = 'match';
    out.checkpoint = read.data.checkpoint;
    out.observation = read.data.receipt;

    if (read.data.binding !== null) {
      const { binding, receiptLifecycle, issues } = read.data.binding;
      for (const issue of issues) out.issues.push({ code: issue });
      if (binding === 'match') {
        out.receiptBinding = 'match';
        out.chainStatus = receiptLifecycle;
      } else if (binding === 'absent') {
        // No receipt exists to bind to. The absence is a successful, verified registry read.
        out.chainStatus = 'not_found';
      } else {
        out.receiptBinding = 'mismatch';
      }
    } else {
      out.issues.push({ code: 'BINDING_NOT_EVALUATED' });
      const problems = observedRecordIssues(reference, read.data.receipt);
      for (const issue of problems) out.issues.push({ code: issue });
      if (problems.length === 0) out.chainStatus = read.data.receipt.receiptLifecycle;
    }

    if (
      live.inspectSuccessors === true &&
      out.chainStatus === 'superseded' &&
      read.data.receipt.successor !== null
    ) {
      const successors: SuccessorObservation[] = [];
      const visited = new Set<string>([reference.commitment]);
      let previous: string = reference.commitment;
      let next: string | null = read.data.receipt.successor;
      let complete = true;
      while (next !== null) {
        if (successors.length >= MAX_SUCCESSOR_LINKS) {
          complete = false;
          out.issues.push({ code: 'SUCCESSOR_LIMIT_EXHAUSTED' });
          break;
        }
        if (visited.has(next)) {
          complete = false;
          out.issues.push({ code: 'SUCCESSOR_CYCLE' });
          break;
        }
        visited.add(next);
        const link = { ...reference, commitment: next };
        const step = await readReceiptAtCheckpoint(client, chainPolicy, read.data.checkpoint, {
          reference: link,
        });
        if (step.status !== 'ok') {
          complete = false;
          out.issues.push({ code: 'SUCCESSOR_UNREADABLE' });
          break;
        }
        const record = step.data.receipt;
        // Reciprocal link, exact scope and a receipt that exists: otherwise the chain is untrusted.
        if (
          record.receiptLifecycle === 'not_found' ||
          record.predecessor !== previous ||
          observedRecordIssues(link, record).length > 0
        ) {
          complete = false;
          out.issues.push({ code: 'SUCCESSOR_LINK_INVALID' });
          break;
        }
        successors.push({
          reference: link,
          chainStatus: record.receiptLifecycle,
          packageIntegrity: 'unknown',
        });
        previous = next;
        next = record.receiptLifecycle === 'superseded' ? record.successor : null;
      }
      out.history = { complete, successors };
    }
    return out;
  } catch (error) {
    // Anything the budget cut short, or an unexpected transport failure, leaves local results intact.
    const cause = budget.lastFailure;
    out.issues.push({
      code:
        error instanceof BudgetError
          ? BUDGET_ISSUE[error.failure]
          : cause !== null
            ? BUDGET_ISSUE[cause]
            : 'LIVE_RPC_UNAVAILABLE',
    });
    return out;
  } finally {
    budget.dispose();
  }
}

/**
 * Verifies a receipt. Offline checks always run first and are kept whatever happens afterwards.
 * Live checks run only when `live` is supplied. The report is an observation at `observedAt`, not
 * a certificate: an earlier Active result says nothing about status after a later revocation or
 * replacement. profileSemantics is `not_evaluated`: no business or legal content is assessed.
 */
export async function verifyReceipt(input: VerifyReceiptInput): Promise<VerifyReceiptResult> {
  if (input.signal?.aborted === true) return { ok: false, error: { code: 'ABORTED' } };
  const generation = input.generation ?? 0;
  // The observation time is read once, here; pure verification below stays deterministic.
  const observedAt = (input.now ?? (() => new Date()))().toISOString();

  let offline: { readonly ok: true; readonly data: OfflineVerification };
  if (input.offline === undefined) {
    const computed = await verifyOffline(input);
    if (!computed.ok) return computed;
    offline = computed;
  } else {
    const checked = offlineVerificationSchema.safeParse(input.offline);
    if (!checked.success) return { ok: false, error: { code: 'SCHEMA_INVALID', path: 'offline' } };
    offline = { ok: true, data: checked.data };
  }

  let outcome = emptyOutcome();
  if (input.live === undefined) outcome.issues.push({ code: 'NETWORK_NOT_REQUESTED' });
  else outcome = await runLive(input.live, offline.data, input);

  const signer = evaluateSignerPolicy(
    input.signerPolicy,
    offline.data.expectedReference,
    outcome.observation,
  );
  const issues: ReportIssue[] = [...offline.data.issues, ...outcome.issues];
  if (signer.issue !== null) issues.push({ code: signer.issue });

  const report = verificationReportV1Schema.safeParse({
    schema: VERIFICATION_REPORT_SCHEMA,
    mode: offline.data.mode,
    expectedReference: offline.data.expectedReference,
    referenceOrigin: offline.data.referenceOrigin,
    manifestIntegrity: offline.data.manifestIntegrity,
    artifactIntegrity: offline.data.artifactIntegrity,
    registryIdentity: outcome.registryIdentity,
    receiptBinding: outcome.receiptBinding,
    chainStatus: outcome.chainStatus,
    signerAcceptance: signer.acceptance,
    checkpoint: outcome.checkpoint,
    registryPolicyId: outcome.registryPolicyId,
    signerPolicyId: input.signerPolicy?.id ?? null,
    profile: offline.data.profile,
    profileSemantics: 'not_evaluated',
    history: outcome.history,
    observedAt,
    issues,
  });
  if (!report.success) return { ok: false, error: { code: 'SCHEMA_INVALID', path: 'report' } };
  return { ok: true, data: { generation, report: report.data } };
}
