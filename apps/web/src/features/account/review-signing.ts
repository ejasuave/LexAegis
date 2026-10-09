import { parseReceiptReference, type ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import {
  DEFAULT_ACTION_VALIDITY_SECONDS,
  REVIEW_ACTION_CODES,
  boundReviewActionSchema,
  buildTypedData,
  hashReviewAction,
  toEip712ReviewAction,
  type BoundReviewAction,
  type Eip712ReviewAction,
  type ReviewActionTypedData,
} from '@lexaegis/sdk/registry';
import type { AccountConfig } from './config';
import { failWith, succeed, type AccountResult } from './errors';

/*
 * Restricted bridge from an explicit human confirmation to one EIP-712 registry signature.
 *
 * These checks are application code around an ordinary EOA key. They are not on-chain
 * session-key restrictions and do not protect against a compromised page. Nothing here
 * broadcasts, and a returned signature is not a receipt.
 */

/** What the controller lets this module do: nothing but sign validated review typed data. */
export interface ReviewSigningPort {
  readonly config: AccountConfig;
  generation(): number;
  address(): string | null;
  /** Unix milliseconds. */
  now(): number;
  sign(typedData: Eip712ReviewAction, generation: number): Promise<AccountResult<`0x${string}`>>;
}

/**
 * Whether review signing may run at all. It needs trustworthy live chain and nonce state
 * (Chapter 6) and recoverable frozen evidence with the complete human-review gate (Chapters 5
 * and 8 to 10). Until those exist the production gate refuses, and there is no flag to open it.
 */
export type ReviewGate = () => AccountResult<null>;
export const productionReviewGate: ReviewGate = () => failWith('UNAVAILABLE');

const TICKET_TTL_MS = 120_000;

/** Immutable preview of exactly one action. Holding it is not approval; confirming it is. */
export interface PreviewTicket {
  readonly digest: string;
  readonly address: string;
  readonly generation: number;
  readonly packageReference: ReceiptReferenceV1;
  readonly typedData: ReviewActionTypedData;
  /** Unix milliseconds. */
  readonly expiresAt: number;
}

export interface SignedReviewAction {
  /** Generation of the signing session that released this signature. */
  readonly generation: number;
  readonly action: BoundReviewAction;
  readonly typedData: ReviewActionTypedData;
  readonly digest: string;
  readonly signature: `0x${string}`;
}

export interface ReviewRequest {
  readonly action: unknown;
  /** Public reference of the frozen package the action is for. */
  readonly packageReference: unknown;
}

interface Prepared {
  readonly bound: BoundReviewAction;
  readonly typedData: ReviewActionTypedData;
  readonly digest: string;
  readonly reference: ReceiptReferenceV1;
}

export interface ReviewSigning {
  preview(request: ReviewRequest): AccountResult<PreviewTicket>;
  confirm(
    ticket: PreviewTicket,
    request: ReviewRequest,
  ): Promise<AccountResult<SignedReviewAction>>;
  /** True only for a signature object this module released; a look-alike is not one. */
  owns(signed: SignedReviewAction): boolean;
  /** Lock, account switch and cancellation call this: every unused ticket dies. */
  invalidateAll(): void;
}

export function createReviewSigning(port: ReviewSigningPort, gate: ReviewGate): ReviewSigning {
  // Identity, not content: a look-alike object or an "approved: true" flag is not a ticket.
  let issued = new WeakSet<PreviewTicket>();
  const released = new WeakSet<SignedReviewAction>();

  function prepare(request: ReviewRequest): AccountResult<Prepared> {
    const { config } = port;
    const address = port.address();
    if (address === null) return failWith('SESSION_LOCKED');
    if (config.registryAddress === null) return failWith('UNAVAILABLE');

    const bound = boundReviewActionSchema.safeParse(request.action);
    const reference = parseReceiptReference(request.packageReference);
    if (!bound.success || !reference.ok) return failWith('SCOPE_REJECTED');
    const { action } = bound.data;

    // Chain, registry and reviewer must be the configured ones and the selected account.
    if (
      bound.data.chainId !== config.chainId ||
      bound.data.registryAddress !== config.registryAddress
    ) {
      return failWith('SCOPE_REJECTED');
    }
    if (action.reviewer !== address) return failWith('SCOPE_REJECTED');

    // The action must be about exactly this package.
    const subject =
      action.action === REVIEW_ACTION_CODES.SUPERSEDE
        ? action.replacementCommitment
        : action.commitment;
    const ref = reference.data;
    if (
      ref.commitment !== subject ||
      ref.reviewerAddress !== address ||
      ref.chainId !== config.chainId ||
      ref.registryAddress !== config.registryAddress
    ) {
      return failWith('SCOPE_REJECTED');
    }

    // Positive, unexpired, and no further out than the 600-second action-expiry policy.
    const nowSeconds = BigInt(Math.floor(port.now() / 1000));
    const deadline = BigInt(action.deadline);
    if (deadline <= nowSeconds || deadline > nowSeconds + DEFAULT_ACTION_VALIDITY_SECONDS) {
      return failWith('SCOPE_REJECTED');
    }

    const typedData = buildTypedData(bound.data, config.chainId, config.registryAddress);
    if (!typedData.ok) return failWith('SCOPE_REJECTED');
    const digest = hashReviewAction(typedData.data);
    if (!digest.ok) return failWith('SCOPE_REJECTED');
    return succeed({
      bound: bound.data,
      typedData: typedData.data,
      digest: digest.data,
      reference: ref,
    });
  }

  return {
    preview(request) {
      const allowed = gate();
      if (!allowed.ok) return allowed;
      const prepared = prepare(request);
      if (!prepared.ok) return prepared;
      const ticket: PreviewTicket = Object.freeze({
        digest: prepared.data.digest,
        address: prepared.data.bound.action.reviewer,
        generation: port.generation(),
        packageReference: prepared.data.reference,
        typedData: prepared.data.typedData,
        expiresAt: Math.min(
          port.now() + TICKET_TTL_MS,
          Number(BigInt(prepared.data.bound.action.deadline) * 1000n),
        ),
      });
      issued.add(ticket);
      return succeed(ticket);
    },

    async confirm(ticket, request) {
      const allowed = gate();
      if (!allowed.ok) return allowed;
      // Consumed before anything else: a ticket confirms at most once, pass or fail.
      if (!issued.delete(ticket)) return failWith('TICKET_INVALID');
      if (port.now() >= ticket.expiresAt) return failWith('TICKET_INVALID');
      if (ticket.generation !== port.generation() || ticket.address !== port.address()) {
        return failWith('TICKET_INVALID');
      }
      // Inputs are copied now; later mutation by the caller cannot change what is signed.
      const prepared = prepare(
        structuredClone({ action: request.action, packageReference: request.packageReference }),
      );
      if (!prepared.ok) return failWith('TICKET_INVALID');
      // Any change to package, action, reviewer, links, nonce, deadline, chain or registry
      // changes the digest or the reference, and needs a new preview and confirmation.
      if (
        prepared.data.digest !== ticket.digest ||
        prepared.data.reference.commitment !== ticket.packageReference.commitment
      ) {
        return failWith('TICKET_INVALID');
      }
      const eip712 = toEip712ReviewAction(prepared.data.typedData);
      if (!eip712.ok) return failWith('TICKET_INVALID');

      const signature = await port.sign(eip712.data, ticket.generation);
      if (!signature.ok) return signature;
      // Recheck after the wait: the captured data must still hash to the previewed digest.
      const after = hashReviewAction(prepared.data.typedData);
      if (!after.ok || after.data !== ticket.digest || ticket.generation !== port.generation()) {
        return failWith('STALE');
      }
      const signed: SignedReviewAction = Object.freeze({
        generation: ticket.generation,
        action: prepared.data.bound,
        typedData: prepared.data.typedData,
        digest: ticket.digest,
        signature: signature.data,
      });
      released.add(signed);
      return succeed(signed);
    },

    owns: (signed) => released.has(signed),

    invalidateAll() {
      issued = new WeakSet<PreviewTicket>();
    },
  };
}
