import type {
  AccountResult,
  RegistryTransactionSigning,
  SignedRegistryTransaction,
  SignedReviewAction,
  TransactionIntent,
  TransactionTicket,
} from '@/features/account/public';
import type { ChainApi, OperationView, Phase, PublicRequest } from './api-client';

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
}

const INITIAL: TransactionState = Object.freeze({
  stage: 'idle',
  operation: null,
  preview: null,
  reason: null,
  mayHaveBroadcast: false,
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

  constructor(deps: ControllerDeps) {
    this.#deps = deps;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getSnapshot = (): TransactionState => this.#state;

  #set(patch: Partial<TransactionState>): void {
    this.#state = Object.freeze({ ...this.#state, ...patch });
    for (const listener of this.#listeners) listener();
  }

  /** Reserve, quote and preview. For `execute`, `authorization` is the stage-one signature. */
  async begin(request: PublicRequest, authorization: SignedReviewAction | null): Promise<void> {
    const epoch = ++this.#epoch;
    this.#signed = null;
    this.#request = request;
    this.#set({ ...INITIAL, stage: 'checking_network' });
    const created = await this.#deps.api.create(this.#deps.newIdempotencyKey(), request);
    if (epoch !== this.#epoch) return;
    if (!created.ok) {
      this.#set({ stage: 'failed', reason: created.reason });
      return;
    }

    const signature = authorization?.signature ?? null;
    const quoted = await this.#deps.api.quote(
      created.data.operation.operationId,
      request,
      signature,
    );
    if (epoch !== this.#epoch) return;
    if (!quoted.ok) {
      this.#set({
        stage: 'failed',
        reason: quoted.reason,
        operation: created.data.operation,
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
      operationId: created.data.operation.operationId,
    };
    this.#set({
      stage: 'awaiting_confirmation',
      operation: quoted.data.operation,
      preview: ticket.data.preview,
    });
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
      this.#set({
        operation: result.data.operation,
        stage: STAGE_BY_PHASE[result.data.operation.phase],
      });
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
    this.#set({
      operation: result.data.operation,
      stage: STAGE_BY_PHASE[result.data.operation.phase],
    });
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
    this.#set({ stage: 'cancelled', preview: null });
  }

  /** Lock, expiry or account switch: unused tickets and any held signed bytes are dropped. */
  onAccountLost(): void {
    this.#pending = null;
    this.#signed = null;
    this.#epoch += 1;
    if (!this.#state.mayHaveBroadcast)
      this.#set({ stage: 'cancelled', preview: null, reason: 'LOCKED' });
    else this.#set({ preview: null });
  }
}
