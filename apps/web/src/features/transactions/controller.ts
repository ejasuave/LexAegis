import type {
  AccountResult,
  RegistryTransactionSigning,
  SignedRegistryTransaction,
  SignedReviewAction,
  TransactionIntent,
  TransactionTicket,
} from '@/features/account/public';
import type { ChainApi, OperationView, Phase, PublicRequest } from './api-client';
import {
  verifyConfirmation,
  type ConfirmationScope,
  type ConfirmationSignal,
  type ExpectedAction,
} from './confirmation';

/*
 * Drives one registry transaction from reservation to a refreshed chain outcome. It owns no
 * keys: signing goes through the account's two single-use ticket stages. Cancellation stops
 * unsent work and kills unused tickets; it never claims to cancel an on-chain transaction.
 */

export type TransactionStage =
  | 'idle'
  | 'checking_network'
  | 'awaiting_confirmation'
  | 'signing'
  | 'sending'
  | 'pending'
  | 'checking_execution'
  | 'confirmed'
  | 'reverted'
  | 'unknown'
  | 'failed'
  | 'cancelled';

export interface TransactionState {
  readonly stage: TransactionStage;
  readonly operation: OperationView | null;
  /** Exact transaction preview shown for the second confirmation. */
  readonly preview: TransactionTicket['preview'] | null;
  readonly reason: string | null;
  /** True once bytes may have reached the server or network. */
  readonly mayHaveBroadcast: boolean;
  /** Fee figures of the current quote, exactly as the server quoted them (wei, decimal strings). */
  readonly quote: {
    readonly expectedFeeWei: string | null;
    readonly maxFeeWei: string;
    /** RFC 3339. A quote is valid for 30 seconds. */
    readonly expiresAt: string;
  } | null;
}

const INITIAL: TransactionState = Object.freeze({
  stage: 'idle',
  operation: null,
  preview: null,
  reason: null,
  mayHaveBroadcast: false,
  quote: null,
});

const STAGE_BY_PHASE: Record<Phase, TransactionStage> = {
  reserved: 'checking_network',
  quoted: 'awaiting_confirmation',
  submitting: 'sending',
  submitted: 'pending',
  pending: 'pending',
  included: 'checking_execution',
  confirmed: 'confirmed',
  reverted: 'reverted',
  replaced: 'unknown',
  unknown: 'unknown',
  cancelled: 'cancelled',
};

export interface ControllerDeps {
  readonly api: ChainApi;
  readonly signing: RegistryTransactionSigning;
  readonly newIdempotencyKey: () => string;
  /** The configured chain and registry. Without it no confirmation signal is ever emitted. */
  readonly scope?: () => ConfirmationScope | null;
}

interface Pending {
  readonly request: PublicRequest;
  readonly intent: TransactionIntent;
  readonly ticket: TransactionTicket;
  readonly quote: Parameters<RegistryTransactionSigning['preview']>[0];
  readonly operationId: string;
}

export class TransactionController {
  readonly #deps: ControllerDeps;
  readonly #listeners = new Set<() => void>();
  #state: TransactionState = INITIAL;
  #pending: Pending | null = null;
  #signed: SignedRegistryTransaction | null = null;
  #epoch = 0;
  #request: PublicRequest | null = null;
  /** The stage-one signature, kept in memory only so an expired quote can be renewed. Never stored. */
  #authorisation: SignedReviewAction | null = null;
  readonly #confirmationListeners = new Set<(signal: ConfirmationSignal) => void>();
  /** The confirmation this session emitted and has not withdrawn. */
  #confirmed: ConfirmationSignal | null = null;
  readonly #emitted = new Set<string>();

  constructor(deps: ControllerDeps) {
    this.#deps = deps;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getSnapshot = (): TransactionState => this.#state;

  /**
   * Verified live confirmations and their withdrawal. Delivered only for an operation this tab
   * signed and then watched change to confirmed; never for a recovered or replayed operation.
   */
  onConfirmation = (listener: (signal: ConfirmationSignal) => void): (() => void) => {
    this.#confirmationListeners.add(listener);
    return () => this.#confirmationListeners.delete(listener);
  };

  #expected(): ExpectedAction | null {
    const signed = this.#authorisation;
    const bound = (signed as { action?: unknown } | null)?.action as
      | {
          chainId?: unknown;
          registryAddress?: unknown;
          action?: { reviewer?: unknown; commitment?: unknown; nonce?: unknown };
        }
      | undefined;
    const inner = bound?.action;
    if (
      typeof bound?.chainId !== 'string' ||
      typeof bound.registryAddress !== 'string' ||
      typeof inner?.reviewer !== 'string' ||
      typeof inner.commitment !== 'string' ||
      (typeof inner.nonce !== 'string' &&
        typeof inner.nonce !== 'bigint' &&
        typeof inner.nonce !== 'number')
    ) {
      return null;
    }
    return {
      chainId: bound.chainId,
      registryAddress: bound.registryAddress,
      reviewer: inner.reviewer,
      commitment: inner.commitment,
      nonce: String(inner.nonce),
    };
  }

