import type { PasskeyCredentialMetadata } from '@category-labs/mera';
import type { Eip712ReviewAction } from '@lexaegis/sdk/registry';
import { checkRegistryTransaction } from '@lexaegis/sdk/transactions';
import type { TransactionSerializableEIP1559 } from 'viem';
import { checkLoginMessage } from '@/lib/login-message';
import type { AuthClient } from './auth-client';
import type { AccountConfig } from './config';
import { deriveAccount, type DerivedAccount } from './derive-account';
import {
  ACCOUNT_PROFILE_SCHEMA,
  PROFILE_ID,
  accountPrfSalt,
  vaultPrfSalt,
  type PublicAccountProfile,
} from './derivation-profile';
import { failWith, succeed, wipe, type AccountErrorCode, type AccountResult } from './errors';
import type { PasskeyCeremonies } from './mera-passkeys';
import {
  createRegistryTransactionSigning,
  type RegistryTransactionSigning,
} from './registry-transaction-signing';
import { createReviewSigning, type ReviewGate, type ReviewSigning } from './review-signing';

/** Signing-session limits. The absolute limit is never extended; only deliberate use refreshes idle time. */
export const ABSOLUTE_LIMIT_MS = 10 * 60_000;
export const IDLE_LIMIT_MS = 5 * 60_000;
const CLOCK_TOLERANCE_MS = 2_000;

export type AccountEvent =
  | 'account_created'
  | 'account_recovered'
  | 'signing_unlocked'
  | 'signing_locked'
  | 'signing_expired'
  | 'signed_in'
  | 'signed_out'
  | 'recovery_mismatch'
  | 'hint_forgotten'
  | 'cancelled';

export type LockReason =
  'user' | 'expired' | 'sign_out' | 'account_switch' | 'page_hidden' | 'other_tab' | 'cancel';

/**
 * Immutable public view of the account. It carries no key, PRF output, signature, token or
 * signer object, so it is safe in React state, developer tools and assistant status events.
 * The four sub-states are independent: an unlocked signer does not mean signed in, a signed-in
 * backend does not mean the vault is open, and none of them says anything about a receipt.
 */
export interface AccountSnapshot {
  readonly generation: number;
  readonly account: { readonly address: string; readonly verifiedThisSession: boolean } | null;
  readonly ceremony: 'idle' | 'awaiting_passkey';
  readonly signing: {
    readonly state: 'locked' | 'unlocked';
    /** Unix milliseconds; null while locked. */
    readonly expiresAt: number | null;
    readonly idleExpiresAt: number | null;
  };
  readonly backend: {
    readonly state: 'unknown' | 'signed_out' | 'signing_in' | 'signed_in' | 'unavailable';
    readonly address: string | null;
    readonly expiresAt: string | null;
  };
  readonly lastEvent: AccountEvent | null;
  readonly lastError: AccountErrorCode | null;
  /** True when account creation failed after the browser prompt: a passkey may have been left behind. */
  readonly passkeyMayExist: boolean;
  /** Whether creation needed a second prompt; null when the browser does not reveal it. */
  readonly fallbackAssertion: boolean | null;
  readonly hasHint: boolean;
}

/** Public, cross-tab notice. Never a key, signature or token. */
type TabNotice = { readonly type: 'account_invalidated' };

