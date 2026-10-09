import type { TransactionSerializableEIP1559 } from 'viem';
import {
  checkRegistryTransaction,
  decodeSignedRegistryTransaction,
  encodeExecuteCalldata,
  encodeInvalidateNonceCalldata,
  REGISTRY_GAS_LIMIT_CEILING,
  checkFees,
  calldataHash,
} from '@lexaegis/sdk/transactions';
import type { AccountConfig } from './config';
import { failWith, succeed, type AccountResult } from './errors';
import type { ReviewSigning, SignedReviewAction } from './review-signing';

/*
 * Second authorisation stage: the fee-paying type-2 transaction to the verified registry.
 *
 * Only these transactions can be signed: chain 10143, from the selected account, to the verified
 * registry, value zero, empty access list, exact generated execute or invalidateNonce calldata.
 * Contract creation, transfers, other selectors, appended bytes, authorisation lists and
 * EIP-7702 are rejected here and again on the server. These are application checks around an
 * ordinary EOA key, not on-chain restrictions.
 *
 * The first confirmation (review-signing.ts) authorises the registry action; this one authorises
 * this account's fee-paying submission. Discarding a local preview cannot revoke a signature
 * that was already disclosed.
 */

const TICKET_TTL_MS = 120_000;

/** The server's closed quote, as received. Re-validated here; the server is not trusted blindly. */
export interface QuoteInput {
  readonly operationId: string;
  readonly account: string;
  readonly chainId: string;
  readonly registryAddress: string;
  readonly calldataHash: string;
  readonly actionDigest: string | null;
  readonly transactionNonce: string;
  readonly gasLimit: string;
  readonly maxFeePerGas: string;
  readonly maxPriorityFeePerGas: string;
  readonly maxFeeWei: string;
  /** RFC 3339. */
  readonly expiresAt: string;
}

export type TransactionIntent =
  | { readonly kind: 'execute'; readonly authorization: SignedReviewAction }
  | { readonly kind: 'invalidate_nonce'; readonly expectedNonce: string };

export interface TransactionPreview {
  readonly operationId: string;
  readonly kind: TransactionIntent['kind'];
  readonly account: string;
  readonly chainId: string;
  readonly destination: string;
  readonly calldata: `0x${string}`;
  readonly calldataHash: string;
  readonly actionDigest: string | null;
  readonly transactionNonce: string;
  readonly gasLimit: string;
  readonly maxFeePerGas: string;
  readonly maxFeeWei: string;
}

export interface TransactionTicket {
  readonly preview: TransactionPreview;
  readonly generation: number;
  /** Unix milliseconds. */
  readonly expiresAt: number;
}

export interface SignedRegistryTransaction {
  /** Transient. Held in memory for bounded explicit retry only; never logged or stored. */
  readonly raw: `0x${string}`;
  readonly hash: `0x${string}`;
  readonly sender: string;
  readonly operationId: string;
}

export interface TransactionSigningPort {
  readonly config: AccountConfig;
  generation(): number;
  address(): string | null;
  now(): number;
  signTransaction(
    tx: TransactionSerializableEIP1559,
    generation: number,
  ): Promise<AccountResult<`0x${string}`>>;
}

export interface RegistryTransactionSigning {
  preview(quote: QuoteInput, intent: TransactionIntent): AccountResult<TransactionTicket>;
  confirm(
    ticket: TransactionTicket,
    quote: QuoteInput,
    intent: TransactionIntent,
  ): Promise<AccountResult<SignedRegistryTransaction>>;
  invalidateAll(): void;
}

const decimal = /^(0|[1-9][0-9]{0,77})$/;

