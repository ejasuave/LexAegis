import { BINDING } from '../binding.generated';
import {
  IntegrityError,
  UINT256_MAX,
  ZERO_HASH,
  type EventKindName,
  type NormalizedEvent,
} from './types';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;

/** The raw shape the handlers hand over, independent of the generated event types. */
export interface RawLog {
  readonly kind: EventKindName;
  readonly chainId: number;
  readonly srcAddress: string;
  readonly reviewer: string;
  readonly commitment?: string;
  readonly relatedCommitment?: string;
  readonly nonce: bigint;
  readonly newNonce?: bigint;
  readonly eventTimestamp: bigint;
  readonly blockNumber: number | bigint;
  readonly blockHash: string;
  readonly blockTimestamp: number | bigint;
  readonly transactionHash: string;
  readonly executor: string;
  readonly logIndex: number;
}

const position = (raw: RawLog): string => `${String(raw.blockNumber)}/${String(raw.logIndex)}`;

function quantity(value: number | bigint, raw: RawLog): bigint {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new IntegrityError('INVALID_PARAMETER', position(raw));
  }
  const big = BigInt(value);
  if (big < 0n || big > UINT256_MAX) throw new IntegrityError('INVALID_PARAMETER', position(raw));
  return big;
}

/** Validates one registry log against the deployment binding. Throws IntegrityError. */
export function normalize(raw: RawLog): NormalizedEvent {
  const at = position(raw);
  if (String(raw.chainId) !== BINDING.chainId) throw new IntegrityError('WRONG_CHAIN', at);
  const src = raw.srcAddress.toLowerCase();
  if (src !== BINDING.registryAddress) throw new IntegrityError('WRONG_REGISTRY', at);

  const reviewer = raw.reviewer.toLowerCase();
  const executor = raw.executor.toLowerCase();
  const blockHash = raw.blockHash.toLowerCase();
  const transactionHash = raw.transactionHash.toLowerCase();
  const commitment = (raw.commitment ?? ZERO_HASH).toLowerCase();
  const relatedCommitment = (raw.relatedCommitment ?? ZERO_HASH).toLowerCase();

  if (!ADDRESS.test(reviewer) || reviewer === `0x${'0'.repeat(40)}`) {
    throw new IntegrityError('INVALID_PARAMETER', at);
  }
  if (!ADDRESS.test(executor)) throw new IntegrityError('INVALID_PARAMETER', at);
  if (!HASH.test(blockHash) || !HASH.test(transactionHash)) {
    throw new IntegrityError('INVALID_PARAMETER', at);
  }
  if (!HASH.test(commitment) || !HASH.test(relatedCommitment)) {
    throw new IntegrityError('INVALID_PARAMETER', at);
  }
  if (!Number.isSafeInteger(raw.logIndex) || raw.logIndex < 0) {
    throw new IntegrityError('INVALID_PARAMETER', at);
  }

  const nonce = quantity(raw.nonce, raw);
  const eventTimestamp = quantity(raw.eventTimestamp, raw);
  const blockTimestamp = quantity(raw.blockTimestamp, raw);
  const blockNumber = quantity(raw.blockNumber, raw);
  const newNonce = raw.newNonce === undefined ? undefined : quantity(raw.newNonce, raw);
  if (eventTimestamp !== blockTimestamp) throw new IntegrityError('TIMESTAMP_MISMATCH', at);

  if (raw.kind === 'NONCE_INVALIDATED') {
    if (newNonce === undefined) throw new IntegrityError('INVALID_PARAMETER', at);
  } else {
    if (newNonce !== undefined) throw new IntegrityError('INVALID_PARAMETER', at);
    if (commitment === ZERO_HASH) throw new IntegrityError('INVALID_PARAMETER', at);
  }
  if (raw.kind === 'RECEIPT_SUPERSEDED' && relatedCommitment === ZERO_HASH) {
    throw new IntegrityError('INVALID_PARAMETER', at);
  }
  if (raw.kind === 'RECEIPT_REVOKED' && relatedCommitment !== ZERO_HASH) {
    throw new IntegrityError('INVALID_PARAMETER', at);
  }

  return {
    kind: raw.kind,
    chainId: BINDING.chainId,
    srcAddress: src,
    reviewer,
    commitment,
    relatedCommitment,
    nonce,
    newNonce,
    eventTimestamp,
    blockNumber,
    blockHash,
    blockTimestamp,
    transactionHash,
    executor,
    logIndex: raw.logIndex,
  };
}
