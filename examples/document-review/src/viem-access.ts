import type { Hex, PublicClient, WalletClient } from 'viem';
import type { LiveOptions } from '@lexaegis/sdk/verify';
import type { ChainAccess, FeeQuote } from './lifecycle.js';

/**
 * ChainAccess over viem clients. `executor` is any account with funds for the fee; it has no
 * authority over a receipt, which only the reviewer's signature grants. Supply your own clients,
 * transport and live options (the registry policy you trust).
 */
export function viemChainAccess(input: {
  readonly publicClient: PublicClient;
  readonly executorClient: WalletClient;
  readonly registryAddress: Hex;
  readonly live: LiveOptions;
  /** Reads `nonceOf(reviewer)` from the registry. */
  readonly readNonce: (reviewer: string) => Promise<bigint>;
}): ChainAccess {
  const { publicClient, executorClient, registryAddress } = input;
  return {
    readNonce: async (reviewer) => (await input.readNonce(reviewer)).toString(),
    chainTime: async () => (await publicClient.getBlock()).timestamp.toString(),
    async quote(calldata): Promise<FeeQuote> {
      const [gasLimit, fees] = await Promise.all([
        publicClient.estimateGas({
          account: executorClient.account ?? undefined,
          to: registryAddress,
          data: calldata,
        }),
        publicClient.estimateFeesPerGas(),
      ]);
      return {
        gasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      };
    },
    send: (calldata, quote) => {
      const account = executorClient.account;
      if (account === undefined) throw new Error('the executor client has no account');
      return executorClient.sendTransaction({
        account,
        chain: executorClient.chain,
        to: registryAddress,
        data: calldata,
        value: 0n,
        gas: quote.gasLimit,
        maxFeePerGas: quote.maxFeePerGas,
        maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
      });
    },
    async waitForExecution(hash) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return receipt.status;
    },
    live: input.live,
  };
}
