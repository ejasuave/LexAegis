import type { LocalAccount } from 'viem';
import type { ReviewSigner } from './lifecycle.js';

/**
 * Wraps any viem account (a keystore account, a hardware wallet or a JSON-RPC wallet) as the signer
 * the lifecycle functions expect. The key never enters this example: the account decides how and
 * where it signs, and a wallet can show the typed data to its owner first.
 */
export function signerFromAccount(
  account: Pick<LocalAccount, 'address' | 'signTypedData'>,
): ReviewSigner {
  return {
    address: account.address,
    signTypedData: (typedData) => account.signTypedData(typedData),
  };
}
