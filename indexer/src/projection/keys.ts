import { BINDING } from '../binding.generated';

export const registryKey = (): string =>
  `${BINDING.chainId}:${BINDING.genesisHash}:${BINDING.registryAddress}`;
export const reviewerKey = (reviewer: string): string => `${registryKey()}:${reviewer}`;
export const receiptId = (reviewer: string, commitment: string): string =>
  `${reviewerKey(reviewer)}:${commitment}`;
export const actionId = (reviewer: string, consumedNonce: bigint): string =>
  `${reviewerKey(reviewer)}:${consumedNonce.toString(10)}`;
export const eventId = (blockHash: string, transactionHash: string, logIndex: number): string =>
  `${registryKey()}:${blockHash}:${transactionHash}:${logIndex}`;
