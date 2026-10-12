import { keccak256, type Hex, type LocalAccount, type PublicClient } from 'viem';
import type { LiveOptions } from '@lexaegis/sdk/verify';

/**
 * Everything that touches the chain, injected so a test can use a local node and a fault-injecting
 * wrapper. The executor signs the transaction LOCALLY, so its hash is known before broadcast.
 */

export interface FeeQuote {
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

export interface SignedTransaction {
  /** The complete raw transaction. It carries a usable action signature: memory only, never logged. */
  readonly raw: Hex;
  readonly hash: Hex;
  readonly quote: FeeQuote;
}

export type TransactionState = 'success' | 'reverted' | 'pending' | 'unknown';

export interface ChainAccess {
  readNonce(reviewer: string): Promise<string>;
  chainTime(): Promise<string>;
  /** Quotes the fee and signs a type-2 transaction to the registry with zero value. Sends nothing. */
  signTransaction(calldata: Hex): Promise<SignedTransaction>;
  broadcast(raw: Hex): Promise<Hex>;
  transactionState(hash: Hex): Promise<TransactionState>;
  readonly live: LiveOptions;
  /** Waits between reads. A local chain mines blocks instead of sleeping. */
  pause?(milliseconds: number): Promise<void>;
}

export interface ViemChainOptions {
  readonly publicClient: PublicClient;
  readonly executor: LocalAccount;
  readonly registryAddress: Hex;
  readonly chainId: number;
  readonly live: LiveOptions;
  readonly readNonce: (reviewer: string) => Promise<bigint>;
  readonly pause?: (milliseconds: number) => Promise<void>;
}

export function viemChainAccess(options: ViemChainOptions): ChainAccess {
  const { publicClient, executor, registryAddress, chainId } = options;
  return {
    readNonce: async (reviewer) => (await options.readNonce(reviewer)).toString(),
    chainTime: async () => (await publicClient.getBlock()).timestamp.toString(),
    async signTransaction(calldata) {
      const [gasLimit, fees, nonce] = await Promise.all([
        publicClient.estimateGas({ account: executor, to: registryAddress, data: calldata }),
        publicClient.estimateFeesPerGas(),
        publicClient.getTransactionCount({ address: executor.address, blockTag: 'pending' }),
      ]);
      const quote: FeeQuote = {
        gasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      };
      return {
        quote,
        ...(await signWith(executor, registryAddress, chainId, calldata, quote, nonce)),
      };
    },
    broadcast: (raw) => publicClient.sendRawTransaction({ serializedTransaction: raw }),
    async transactionState(hash) {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash });
        return receipt.status;
      } catch {
        // not mined: fall through
      }
      try {
        await publicClient.getTransaction({ hash });
        return 'pending';
      } catch {
        return 'unknown';
      }
    },
    live: options.live,
    ...(options.pause !== undefined && { pause: options.pause }),
  };
}

/** Signs one type-2 registry transaction: value zero, no access list, no authorization list. */
export async function signWith(
  executor: LocalAccount,
  registryAddress: Hex,
  chainId: number,
  calldata: Hex,
  quote: FeeQuote,
  nonce: number,
): Promise<{ readonly raw: Hex; readonly hash: Hex }> {
  const raw = await executor.signTransaction({
    type: 'eip1559',
    chainId,
    to: registryAddress,
    data: calldata,
    value: 0n,
    gas: quote.gasLimit,
    maxFeePerGas: quote.maxFeePerGas,
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
    nonce,
  });
  return { raw, hash: keccak256(raw) };
}