export function createRegistryTransactionSigning(
  port: TransactionSigningPort,
  reviews: Pick<ReviewSigning, 'owns'>,
): RegistryTransactionSigning {
  let issued = new WeakSet<TransactionTicket>();

  interface Built {
    readonly tx: TransactionSerializableEIP1559;
    readonly preview: TransactionPreview;
    readonly expiresAt: number;
  }

  function build(quote: QuoteInput, intent: TransactionIntent): AccountResult<Built> {
    const { config } = port;
    const address = port.address();
    if (address === null) return failWith('SESSION_LOCKED');
    if (config.registryAddress === null) return failWith('UNAVAILABLE');
    if (
      quote.account !== address ||
      quote.chainId !== config.chainId ||
      quote.registryAddress !== config.registryAddress
    ) {
      return failWith('SCOPE_REJECTED');
    }
    const numbers = [
      quote.transactionNonce,
      quote.gasLimit,
      quote.maxFeePerGas,
      quote.maxPriorityFeePerGas,
      quote.maxFeeWei,
    ];
    if (!numbers.every((value) => decimal.test(value))) return failWith('SCOPE_REJECTED');
    const nonce = Number(quote.transactionNonce);
    if (!Number.isSafeInteger(nonce)) return failWith('SCOPE_REJECTED');
    const gas = BigInt(quote.gasLimit);
    const fees = {
      gasLimit: gas,
      maxFeePerGas: BigInt(quote.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(quote.maxPriorityFeePerGas),
    };
    // The quote's own ceiling must equal gasLimit * maxFeePerGas and respect the gas limit cap.
    if (gas > REGISTRY_GAS_LIMIT_CEILING) return failWith('SCOPE_REJECTED');
    const feeCheck = checkFees(fees, BigInt(quote.maxFeeWei));
    if (!feeCheck.ok || feeCheck.maxFeeWei !== BigInt(quote.maxFeeWei))
      return failWith('SCOPE_REJECTED');
    const expiry = Date.parse(quote.expiresAt);
    if (!Number.isFinite(expiry) || port.now() >= expiry) return failWith('SCOPE_REJECTED');

    let calldata: `0x${string}` | null;
    let actionDigest: string | null = null;
    if (intent.kind === 'execute') {
      const signed = intent.authorization;
      // Only a signature released by this session's own review controller, for this account.
      if (!reviews.owns(signed) || signed.generation !== port.generation())
        return failWith('TICKET_INVALID');
      if (signed.action.action.reviewer !== address) return failWith('SCOPE_REJECTED');
      if (
        signed.action.chainId !== config.chainId ||
        signed.action.registryAddress !== config.registryAddress
      ) {
        return failWith('SCOPE_REJECTED');
      }
      calldata = encodeExecuteCalldata(signed.action.action, signed.signature);
      actionDigest = signed.digest;
      if (quote.actionDigest !== signed.digest) return failWith('SCOPE_REJECTED');
    } else {
      calldata = encodeInvalidateNonceCalldata(intent.expectedNonce);
      if (quote.actionDigest !== null) return failWith('SCOPE_REJECTED');
    }
    if (calldata === null || calldataHash(calldata) !== quote.calldataHash)
      return failWith('SCOPE_REJECTED');

    const tx: TransactionSerializableEIP1559 = {
      type: 'eip1559',
      chainId: Number(config.chainId),
      to: config.registryAddress as `0x${string}`,
      value: 0n,
      data: calldata,
      nonce,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      accessList: [],
    };
    const scope = checkRegistryTransaction(tx, {
      chainId: Number(config.chainId),
      registryAddress: config.registryAddress,
    });
    if (!scope.ok) return failWith('SCOPE_REJECTED');
    return succeed({
      tx,
      expiresAt: Math.min(port.now() + TICKET_TTL_MS, expiry),
      preview: {
        operationId: quote.operationId,
        kind: intent.kind,
        account: address,
        chainId: config.chainId,
        destination: config.registryAddress,
        calldata,
        calldataHash: quote.calldataHash,
        actionDigest,
        transactionNonce: quote.transactionNonce,
        gasLimit: quote.gasLimit,
        maxFeePerGas: quote.maxFeePerGas,
        maxFeeWei: quote.maxFeeWei,
      },
    });
  }

  return {
    preview(quote, intent) {
      const built = build(quote, intent);
      if (!built.ok) return built;
      const ticket: TransactionTicket = Object.freeze({
        preview: Object.freeze(built.data.preview),
        generation: port.generation(),
        expiresAt: built.data.expiresAt,
      });
      issued.add(ticket);
      return succeed(ticket);
    },

    async confirm(ticket, quote, intent) {
      // One use, pass or fail; a look-alike object is not a ticket.
      if (!issued.delete(ticket)) return failWith('TICKET_INVALID');
      if (port.now() >= ticket.expiresAt) return failWith('TICKET_INVALID');
      if (ticket.generation !== port.generation() || ticket.preview.account !== port.address()) {
        return failWith('TICKET_INVALID');
      }
      // Any change to a quote field changes the preview; it needs a new confirmation.
      const rebuilt = build(structuredClone(quote), intent);
      if (!rebuilt.ok) return failWith('TICKET_INVALID');
      if (JSON.stringify(rebuilt.data.preview) !== JSON.stringify(ticket.preview)) {
        return failWith('TICKET_INVALID');
      }
      const signed = await port.signTransaction(rebuilt.data.tx, ticket.generation);
      if (!signed.ok) return signed;
      // After the wait: same session, unexpired quote, and the bytes must be exactly this transaction.
      if (ticket.generation !== port.generation() || port.now() >= Date.parse(quote.expiresAt)) {
        return failWith('STALE');
      }
      const config = port.config;
      const decoded = await decodeSignedRegistryTransaction(signed.data, {
        chainId: Number(config.chainId),
        registryAddress: config.registryAddress ?? '',
      });
      const address = port.address();
      if (
        !decoded.ok ||
        decoded.sender !== address ||
        decoded.transaction.nonce !== rebuilt.data.tx.nonce ||
        decoded.transaction.gas !== rebuilt.data.tx.gas ||
        decoded.transaction.maxFeePerGas !== rebuilt.data.tx.maxFeePerGas ||
        decoded.transaction.maxPriorityFeePerGas !== rebuilt.data.tx.maxPriorityFeePerGas ||
        decoded.transaction.data !== rebuilt.data.tx.data
      ) {
        return failWith('FAILED');
      }
      return succeed({
        raw: signed.data,
        hash: decoded.hash,
        sender: decoded.sender,
        operationId: quote.operationId,
      });
    },

    invalidateAll() {
      issued = new WeakSet<TransactionTicket>();
    },
  };
}
