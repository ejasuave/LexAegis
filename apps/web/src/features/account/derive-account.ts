import {
  createSecp256k1SigningSession,
  getEvmAddress,
  type Secp256k1SigningSession,
} from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { HDKey } from '@scure/bip32';
import type { LocalAccount } from 'viem';
import { addressSchema } from '@lexaegis/protocol/v1';
import { EVM_PATH } from './derivation-profile';
import { failWith, succeed, wipe, type AccountResult } from './errors';

/**
 * A live signing identity. PRIVATE to the session controller: the Mera session and the viem
 * account can sign anything, so neither is ever handed to UI code, the assistant or a callback.
 * This is a software key in page memory, not a hardware-isolated wallet key.
 */
export interface DerivedAccount {
  /** Lowercase address, the form protocol v1 stores. */
  readonly address: string;
  /** EIP-55 form, as the SIWE message formatter requires. */
  readonly checksumAddress: `0x${string}`;
  readonly session: Secp256k1SigningSession;
  readonly account: LocalAccount;
}

/**
 * Derives the v1 account from a 32-byte account PRF output and CONSUMES that buffer: it is
 * zeroed before this returns, whether or not derivation succeeded. An invalid derivation fails;
 * it never falls back to a random key or to another path.
 */
export function deriveAccount(prfOutput: Uint8Array): AccountResult<DerivedAccount> {
  let master: HDKey | undefined;
  let child: HDKey | undefined;
  let privateKey: Uint8Array | undefined;
  let session: Secp256k1SigningSession | undefined;
  try {
    if (prfOutput.length !== 32) return failWith('FAILED');
    // The PRF output is the BIP-32 master seed itself.
    master = HDKey.fromMasterSeed(prfOutput);
    child = master.derive(EVM_PATH);
    if (child.privateKey === null) return failWith('FAILED');
    privateKey = child.privateKey.slice();

    // Mera copies the key into a session-owned buffer that session.end() zeroes.
    session = createSecp256k1SigningSession({ privateKey });
    const checksumAddress = getEvmAddress(session.publicKey);
    const account = toViemAccount(session);
    const address = addressSchema.safeParse(checksumAddress.toLowerCase());
    // Mera's and viem's views of the key must name the same account.
    if (!address.success || account.address !== checksumAddress) {
      session.end();
      return failWith('FAILED');
    }
    return succeed({ address: address.data, checksumAddress, session, account });
  } catch {
    session?.end();
    return failWith('FAILED');
  } finally {
    wipe(privateKey, prfOutput);
    child?.wipePrivateData();
    master?.wipePrivateData();
  }
}
