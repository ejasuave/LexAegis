import { createTestIndexer } from 'envio';
import { BINDING } from '../src/binding.generated';

export type Hex = `0x${string}`;
export const ZERO = `0x${'0'.repeat(64)}`;
export const START = Number(BINDING.startBlock);
export const REGISTRY_KEY = `${BINDING.chainId}:${BINDING.genesisHash}:${BINDING.registryAddress}`;

export const hex32 = (n: number | bigint): Hex => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
export const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}`;

export const ALICE = addr(0xa11ce);
export const BOB = addr(0xb0b);
export const RELAYER = addr(0xfeed);
export const CONTRACT_ACCOUNT = addr(0xc0de);

export const C1 = hex32(0xc1);
export const C2 = hex32(0xc2);
export const C3 = hex32(0xc3);

export const reviewerKey = (r: Hex): string => `${REGISTRY_KEY}:${r}`;
export const receiptId = (r: Hex, c: Hex): string => `${reviewerKey(r)}:${c}`;
export const actionId = (r: Hex, n: number | bigint): string => `${reviewerKey(r)}:${n}`;

interface Where {
  readonly block: number;
  readonly log?: number;
  readonly tx?: number;
  readonly from?: Hex;
  readonly ts?: number;
  readonly src?: Hex;
}

const where = (w: Where) => ({
  block: {
    number: START + w.block,
    hash: hex32(0x1000 + w.block),
    timestamp: w.ts ?? 1_000 + w.block,
  },
  transaction: { hash: hex32(0x2000 + w.block * 10 + (w.tx ?? 0)), from: w.from ?? ALICE },
  ...(w.log === undefined ? {} : { logIndex: w.log }),
  ...(w.src === undefined ? {} : { srcAddress: w.src }),
});

const stamp = (w: Where): bigint => BigInt(w.ts ?? 1_000 + w.block);

export const issued = (
  w: Where,
  p: { reviewer?: Hex; commitment: Hex; predecessor?: Hex; nonce: bigint; ts?: bigint },
) =>
  ({
    contract: 'ProofOfReviewRegistry',
    event: 'ReceiptIssued',
    ...where(w),
    params: {
      reviewer: p.reviewer ?? ALICE,
      commitment: p.commitment,
      predecessor: p.predecessor ?? ZERO,
      nonce: p.nonce,
      timestamp: p.ts ?? stamp(w),
    },
  }) as const;

export const revoked = (
  w: Where,
  p: { reviewer?: Hex; commitment: Hex; nonce: bigint; ts?: bigint },
) =>
  ({
    contract: 'ProofOfReviewRegistry',
    event: 'ReceiptRevoked',
    ...where(w),
    params: {
      reviewer: p.reviewer ?? ALICE,
      commitment: p.commitment,
      nonce: p.nonce,
      timestamp: p.ts ?? stamp(w),
    },
  }) as const;

export const superseded = (
  w: Where,
  p: { reviewer?: Hex; previous: Hex; replacement: Hex; nonce: bigint; ts?: bigint },
) =>
  ({
    contract: 'ProofOfReviewRegistry',
    event: 'ReceiptSuperseded',
    ...where(w),
    params: {
      reviewer: p.reviewer ?? ALICE,
      previousCommitment: p.previous,
      replacementCommitment: p.replacement,
      nonce: p.nonce,
      timestamp: p.ts ?? stamp(w),
    },
  }) as const;

export const invalidated = (
  w: Where,
  p: { reviewer?: Hex; previousNonce: bigint; newNonce?: bigint; ts?: bigint },
) =>
  ({
    contract: 'ProofOfReviewRegistry',
    event: 'NonceInvalidated',
    ...where(w),
    params: {
      reviewer: p.reviewer ?? ALICE,
      previousNonce: p.previousNonce,
      newNonce: p.newNonce ?? p.previousNonce + 1n,
      timestamp: p.ts ?? stamp(w),
    },
  }) as const;

export type Item = ReturnType<
  typeof issued | typeof revoked | typeof superseded | typeof invalidated
>;

export function fresh() {
  const indexer = createTestIndexer();
  const run = (simulate: Item[]) => indexer.process({ chains: { 10143: { simulate } } });
  return { indexer, run };
}

/** A paired supersession exactly as the registry emits it: Issued then Superseded, one nonce. */
export const supersession = (
  w: Omit<Where, 'log'>,
  p: { reviewer?: Hex; previous: Hex; replacement: Hex; nonce: bigint },
): Item[] => [
  issued(
    { ...w, log: 0 },
    {
      reviewer: p.reviewer ?? ALICE,
      commitment: p.replacement,
      predecessor: p.previous,
      nonce: p.nonce,
    },
  ),
  superseded({ ...w, log: 1 }, p),
];
