import {
  REVIEW_ACTION_CODES,
  ZERO_BYTES32,
  boundReviewActionSchema,
  buildRevokeAction,
  defaultActionDeadline,
  type BoundReviewAction,
} from '@lexaegis/sdk/registry';
import { parseReceiptReference, type ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import type {
  AccountResult,
  PreviewTicket,
  ReviewGate,
  ReviewSigning,
  SignedReviewAction,
} from '@/features/account/public';
import type { LiveState, LiveStateReader } from '@/features/transactions/public';
import { decisionLogSchema, type ReviewDecisionLogV1 } from './decisions';

/*
 * Stage one of two: the explicit human authorisation of one exact registry action. This module
 * is the only code that binds the review gate. The gate is re-evaluated by the signing controller
 * at every preview and every confirmation and consults live facts only:
 *   - a capture rebuilt by retrieval and verification in THIS unlock (never a stored flag),
 *   - the decision log inside that verified package, validated here (never UI state),
 *   - a live registry read no older than 15 seconds,
 *   - the same account, account generation and vault generation as the preview.
 * Chat, voice, model output, imported JSON and HTTP callers have no path to approve(): it needs a
 * trusted user activation and returns the signature only to the submission controller.
 */

export const PREFLIGHT_FRESHNESS_MS = 15_000;

export type ApprovalTarget =
  | { readonly kind: 'issue'; readonly commitment: string }
  | { readonly kind: 'supersede'; readonly commitment: string }
  | { readonly kind: 'revoke'; readonly reference: ReceiptReferenceV1 };

export type ApprovalStage = 'idle' | 'checking' | 'preview' | 'signing' | 'signed' | 'failed';

export type ApprovalFailure =
  | 'NO_ACCOUNT'
  | 'SESSION_LOCKED'
  | 'BACKEND_SIGNED_OUT'
  | 'NO_REGISTRY'
  | 'CAPTURE_NOT_VERIFIED'
  | 'USE_SUPERSEDE'
  | 'NOT_A_REPLACEMENT'
  | 'SCOPE_MISMATCH'
  | 'DECISION_LOG_INVALID'
  | 'CHAIN_UNKNOWN'
  | 'STALE_OBSERVATION'
  | 'LIFECYCLE_REJECTED'
  | 'CHANGED'
  | 'ACTION_INVALID'
  | 'PREVIEW_REFUSED'
  | 'NOT_TRUSTED'
  | 'NO_PREVIEW'
  | 'BUSY'
  | 'PREVIEW_EXPIRED'
  | 'USER_CANCELLED'
  | 'SIGNING_FAILED'
  | 'STALE';

export interface ApprovalDisplay {
  readonly kind: ApprovalTarget['kind'];
  readonly reviewer: string;
  readonly chainId: string;
  readonly registryAddress: string;
  /** The receipt this action is about. For supersede, the replacement. */
  readonly commitment: string;
  /** For supersede: the Active receipt that would be replaced. */
  readonly predecessor: string | null;
  readonly nonce: string;
  /** Unix seconds. The registry rejects the action after this time. */
  readonly deadline: string;
  readonly observedBlock: string;
  readonly observedAt: string;
  readonly scope: {
    readonly artifactCount: number;
    readonly roles: readonly { readonly role: string; readonly count: number }[];
  } | null;
  readonly rulePackReviewState: 'demo_draft' | 'reviewed' | null;
  readonly decisionCount: number;
  readonly concerns: readonly { readonly findingId: string; readonly reason: string }[];
}

export interface ApprovalSnapshot {
  readonly stage: ApprovalStage;
  readonly display: ApprovalDisplay | null;
  readonly failure: ApprovalFailure | null;
  readonly notice: string;
}

const EMPTY: ApprovalSnapshot = Object.freeze({
  stage: 'idle',
  display: null,
  failure: null,
  notice: '',
});
export const EMPTY_APPROVAL_SNAPSHOT = EMPTY;

export interface ApprovalAccountView {
  readonly address: string | null;
  readonly generation: number;
  readonly signing: 'locked' | 'unlocked';
  readonly backend: 'unknown' | 'signed_out' | 'signing_in' | 'signed_in' | 'unavailable';
}

export interface ApprovalVaultPort {
  getSnapshot(): { readonly generation: number };
  subscribe(listener: () => void): () => void;
  recoverableSubject(commitment: string): {
    readonly capture: { readonly generation: number; readonly commitment: string };
    readonly reference: ReceiptReferenceV1;
    readonly supersedes: ReceiptReferenceV1 | null;
    readonly artifacts: readonly { id: string; role: string }[];
    readonly scopeArtifactIds: readonly string[];
    readonly decisionLogBytes: Uint8Array | null;
  } | null;
}

export interface ApprovalDeps {
  readonly review: Pick<ReviewSigning, 'preview' | 'confirm' | 'owns' | 'invalidateAll'>;
  readonly bindGate: (check: ReviewGate) => () => void;
  readonly account: () => ApprovalAccountView;
  readonly onAccountChange: (listener: () => void) => () => void;
  readonly vault: ApprovalVaultPort;
  readonly config: () => { readonly chainId: string; readonly registryAddress: string | null };
  readonly live: LiveStateReader;
  /** Unix milliseconds. */
  readonly now: () => number;
}

/** What the transaction stage needs, once, after a successful signature. */
export interface Authorisation {
  readonly signed: SignedReviewAction;
  readonly request: {
    readonly kind: 'execute';
    readonly action: BoundReviewAction;
    readonly packageReference: ReceiptReferenceV1;
  };
}

interface Context {
  readonly target: ApprovalTarget;
  readonly reviewer: string;
  readonly accountGeneration: number;
  readonly vaultGeneration: number;
  readonly captureGeneration: number | null;
  readonly commitments: readonly {
    readonly commitment: string;
    readonly expect: 'not_found' | 'active';
  }[];
  readonly nonce: string;
  readonly deadline: string;
  readonly action: BoundReviewAction;
  readonly reference: ReceiptReferenceV1;
  observedAtMs: number;
}

const fail = <T>(code: 'UNAVAILABLE' | 'STALE'): AccountResult<T> => ({ ok: false, code });

/** Reads the decision log a verified package commits to, and checks it is a complete human gate. */
export function readVerifiedDecisionLog(
  bytes: Uint8Array | null,
  reviewer: string,
): ReviewDecisionLogV1 | null {
  if (bytes === null) return null;
  try {
    const parsed = decisionLogSchema.safeParse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (!parsed.success) return null;
    const log = parsed.data;
    if (log.reviewer !== reviewer) return null;
    // A finding marked "requires change" is an unfinished review, whatever else the log says.
    if (log.dispositions.some((d) => d.kind === 'requires_change')) return null;
    return log;
  } catch {
    return null;
  }
}

export class ApprovalController {
  readonly #deps: ApprovalDeps;
  readonly #listeners = new Set<() => void>();
  readonly #offs: (() => void)[] = [];
  #state: ApprovalSnapshot = EMPTY;
  #ctx: Context | null = null;
  #ticket: PreviewTicket | null = null;
  #signed: Authorisation | null = null;
  #epoch = 0;
  #busy = false;

  constructor(deps: ApprovalDeps) {
    this.#deps = deps;
    this.#offs.push(
      deps.bindGate(() => this.#gate()),
      deps.onAccountChange(() => this.#onChange()),
      deps.vault.subscribe(() => this.#onChange()),
    );
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getSnapshot = (): ApprovalSnapshot => this.#state;

  dispose(): void {
    for (const off of this.#offs) off();
    this.#drop('');
  }

  #publish(patch: Partial<ApprovalSnapshot>): void {
    this.#state = Object.freeze({ ...this.#state, ...patch });
    for (const listener of this.#listeners) listener();
  }

  #drop(notice: string): void {
    this.#epoch++;
    this.#ctx = null;
    this.#ticket = null;
    this.#signed = null;
    this.#busy = false;
    this.#deps.review.invalidateAll();
    this.#state = Object.freeze({ ...EMPTY, notice });
    for (const listener of this.#listeners) listener();
  }

  /** Identity at preview time must still hold: account, generations and the verified capture. */
  #holds(ctx: Context): boolean {
    const account = this.#deps.account();
    if (
      account.address !== ctx.reviewer ||
      account.generation !== ctx.accountGeneration ||
      account.signing !== 'unlocked' ||
      account.backend !== 'signed_in'
    )
      return false;
    if (this.#deps.vault.getSnapshot().generation !== ctx.vaultGeneration) return false;
    if (ctx.captureGeneration !== null) {
      const subject = this.#deps.vault.recoverableSubject(ctx.reference.commitment);
      if (subject === null || subject.capture.generation !== ctx.captureGeneration) return false;
      if (readVerifiedDecisionLog(subject.decisionLogBytes, ctx.reviewer) === null) return false;
    }
    return true;
  }

  /** The live check the signing controller runs at every preview and confirmation. */
  #gate(): AccountResult<null> {
    const ctx = this.#ctx;
    if (ctx === null) return fail('UNAVAILABLE');
    if (!this.#holds(ctx)) return fail('STALE');
    if (this.#deps.now() - ctx.observedAtMs > PREFLIGHT_FRESHNESS_MS) return fail('STALE');
    return { ok: true, data: null };
  }

  #onChange(): void {
    const ctx = this.#ctx;
    if (ctx === null || this.#state.stage === 'idle') return;
    if (this.#state.stage === 'signed') return; // a released signature is not retractable
    if (!this.#holds(ctx))
      this.#drop('The account, vault or package changed, so the preview was discarded.');
  }

  cancelPreview(): void {
    if (this.#state.stage === 'signing') return;
    this.#drop('');
  }

  #failed(failure: ApprovalFailure, notice = ''): ApprovalSnapshot {
    this.#epoch++;
    this.#ctx = null;
    this.#ticket = null;
    this.#busy = false;
    this.#deps.review.invalidateAll();
    this.#state = Object.freeze({ stage: 'failed', display: null, failure, notice });
    for (const listener of this.#listeners) listener();
    return this.#state;
  }

  #fresh(states: readonly LiveState[]): { states: Extract<LiveState, { status: 'ok' }>[] } | null {
    const out: Extract<LiveState, { status: 'ok' }>[] = [];
    for (const state of states) {
      if (state.status !== 'ok') return null;
      out.push(state);
    }
    return { states: out };
  }

  /** Reads fresh live state, checks the lifecycle each action needs, and returns one registry nonce. */
  async #preflight(
    reviewer: string,
    commitments: Context['commitments'],
  ): Promise<
    | { ok: true; nonce: string; block: string; observedAtMs: number; observedAt: string }
    | { ok: false; failure: ApprovalFailure }
  > {
    const reads = await Promise.all(
      commitments.map((c) => this.#deps.live(reviewer, c.commitment)),
    );
    const checked = this.#fresh(reads);
    if (checked === null) return { ok: false, failure: 'CHAIN_UNKNOWN' };
    const now = this.#deps.now();
    let oldest = Number.POSITIVE_INFINITY;
    for (const state of checked.states) oldest = Math.min(oldest, Date.parse(state.observedAt));
    if (now - oldest > PREFLIGHT_FRESHNESS_MS) return { ok: false, failure: 'STALE_OBSERVATION' };
    for (const [index, state] of checked.states.entries()) {
      if (state.receiptLifecycle !== commitments[index]?.expect)
        return { ok: false, failure: 'LIFECYCLE_REJECTED' };
    }
    const nonces = new Set(checked.states.map((s) => s.registryNonce));
    const first = checked.states[0];
    if (nonces.size !== 1 || first === undefined) return { ok: false, failure: 'CHAIN_UNKNOWN' };
    return {
      ok: true,
      nonce: first.registryNonce,
      block: first.blockNumber,
      observedAtMs: oldest,
      observedAt: first.observedAt,
    };
  }

  /**
   * Builds the exact action from live facts and asks the signing controller for a one-use
   * preview ticket. Nothing is signed. The preview is what the reviewer sees before approving.
   */
  async prepare(target: ApprovalTarget): Promise<ApprovalSnapshot> {
    if (this.#busy || this.#state.stage === 'signing') return this.#state;
    this.#busy = true;
    this.#ctx = null;
    this.#ticket = null;
    this.#deps.review.invalidateAll();
    const epoch = ++this.#epoch;
    this.#publish({ stage: 'checking', display: null, failure: null, notice: '' });

    const account = this.#deps.account();
    if (account.address === null) return this.#failed('NO_ACCOUNT');
    if (account.signing !== 'unlocked') return this.#failed('SESSION_LOCKED');
    if (account.backend !== 'signed_in') return this.#failed('BACKEND_SIGNED_OUT');
    const cfg = this.#deps.config();
    if (cfg.registryAddress === null) return this.#failed('NO_REGISTRY');
    const reviewer = account.address;

    let reference: ReceiptReferenceV1;
    let predecessor: ReceiptReferenceV1 | null = null;
    let captureGeneration: number | null = null;
    let log: ReviewDecisionLogV1 | null = null;
    let scope: ApprovalDisplay['scope'] = null;
    if (target.kind === 'revoke') {
      // A known public receipt is enough: no private documents are needed to revoke it.
      const parsed = parseReceiptReference(target.reference);
      if (!parsed.ok) return this.#failed('SCOPE_MISMATCH');
      reference = parsed.data;
    } else {
      const subject = this.#deps.vault.recoverableSubject(target.commitment);
      if (subject === null) return this.#failed('CAPTURE_NOT_VERIFIED');
      if (target.kind === 'issue' && subject.supersedes !== null)
        return this.#failed('USE_SUPERSEDE');
      if (target.kind === 'supersede' && subject.supersedes === null)
        return this.#failed('NOT_A_REPLACEMENT');
      reference = subject.reference;
      predecessor = subject.supersedes;
      captureGeneration = subject.capture.generation;
      log = readVerifiedDecisionLog(subject.decisionLogBytes, reviewer);
      if (log === null) return this.#failed('DECISION_LOG_INVALID');
      if (new Set(subject.scopeArtifactIds).size !== subject.artifacts.length)
        return this.#failed('DECISION_LOG_INVALID');
      const roles = new Map<string, number>();
      for (const artifact of subject.artifacts)
        roles.set(artifact.role, (roles.get(artifact.role) ?? 0) + 1);
      scope = {
        artifactCount: subject.artifacts.length,
        roles: [...roles].map(([role, count]) => ({ role, count })),
      };
    }
    if (
      reference.reviewerAddress !== reviewer ||
      reference.chainId !== cfg.chainId ||
      reference.registryAddress !== cfg.registryAddress
    )
      return this.#failed('SCOPE_MISMATCH');

    const commitments: Context['commitments'] =
      target.kind === 'issue'
        ? [{ commitment: reference.commitment, expect: 'not_found' }]
        : target.kind === 'revoke'
          ? [{ commitment: reference.commitment, expect: 'active' }]
          : [
              { commitment: predecessor?.commitment ?? ZERO_BYTES32, expect: 'active' },
              { commitment: reference.commitment, expect: 'not_found' },
            ];
    const pre = await this.#preflight(reviewer, commitments);
    if (epoch !== this.#epoch) return this.#state;
    if (!pre.ok) return this.#failed(pre.failure);

    const nowSeconds = Math.floor(this.#deps.now() / 1000);
    const deadline = defaultActionDeadline(String(nowSeconds));
    if (!deadline.ok) return this.#failed('ACTION_INVALID');
    const code =
      target.kind === 'issue'
        ? REVIEW_ACTION_CODES.ISSUE
        : target.kind === 'revoke'
          ? REVIEW_ACTION_CODES.REVOKE
          : REVIEW_ACTION_CODES.SUPERSEDE;
    let action: BoundReviewAction;
    if (target.kind === 'revoke') {
      const built = buildRevokeAction(reference, pre.nonce, deadline.data);
      if (!built.ok) return this.#failed('ACTION_INVALID');
      action = built.data;
    } else {
      const bound = boundReviewActionSchema.safeParse({
        chainId: reference.chainId,
        registryAddress: reference.registryAddress,
        action: {
          reviewer,
          action: code,
          commitment:
            target.kind === 'supersede' ? (predecessor?.commitment ?? '') : reference.commitment,
          replacementCommitment: target.kind === 'supersede' ? reference.commitment : ZERO_BYTES32,
          nonce: pre.nonce,
          deadline: deadline.data,
        },
      });
      if (!bound.success) return this.#failed('ACTION_INVALID');
      action = bound.data;
    }

    const ctx: Context = {
      target,
      reviewer,
      accountGeneration: account.generation,
      vaultGeneration: this.#deps.vault.getSnapshot().generation,
      captureGeneration,
      commitments,
      nonce: pre.nonce,
      deadline: deadline.data,
      action,
      reference,
      observedAtMs: pre.observedAtMs,
    };
    this.#ctx = ctx;
    const ticket = this.#deps.review.preview({ action, packageReference: reference });
    if (!ticket.ok) return this.#failed('PREVIEW_REFUSED');
    this.#ticket = ticket.data;
    this.#busy = false;
    this.#publish({
      stage: 'preview',
      failure: null,
      notice: '',
      display: {
        kind: target.kind,
        reviewer,
        chainId: reference.chainId,
        registryAddress: reference.registryAddress,
        commitment: reference.commitment,
        predecessor: predecessor?.commitment ?? null,
        nonce: pre.nonce,
        deadline: deadline.data,
        observedBlock: pre.block,
        observedAt: pre.observedAt,
        scope,
        rulePackReviewState: log?.rulePack.reviewState ?? null,
        decisionCount: log?.dispositions.length ?? 0,
        concerns: (log?.dispositions ?? [])
          .filter((d) => d.kind === 'accepted_unresolved' || d.kind === 'not_applicable')
          .map((d) => ({ findingId: d.findingId, reason: d.reason })),
      },
    });
    return this.#state;
  }

  /**
   * The explicit "Approve this package" activation. It needs a trusted user activation, re-reads
   * live state, consumes the one-use ticket and signs only the displayed action. No timer,
   * analysis result, checklist or passkey prompt can call this on the reviewer's behalf.
   */
  async approve(activation: { readonly trusted: boolean }): Promise<ApprovalSnapshot> {
    if (!activation.trusted)
      return this.#failed('NOT_TRUSTED', 'Approval needs a direct user action.');
    if (this.#state.stage === 'signing' || this.#busy) return this.#state;
    const ctx = this.#ctx;
    const ticket = this.#ticket;
    if (this.#state.stage !== 'preview' || ctx === null || ticket === null)
      return this.#failed('NO_PREVIEW');
    if (!this.#holds(ctx))
      return this.#failed('STALE', 'Something changed, so nothing was signed.');
    if (BigInt(ctx.deadline) <= BigInt(Math.floor(this.#deps.now() / 1000)))
      return this.#failed('PREVIEW_EXPIRED', 'This preview expired. Nothing was signed.');
    this.#busy = true;
    const epoch = this.#epoch;
    this.#publish({ stage: 'checking', notice: 'Checking the network again…' });

    // Re-read live state: the displayed action is signed only if it is still exactly the action.
    const again = await this.#preflight(ctx.reviewer, ctx.commitments);
    if (epoch !== this.#epoch) return this.#state;
    if (!again.ok)
      return this.#failed(again.failure === 'LIFECYCLE_REJECTED' ? 'CHANGED' : again.failure);
    if (again.nonce !== ctx.nonce)
      return this.#failed('CHANGED', 'The registry nonce changed. Review a new preview.');
    ctx.observedAtMs = again.observedAtMs;
    if (!this.#holds(ctx))
      return this.#failed('STALE', 'Something changed, so nothing was signed.');

    this.#publish({ stage: 'signing', notice: 'Waiting for your passkey…' });
    const result = await this.#deps.review.confirm(ticket, {
      action: ctx.action,
      packageReference: ctx.reference,
    });
    if (epoch !== this.#epoch) return this.#state;
    this.#ticket = null; // single use, pass or fail
    if (!result.ok) {
      const code = result.code;
      return this.#failed(
        code === 'CANCELLED' || code === 'NOT_COMPLETED'
          ? 'USER_CANCELLED'
          : code === 'SESSION_LOCKED' || code === 'SESSION_EXPIRED'
            ? 'SESSION_LOCKED'
            : code === 'TICKET_INVALID'
              ? 'PREVIEW_EXPIRED'
              : 'SIGNING_FAILED',
        'Nothing was signed. Start again from a new preview.',
      );
    }
    // The captured identity must still hold after the asynchronous signing step.
    if (
      !this.#deps.review.owns(result.data) ||
      result.data.generation !== ctx.accountGeneration ||
      !this.#holds(ctx)
    ) {
      return this.#failed('STALE', 'Something changed while signing. The signature was discarded.');
    }
    this.#busy = false;
    this.#signed = Object.freeze({
      signed: result.data,
      request: { kind: 'execute' as const, action: ctx.action, packageReference: ctx.reference },
    });
    this.#publish({
      stage: 'signed',
      failure: null,
      notice: 'Approval signed; publication not confirmed.',
    });
    return this.#state;
  }

  /** Hands the signature once, to the submission controller only. A second call returns null. */
  takeAuthorisation(): Authorisation | null {
    const signed = this.#signed;
    this.#signed = null;
    return signed;
  }

  /** Starts over after a signed approval has been handed off or abandoned. Releases nothing. */
  reset(): void {
    if (this.#state.stage === 'signing') return;
    this.#drop('');
  }
}