  /** Called with every live observation of the operation, after the state is updated. */
  #observed(operation: OperationView, previous: TransactionStage): void {
    if (operation.phase !== 'confirmed') {
      // Leaving confirmed after one was emitted is a withdrawal, never a silent change.
      const was = this.#confirmed;
      if (was !== null && previous === 'confirmed') {
        this.#confirmed = null;
        this.#emitConfirmation({ ...was, kind: 'invalidated' });
      }
      return;
    }
    if (previous === 'confirmed') return;
    const signal = verifyConfirmation(operation, this.#expected(), this.#deps.scope?.() ?? null);
    if (signal === null || this.#emitted.has(signal.id)) return;
    this.#emitted.add(signal.id);
    this.#confirmed = signal;
    this.#emitConfirmation(signal);
  }

  #emitConfirmation(signal: ConfirmationSignal): void {
    for (const listener of this.#confirmationListeners) listener(signal);
  }

  #set(patch: Partial<TransactionState>): void {
    this.#state = Object.freeze({ ...this.#state, ...patch });
    for (const listener of this.#listeners) listener();
  }

  /** Reserve, quote and preview. For `execute`, `authorization` is the stage-one signature. */
  async begin(
    request: PublicRequest,
    authorization: SignedReviewAction | null,
    /** An operation of this account that is reserved or quoted and not yet sent: quote it again. */
    renew: OperationView | null = null,
  ): Promise<void> {
    const epoch = ++this.#epoch;
    this.#signed = null;
    this.#request = request;
    this.#authorisation = authorization;
    this.#set({ ...INITIAL, stage: 'checking_network' });
    const signature = authorization?.signature ?? null;
    // Renewing asks the same operation for a fresh quote. A new reservation would collide with it:
    // an account may hold only one unresolved operation until its unsigned lease lapses.
    let operation: OperationView | null = renew;
    let quoted =
      renew === null ? null : await this.#deps.api.quote(renew.operationId, request, signature);
    if (epoch !== this.#epoch) return;
    if (quoted === null || !quoted.ok) {
      const created = await this.#deps.api.create(this.#deps.newIdempotencyKey(), request);
      if (epoch !== this.#epoch) return;
      if (!created.ok) {
        this.#set({ stage: 'failed', reason: created.reason });
        return;
      }
      operation = created.data.operation;
      quoted = await this.#deps.api.quote(operation.operationId, request, signature);
      if (epoch !== this.#epoch) return;
    }
    if (!quoted.ok || operation === null) {
      this.#set({
        stage: 'failed',
        reason: quoted.ok ? 'UNAVAILABLE' : quoted.reason,
        operation,
      });
      return;
    }

    const intent: TransactionIntent =
      request.kind === 'execute'
        ? authorization === null
          ? (null as never)
          : { kind: 'execute', authorization }
        : { kind: 'invalidate_nonce', expectedNonce: request.expectedNonce };
    if (request.kind === 'execute' && authorization === null) {
      this.#set({ stage: 'failed', reason: 'AUTHORIZATION_REQUIRED' });
      return;
    }
    const ticket = this.#deps.signing.preview(quoted.data.quote, intent);
    if (!ticket.ok) {
      this.#set({ stage: 'failed', reason: ticket.code, operation: quoted.data.operation });
      return;
    }
    this.#pending = {
      request,
      intent,
      ticket: ticket.data,
      quote: quoted.data.quote,
      operationId: operation.operationId,
    };
    const q = quoted.data.quote as Record<string, unknown>;
    this.#set({
      stage: 'awaiting_confirmation',
      operation: quoted.data.operation,
      preview: ticket.data.preview,
      quote: {
        expectedFeeWei: typeof q.expectedFeeWei === 'string' ? q.expectedFeeWei : null,
        maxFeeWei: quoted.data.quote.maxFeeWei,
        expiresAt: quoted.data.quote.expiresAt,
      },
    });
  }

  /**
   * A quote lasts 30 seconds. Renewing asks for a new quote for the same stage-one authorisation
   * and requires a new Send confirmation. It never re-signs, bumps a fee or changes a nonce.
   */
  async requote(): Promise<void> {
    const request = this.#request;
    if (request === null || this.#state.mayHaveBroadcast) return;
    if (request.kind === 'execute' && this.#authorisation === null) return;
    const held = this.#state.operation;
    this.#deps.signing.invalidateAll();
    this.#pending = null;
    await this.begin(
      request,
      this.#authorisation,
      held !== null && (held.phase === 'quoted' || held.phase === 'reserved') ? held : null,
    );
  }

  /** The explicit "Send transaction" confirmation. Consumes the single-use ticket. */
  async confirmSend(): Promise<void> {
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    const epoch = this.#epoch;
    this.#set({ stage: 'signing' });
    const signed: AccountResult<SignedRegistryTransaction> = await this.#deps.signing.confirm(
      pending.ticket,
      pending.quote,
      pending.intent,
    );
    if (epoch !== this.#epoch) return;
    if (!signed.ok) {
      this.#set({ stage: 'failed', reason: signed.code, preview: null });
      return;
    }
    this.#signed = signed.data;
    await this.#send(pending.request, pending.quote);
  }

  async #send(request: PublicRequest, quote: unknown): Promise<void> {
    const signed = this.#signed;
    if (signed === null) return;
    this.#set({ stage: 'sending', mayHaveBroadcast: true, preview: null });
    const result = await this.#deps.api.submit(signed.operationId, {
      request,
      quote,
      signedTransaction: signed.raw,
    });
    if (result.ok) {
      const previous = this.#state.stage;
      this.#set({
        operation: result.data.operation,
        stage: STAGE_BY_PHASE[result.data.operation.phase],
      });
      this.#observed(result.data.operation, previous);
      return;
    }
    // A lost response is not a failed broadcast: keep the bytes for an identical retry.
    this.#set({
      stage: result.network || result.reason === 'SUBMISSION_UNKNOWN' ? 'unknown' : 'failed',
      reason: result.reason,
    });
  }

  /** Identical bytes, identical hash. Never re-signs, bumps fees or advances a nonce. */
  async retrySubmit(quote: unknown): Promise<void> {
    if (this.#signed === null || this.#request === null) return;
    await this.#send(this.#request, quote);
  }

  /** Read-only status refresh from chain state. Allowed after the request may have escaped. */
  async refresh(): Promise<void> {
    const operation = this.#state.operation;
    const request = this.#request;
    if (operation === null || request === null) return;
    const result = await this.#deps.api.refresh(operation.operationId, request);
    if (!result.ok) {
      this.#set({ reason: result.reason });
      return;
    }
    const previous = this.#state.stage;
    this.#set({
      operation: result.data.operation,
      stage: STAGE_BY_PHASE[result.data.operation.phase],
    });
    this.#observed(result.data.operation, previous);
  }

  /**
   * After a reload or fresh-storage recovery: fetch this account's unresolved operations and show
   * the newest. No browser-local cache, opening or replacement approval is involved.
   */
  async recover(): Promise<OperationView[]> {
    const listed = await this.#deps.api.listUnresolved();
    if (!listed.ok) {
      this.#set({ stage: 'unknown', reason: listed.reason });
      return [];
    }
    const [first] = listed.data.operations;
    if (first !== undefined) {
      this.#set({
        operation: first,
        stage: STAGE_BY_PHASE[first.phase],
        mayHaveBroadcast: first.transactionHash !== null,
      });
    }
    return listed.data.operations;
  }

  /** Stop. Unsent work ends and tickets die; a broadcast transaction cannot be cancelled here. */
  cancel(): void {
    this.#epoch += 1;
    this.#pending = null;
    this.#deps.signing.invalidateAll();
    if (this.#state.mayHaveBroadcast) {
      this.#set({ reason: 'ALREADY_SENT' });
      return;
    }
    this.#signed = null;
    this.#authorisation = null;
    this.#set({ stage: 'cancelled', preview: null, quote: null });
  }

  /** Lock, expiry or account switch: unused tickets and any held signed bytes are dropped. */
  onAccountLost(): void {
    this.#pending = null;
    this.#signed = null;
    this.#authorisation = null;
    this.#epoch += 1;
    if (!this.#state.mayHaveBroadcast)
      this.#set({ stage: 'cancelled', preview: null, reason: 'LOCKED' });
    else this.#set({ preview: null });
  }
}