export interface TabChannel {
  postMessage(message: TabNotice): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

/** Chapter 5 supplies the one trusted consumer of vault PRF bytes. It must not retain them. */
export type VaultConsumer = (
  prfOutput: Uint8Array,
  account: { readonly address: string },
) => Promise<void> | void;

export interface ControllerDependencies {
  readonly config: AccountConfig;
  readonly ceremonies: PasskeyCeremonies;
  readonly auth: AuthClient;
  /** Unix milliseconds. Injected so limits are testable and never depend on timers alone. */
  readonly now: () => number;
  readonly hints: {
    load(): PublicAccountProfile | null;
    save(profile: PublicAccountProfile): void;
    forget(): void;
  };
  readonly channel?: TabChannel | null;
  readonly reviewGate: ReviewGate;
  readonly vaultConsumer?: VaultConsumer | null;
  readonly derive?: (prfOutput: Uint8Array) => AccountResult<DerivedAccount>;
}

interface Signer {
  readonly derived: DerivedAccount;
  readonly startedAt: number;
  lastInteractionAt: number;
}

type Mode = 'create' | 'known' | 'discover';

/**
 * Whether typed data is a review action for the configured chain and registry, by this
 * account, with an unexpired deadline. Checked again at the moment of signing, independently of
 * the preview bridge.
 */
export function reviewActionInScope(
  typedData: Eip712ReviewAction,
  config: AccountConfig,
  address: string,
  nowSeconds: bigint,
): boolean {
  const { domain, message } = typedData;
  return (
    config.registryAddress !== null &&
    domain.chainId.toString() === config.chainId &&
    domain.verifyingContract.toLowerCase() === config.registryAddress &&
    message.reviewer.toLowerCase() === address &&
    message.deadline > nowSeconds
  );
}

/** Thrown inside a signing operation when the payload is outside the two permitted scopes. */
class ScopeError extends Error {}

/**
 * Tab-local, memory-only owner of the signing session. The Mera session and viem account live
 * in private fields and never leave this class: consumers get snapshots and a few narrow
 * commands. Only two things can ever be signed: the server's login message and an exact,
 * explicitly confirmed registry action.
 */
export class SessionController {
  readonly #deps: ControllerDependencies;
  readonly #listeners = new Set<() => void>();
  readonly #lockListeners = new Set<(reason: LockReason) => void>();
  readonly review: ReviewSigning;
  readonly transactions: RegistryTransactionSigning;

  #signer: Signer | null = null;
  #credential: PasskeyCredentialMetadata | null = null;
  #generation = 0;
  #lastNow = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #disposed = false;
  #snapshot: AccountSnapshot;

  constructor(deps: ControllerDependencies) {
    this.#deps = deps;
    this.#lastNow = deps.now();
    const hint = deps.hints.load();
    const initial: AccountSnapshot = {
      generation: 0,
      account: hint === null ? null : { address: hint.address, verifiedThisSession: false },
      ceremony: 'idle',
      signing: { state: 'locked', expiresAt: null, idleExpiresAt: null },
      backend: { state: 'unknown', address: null, expiresAt: null },
      lastEvent: null,
      lastError: null,
      passkeyMayExist: false,
      fallbackAssertion: null,
      hasHint: hint !== null,
    };
    this.#snapshot = Object.freeze(initial);
    this.review = createReviewSigning(
      {
        config: deps.config,
        generation: () => this.#generation,
        address: () => this.#signer?.derived.address ?? null,
        now: deps.now,
        sign: (typedData, generation) => this.#signReview(typedData, generation),
      },
      deps.reviewGate,
    );
    this.transactions = createRegistryTransactionSigning(
      {
        config: deps.config,
        generation: () => this.#generation,
        address: () => this.#signer?.derived.address ?? null,
        now: deps.now,
        signTransaction: (tx, generation) => this.#signRegistryTransaction(tx, generation),
      },
      this.review,
    );
    if (deps.channel) {
      deps.channel.onmessage = (event) => {
        // Another tab changed or ended the account. This tab drops its signer and re-reads identity.
        if ((event.data as TabNotice | null)?.type === 'account_invalidated') {
          this.#endSigner('other_tab');
          void this.refreshBackend();
        }
      };
    }
  }

  // ---- Public store ------------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): AccountSnapshot => this.#snapshot;

  /** Chapter 5 registers vault cleanup here. Called on every loss of local signing authority. */
  onLock(listener: (reason: LockReason) => void): () => void {
    this.#lockListeners.add(listener);
    return () => this.#lockListeners.delete(listener);
  }

