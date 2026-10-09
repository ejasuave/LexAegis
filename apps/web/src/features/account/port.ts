import { unavailable, type Result, type EvmAddress } from '@lexaegis/protocol';

/** Public view of an account session. Keys, PRF output and tokens never appear here. */
export interface AccountSession {
  readonly address: EvmAddress;
  readonly state: 'active' | 'expired';
  readonly expiresAt: string;
}

export type SigningPurpose = 'sign-in' | 'registry-action';

export interface SigningRequest {
  readonly purpose: SigningPurpose;
  /** Exact text or digest to sign, as shown to the user. */
  readonly payload: string;
}

/**
 * Browser account provider (Mera in Chapter 4). Signing is only ever performed for an explicit,
 * user-initiated request. Chapter 1 supplies only the unavailable adapter.
 */
export interface AccountProvider {
  createAccount(signal?: AbortSignal): Promise<Result<AccountSession>>;
  recoverAccount(signal?: AbortSignal): Promise<Result<AccountSession>>;
  getSession(): Result<AccountSession>;
  endSession(): Promise<Result<null>>;
  requestSignature(request: SigningRequest, signal?: AbortSignal): Promise<Result<string>>;
}

export function createUnavailableAccountProvider(): AccountProvider {
  const notImplemented = () => unavailable('NOT_IMPLEMENTED', 'Passkey accounts');
  return {
    createAccount: () => Promise.resolve(notImplemented()),
    recoverAccount: () => Promise.resolve(notImplemented()),
    getSession: notImplemented,
    endSession: () => Promise.resolve(notImplemented()),
    requestSignature: () => Promise.resolve(notImplemented()),
  };
}