  #publish(patch: Partial<AccountSnapshot>): void {
    const signer = this.#signer;
    this.#snapshot = Object.freeze({
      ...this.#snapshot,
      ...patch,
      generation: this.#generation,
      signing: Object.freeze(
        signer === null
          ? { state: 'locked' as const, expiresAt: null, idleExpiresAt: null }
          : {
              state: 'unlocked' as const,
              expiresAt: signer.startedAt + ABSOLUTE_LIMIT_MS,
              idleExpiresAt: signer.lastInteractionAt + IDLE_LIMIT_MS,
            },
      ),
    });
    for (const listener of this.#listeners) listener();
  }

  // ---- Session limits ----------------------------------------------------------------------------

  /** Null while the signer may be used; otherwise the reason, after ending it. */
  #liveness(): AccountErrorCode | null {
    const signer = this.#signer;
    if (signer === null) return 'SESSION_LOCKED';
    const now = this.#deps.now();
    const rolledBack = now + CLOCK_TOLERANCE_MS < this.#lastNow;
    this.#lastNow = Math.max(this.#lastNow, now);
    if (
      rolledBack ||
      now - signer.startedAt >= ABSOLUTE_LIMIT_MS ||
      now - signer.lastInteractionAt >= IDLE_LIMIT_MS
    ) {
      this.#endSigner('expired');
      return 'SESSION_EXPIRED';
    }
    return null;
  }

  /** Re-evaluates limits. Call on a timer and on resume; it never extends anything. */
  tick(): void {
    if (this.#signer !== null) this.#liveness();
  }

  /** A deliberate user interaction. Background work must never call this. */
  noteInteraction(): void {
    const signer = this.#signer;
    if (signer === null || this.#liveness() !== null) return;
    signer.lastInteractionAt = this.#deps.now();
    this.#publish({});
  }

  #endSigner(reason: LockReason): void {
    const signer = this.#signer;
    this.#signer = null;
    this.#generation += 1;
    this.#deps.ceremonies.cancel();
    this.review.invalidateAll();
    this.transactions.invalidateAll();
    if (signer !== null) {
      // Zeroes Mera's copy of the key; any later signing call throws SESSION_ENDED.
      signer.derived.session.end();
      for (const listener of this.#lockListeners) listener(reason);
    }
    const account = this.#snapshot.account;
    this.#publish({
      ceremony: 'idle',
      ...(signer !== null && {
        lastEvent: reason === 'expired' ? 'signing_expired' : 'signing_locked',
      }),
      ...(reason === 'expired' && { lastError: 'SESSION_EXPIRED' }),
      account: account === null ? null : { ...account },
    });
  }

  // ---- Commands ----------------------------------------------------------------------------------

  /** Locks local signing. Always succeeds, online or not. Backend sign-in is a separate state. */
  lock(reason: LockReason = 'user'): void {
    this.#endSigner(reason);
  }

  /** Abandons a prompt in flight. It cannot dismiss the browser dialog or undo a created passkey. */
  cancel(): void {
    if (this.#snapshot.ceremony === 'idle') return;
    this.#generation += 1;
    this.#deps.ceremonies.cancel();
    this.review.invalidateAll();
    this.transactions.invalidateAll();
    this.#publish({ ceremony: 'idle', lastEvent: 'cancelled', lastError: 'CANCELLED' });
  }

  createAndSignIn(): Promise<AccountResult<null>> {
    return this.#establish('create');
  }

  /** Recovers with the cached hint when one exists, pinned to its credential. */
  recoverKnown(): Promise<AccountResult<null>> {
    return this.#establish(this.#deps.hints.load() === null ? 'discover' : 'known');
  }

  /** Recovers with no cache at all: the browser offers this site's discoverable passkeys. */
  recoverByDiscovery(): Promise<AccountResult<null>> {
    return this.#establish('discover');
  }

  /** Drops an invalid local hint so discovery can be retried. Public metadata only is removed. */
  forgetHint(): void {
    this.#endSigner('account_switch');
    this.#credential = null;
    this.#deps.hints.forget();
    this.#publish({ account: null, hasHint: false, lastEvent: 'hint_forgotten', lastError: null });
  }

  async signOut(): Promise<AccountResult<null>> {
    // Local authority goes first and unconditionally; revocation is best effort and reported honestly.
    this.#endSigner('sign_out');
    this.#credential = null;
    this.#deps.channel?.postMessage({ type: 'account_invalidated' });
    const result = await this.#deps.auth.logout();
    const account = this.#snapshot.account;
    this.#publish({
      backend: result.ok
        ? { state: 'signed_out', address: null, expiresAt: null }
        : { state: 'unavailable', address: this.#snapshot.backend.address, expiresAt: null },
      account: account === null ? null : { address: account.address, verifiedThisSession: false },
      lastEvent: 'signed_out',
      lastError: result.ok ? null : result.code,
    });
    return result;
  }

  /** Re-reads the backend identity. A cached address or hint never counts as signed in. */
  async refreshBackend(): Promise<void> {
    const generation = this.#generation;
    const result = await this.#deps.auth.me();
    if (generation !== this.#generation || this.#disposed) return;
    if (!result.ok) {
      this.#publish({ backend: { state: 'unavailable', address: null, expiresAt: null } });
      return;
    }
    const session = result.data;
    const signer = this.#signer;
    if (session !== null && signer !== null && session.address !== signer.derived.address) {
      // Two accounts must never share one working context.
      this.#endSigner('account_switch');
    }
    this.#publish({
      backend:
        session === null
          ? { state: 'signed_out', address: null, expiresAt: null }
          : { state: 'signed_in', address: session.address, expiresAt: session.expiresAt },
      ...(this.#snapshot.account === null &&
        session !== null && { account: { address: session.address, verifiedThisSession: false } }),
    });
  }

  handlePageHide(): void {
    this.#endSigner('page_hidden');
  }

  /** A page restored from the back-forward cache must not come back with a signer. */
  handlePageShow(persisted: boolean): void {
    if (!persisted) return;
    this.#endSigner('page_hidden');
    void this.refreshBackend();
  }

  dispose(): void {
    this.#disposed = true;
    this.#endSigner('page_hidden');
    this.#deps.channel?.close();
    this.#listeners.clear();
    this.#lockListeners.clear();
  }

  // ---- Establishing a session --------------------------------------------------------------------

  async #establish(mode: Mode): Promise<AccountResult<null>> {
    if (this.#snapshot.ceremony !== 'idle' || this.#deps.ceremonies.busy) return failWith('BUSY');
    const { config, ceremonies, hints } = this.#deps;
    const hint = mode === 'known' ? hints.load() : null;
    if (mode === 'known' && hint === null) return failWith('NO_ACCOUNT');

    // Starting a new candidate ends any current signer first.
    this.#endSigner(mode === 'known' ? 'user' : 'account_switch');
    const generation = this.#generation;
    this.#publish({ ceremony: 'awaiting_passkey', lastError: null, passkeyMayExist: false });

    const fail = (
      code: AccountErrorCode,
      patch: Partial<AccountSnapshot> = {},
    ): AccountResult<null> => {
      if (generation === this.#generation)
        this.#publish({ ceremony: 'idle', lastError: code, ...patch });
      return failWith(code);
    };

    let credential: PasskeyCredentialMetadata;
    let prfOutput: Uint8Array;
    let fallbackAssertion: boolean | null = null;
    if (mode === 'create') {
      const created = await ceremonies.create(
        { name: 'LexAegis account', displayName: 'LexAegis account' },
        accountPrfSalt(),
      );
      // Any failure once the browser was asked may have left a passkey on the authenticator.
      if (!created.ok)
        return fail(created.code, {
          passkeyMayExist: created.code !== 'UNSUPPORTED' && created.code !== 'BUSY',
        });
      ({ credential, prfOutput, fallbackAssertion } = created.data);
    } else {
      const pinned: PasskeyCredentialMetadata | undefined =
        hint === null
          ? undefined
          : {
              credentialId: hint.credentialId,
              ...(hint.transports !== undefined && { transports: hint.transports }),
            };
      const evaluated = await ceremonies.evaluate(accountPrfSalt(), pinned);
      if (!evaluated.ok) return fail(evaluated.code);
      credential = pinned ?? { credentialId: evaluated.data.credentialId };
      prfOutput = evaluated.data.prfOutput;
    }
    if (generation !== this.#generation) {
      wipe(prfOutput);
      return failWith('STALE');
    }

    // Consumes and zeroes prfOutput.
    const derived = (this.#deps.derive ?? deriveAccount)(prfOutput);
    if (!derived.ok) return fail(derived.code, { passkeyMayExist: mode === 'create' });

    // A known account must reproduce its address. A different one is never silently attached.
    const expected = hint?.address ?? null;
    if (expected !== null && expected !== derived.data.address) {
      derived.data.session.end();
      return fail('ADDRESS_MISMATCH', { lastEvent: 'recovery_mismatch' });
    }

    const now = this.#deps.now();
    this.#signer = { derived: derived.data, startedAt: now, lastInteractionAt: now };
    this.#credential = credential;
    hints.save({
      schema: ACCOUNT_PROFILE_SCHEMA,
      profileId: PROFILE_ID,
      rpId: config.rpId,
      credentialId: credential.credentialId,
      ...(credential.transports !== undefined && { transports: [...credential.transports] }),
      address: derived.data.address,
    });
    // The derived account is shown before anything of its data could be loaded.
    this.#publish({
      ceremony: 'idle',
      account: { address: derived.data.address, verifiedThisSession: true },
      hasHint: true,
      fallbackAssertion,
      lastEvent:
        mode === 'create'
          ? 'account_created'
          : mode === 'known'
            ? 'signing_unlocked'
            : 'account_recovered',
    });
    this.#deps.channel?.postMessage({ type: 'account_invalidated' });

    return this.#signIn();
  }

  /** Backend sign-in with the live signer. No second passkey prompt is involved. */
  async #signIn(): Promise<AccountResult<null>> {
    const generation = this.#generation;
    const signer = this.#signer;
    if (signer === null) return failWith('SESSION_LOCKED');
    const { auth, config } = this.#deps;
    const address = signer.derived.address;

    const current = await auth.me();
    if (generation !== this.#generation) return failWith('STALE');
    if (current.ok && current.data?.address === address) {
      this.#publish({
        backend: { state: 'signed_in', address, expiresAt: current.data.expiresAt },
      });
      return succeed(null);
    }

    this.#publish({ backend: { state: 'signing_in', address: null, expiresAt: null } });
    const backendFailure = (code: AccountErrorCode): AccountResult<null> => {
      if (generation === this.#generation) {
        this.#publish({
          backend: {
            state: code === 'BACKEND_UNAVAILABLE' ? 'unavailable' : 'signed_out',
            address: null,
            expiresAt: null,
          },
          lastError: code,
        });
      }
      return failWith(code);
    };

    const challenge = await auth.challenge(address, config.chainId);
    if (generation !== this.#generation) return failWith('STALE');
    if (!challenge.ok) return backendFailure(challenge.code);

    const signature = await this.#signLogin(challenge.data.message, generation);
    if (!signature.ok) return backendFailure(signature.code);

    const verified = await auth.verify(challenge.data.challengeId, signature.data);
    if (generation !== this.#generation) return failWith('STALE');
    if (!verified.ok) return backendFailure(verified.code);
    if (verified.data.address !== address) {
      this.#endSigner('account_switch');
      return failWith('ADDRESS_MISMATCH');
    }
    this.#publish({
      backend: { state: 'signed_in', address, expiresAt: verified.data.expiresAt },
      lastEvent: 'signed_in',
      lastError: null,
    });
    return succeed(null);
  }

  // ---- The only two signing operations -----------------------------------------------------------

  /** Runs one signing operation at a time, with liveness and generation checked before and after. */
  #serialized<T>(
    generation: number,
    operation: (derived: DerivedAccount) => Promise<T>,
  ): Promise<AccountResult<T>> {
    const run = async (): Promise<AccountResult<T>> => {
      const before = this.#liveness();
      if (before !== null) return failWith(before);
      const signer = this.#signer;
      if (signer === null || generation !== this.#generation) return failWith('SESSION_LOCKED');
      let result: T;
      try {
        result = await operation(signer.derived);
      } catch (error) {
        if (error instanceof ScopeError) return failWith('SCOPE_REJECTED');
        return failWith(this.#signer === signer ? 'FAILED' : 'SESSION_LOCKED');
      }
      // A lock, switch or expiry during the wait means this signature is not released.
      if (generation !== this.#generation || this.#signer !== signer)
        return failWith('SESSION_LOCKED');
      const after = this.#liveness();
      if (after !== null) return failWith(after);
      return succeed(result);
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Signs the server's login message, and only that: exact origin, account, chain, statement and lifetime. */
  #signLogin(message: string, generation: number): Promise<AccountResult<`0x${string}`>> {
    const { config } = this.#deps;
    return this.#serialized(generation, async (derived) => {
      const check = checkLoginMessage(message, {
        origin: config.origin,
        address: derived.address,
        chainId: config.chainId,
        now: new Date(this.#deps.now()),
      });
      if (!check.ok) throw new ScopeError();
      return derived.account.signMessage({ message });
    });
  }

  /** Reached only through a confirmed preview ticket (review-signing.ts). */
  #signReview(
    typedData: Eip712ReviewAction,
    generation: number,
  ): Promise<AccountResult<`0x${string}`>> {
    const { config } = this.#deps;
    return this.#serialized(generation, async (derived) => {
      const nowSeconds = BigInt(Math.floor(this.#deps.now() / 1000));
      const inScope = reviewActionInScope(typedData, config, derived.address, nowSeconds);
      if (!inScope) throw new ScopeError();
      return derived.account.signTypedData(typedData);
    });
  }

  /** Reached only through a confirmed transaction ticket (registry-transaction-signing.ts). */
  #signRegistryTransaction(
    tx: TransactionSerializableEIP1559,
    generation: number,
  ): Promise<AccountResult<`0x${string}`>> {
    const { config } = this.#deps;
    return this.#serialized(generation, async (derived) => {
      const scope = config.registryAddress;
      const inScope =
        scope !== null &&
        checkRegistryTransaction(tx, {
          chainId: Number(config.chainId),
          registryAddress: scope,
        }).ok;
      // Never a contract creation, transfer, other selector, access list or authorisation list.
      if (!inScope) throw new ScopeError();
      return derived.account.signTransaction(tx);
    });
  }

  // ---- Vault boundary (Chapter 5) ----------------------------------------------------------------

  /**
   * Evaluates the VAULT salt, and only that salt, on the credential verified in this tab, after
   * an explicit vault-unlock gesture. The bytes go to the one trusted consumer and are zeroed
   * when it returns or throws. There is no arbitrary-salt PRF access for anything else.
   */
  async unlockVault(): Promise<AccountResult<null>> {
    const consumer = this.#deps.vaultConsumer ?? null;
    if (consumer === null) return failWith('UNAVAILABLE');
    const credential = this.#credential;
    const account = this.#snapshot.account;
    if (credential === null || account === null || !account.verifiedThisSession)
      return failWith('SESSION_LOCKED');
    const generation = this.#generation;

    const evaluated = await this.#deps.ceremonies.evaluate(vaultPrfSalt(), credential);
    if (!evaluated.ok) return evaluated;
    try {
      if (
        generation !== this.#generation ||
        evaluated.data.credentialId !== credential.credentialId
      ) {
        return failWith('STALE');
      }
      await consumer(evaluated.data.prfOutput, { address: account.address });
      return succeed(null);
    } catch {
      return failWith('FAILED');
    } finally {
      wipe(evaluated.data.prfOutput);
    }
  }
}
