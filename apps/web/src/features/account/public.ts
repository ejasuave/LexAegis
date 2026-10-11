import type { PublicConfig } from '@/config/public';
import { createAuthClient } from './auth-client';
import { detectCapabilities } from './capabilities';
import { resolveAccountConfig, type AccountConfig } from './config';
import { forgetProfileHint, loadProfileHint, saveProfileHint } from './derivation-profile';
import type { AccountErrorCode, AccountResult } from './errors';
import { PasskeyCeremonies, defaultPasskeyFunctions } from './mera-passkeys';
import type { RegistryTransactionSigning } from './registry-transaction-signing';
import { createReviewGateLatch, type ReviewGate, type ReviewSigning } from './review-signing';
import {
  SessionController,
  type AccountSnapshot,
  type LockReason,
  type TabChannel,
  type VaultConsumer,
} from './session-controller';

/*
 * The only account surface UI code may import. It exposes public status and a handful of
 * commands. No signer, session, key, PRF access or arbitrary signing method crosses this line,
 * and the same is all the future assistant may see: it can describe an account state, but it
 * cannot unlock, create a ticket, request PRF bytes or sign.
 */

export type {
  AccountSnapshot,
  AccountEvent,
  LockReason,
  VaultConsumer,
} from './session-controller';
export type { AccountResult } from './errors';
export type {
  QuoteInput,
  RegistryTransactionSigning,
  SignedRegistryTransaction,
  TransactionIntent,
  TransactionPreview,
  TransactionTicket,
} from './registry-transaction-signing';
export type {
  PreviewTicket,
  ReviewGate,
  ReviewRequest,
  ReviewSigning,
  SignedReviewAction,
} from './review-signing';
export type { AccountErrorCode } from './errors';

export interface AccountCommands {
  createAndSignIn(): Promise<AccountResult<null>>;
  /** Unlocks the account this browser remembers, pinned to its passkey. */
  unlock(): Promise<AccountResult<null>>;
  /** Recovers with no local data: the browser offers this site's passkeys. */
  recover(): Promise<AccountResult<null>>;
  lock(): void;
  signOut(): Promise<AccountResult<null>>;
  cancel(): void;
  forgetHint(): void;
  noteInteraction(): void;
  /**
   * Evaluates the fixed VAULT salt on the credential verified in this tab, after an explicit
   * gesture, and hands the bytes to the single trusted consumer. There is no other PRF access.
   */
  unlockVault(): Promise<AccountResult<null>>;
}

export type { AccountConfig } from './config';
export type AccountAvailability = 'available' | 'unsupported' | 'misconfigured';

export interface AccountHandle {
  readonly availability: AccountAvailability;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => AccountSnapshot;
  readonly commands: AccountCommands;
  /**
   * Two-stage transaction authorisation for the registry only (never a general signer). Tickets
   * are opaque, single-use and die on lock, account switch or expiry.
   */
  readonly transactions: RegistryTransactionSigning;
  /**
   * Stage one: a one-use preview ticket and the confirmation that signs one exact registry
   * action. It refuses unless the review gate, bound by the approval controller, is open.
   */
  readonly review: ReviewSigning;
  /** Installs the live review gate check; see ReviewGateLatch. Returns its remover. */
  bindReviewGate(check: ReviewGate): () => void;
  /** Fires on every loss of local signing authority, so the vault can clear its own material. */
  onLock(listener: (reason: LockReason) => void): () => void;
  dispose(): void;
}

export const EMPTY_SNAPSHOT: AccountSnapshot = Object.freeze({
  generation: 0,
  account: null,
  ceremony: 'idle',
  signing: Object.freeze({ state: 'locked', expiresAt: null, idleExpiresAt: null }),
  backend: Object.freeze({ state: 'unknown', address: null, expiresAt: null }),
  lastEvent: null,
  lastError: null,
  passkeyMayExist: false,
  fallbackAssertion: null,
  hasHint: false,
});

export type AccountStatusLabel =
  'Awaiting passkey' | 'Account ready' | 'Locked' | 'Account unavailable' | 'No account';

/** One honest label for the account, derived from real controller state only. */
export function accountStatusLabel(
  snapshot: AccountSnapshot,
  availability: AccountAvailability,
): AccountStatusLabel {
  if (availability !== 'available') return 'Account unavailable';
  if (snapshot.ceremony === 'awaiting_passkey') return 'Awaiting passkey';
  if (snapshot.account === null) return 'No account';
  return snapshot.signing.state === 'unlocked' ? 'Account ready' : 'Locked';
}

const unavailable = (): Promise<AccountResult<null>> =>
  Promise.resolve({ ok: false, code: 'UNSUPPORTED' satisfies AccountErrorCode });

function inert(availability: AccountAvailability): AccountHandle {
  return {
    availability,
    subscribe: () => () => undefined,
    getSnapshot: () => EMPTY_SNAPSHOT,
    commands: {
      createAndSignIn: unavailable,
      unlock: unavailable,
      recover: unavailable,
      lock: () => undefined,
      signOut: unavailable,
      cancel: () => undefined,
      forgetHint: () => undefined,
      noteInteraction: () => undefined,
      unlockVault: unavailable,
    },
    transactions: {
      preview: () => ({ ok: false, code: 'UNSUPPORTED' }),
      confirm: () => Promise.resolve({ ok: false, code: 'UNSUPPORTED' }),
      invalidateAll: () => undefined,
    },
    review: {
      preview: () => ({ ok: false, code: 'UNSUPPORTED' }),
      confirm: () => Promise.resolve({ ok: false, code: 'UNSUPPORTED' }),
      owns: () => false,
      invalidateAll: () => undefined,
    },
    bindReviewGate: () => () => undefined,
    onLock: () => () => undefined,
    dispose: () => undefined,
  };
}

const PROMPT_TIMEOUT_MS = 120_000;

/**
 * Builds the tab's account controller from validated configuration. Called once, in the
 * browser, before any click, so a ceremony starts straight from the user's gesture.
 * Production wiring only: the review-signing gate is the production one (shut). The vault
 * consumer, if any, is the single trusted receiver of vault PRF bytes (Chapter 5).
 */
export function createBrowserAccount(
  publicConfig: PublicConfig,
  options: {
    readonly vaultConsumer?: VaultConsumer | null;
    readonly onConfig?: (config: AccountConfig) => void;
  } = {},
): AccountHandle {
  const config = resolveAccountConfig(publicConfig, window.location.origin);
  if (!config.ok) return inert('misconfigured');
  if (detectCapabilities().state !== 'available') return inert('unsupported');

  options.onConfig?.(config.data);
  const rpId = config.data.rpId;
  const channel: TabChannel | null =
    typeof BroadcastChannel === 'function'
      ? (new BroadcastChannel('lexaegis.account') as unknown as TabChannel)
      : null;
  const latch = createReviewGateLatch();
  const controller = new SessionController({
    config: config.data,
    ceremonies: new PasskeyCeremonies(config.data, {
      // Mera's own functions and its default browser WebAuthn client.
      ...defaultPasskeyFunctions,
      timeoutMs: PROMPT_TIMEOUT_MS,
    }),
    auth: createAuthClient(),
    now: () => Date.now(),
    hints: {
      load: () => loadProfileHint(window.localStorage, rpId),
      save: (profile) => saveProfileHint(window.localStorage, profile),
      forget: () => forgetProfileHint(window.localStorage),
    },
    channel,
    reviewGate: latch.gate,
    vaultConsumer: options.vaultConsumer ?? null,
  });

  const onHide = () => controller.handlePageHide();
  const onShow = (event: PageTransitionEvent) => controller.handlePageShow(event.persisted);
  const onVisible = () => controller.tick();
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onShow);
  document.addEventListener('visibilitychange', onVisible);
  // A convenience only: limits are enforced at signing time, not by this timer.
  const timer = window.setInterval(() => controller.tick(), 1000);
  void controller.refreshBackend();

  return {
    availability: 'available',
    subscribe: controller.subscribe,
    getSnapshot: controller.getSnapshot,
    commands: {
      createAndSignIn: () => controller.createAndSignIn(),
      unlock: () => controller.recoverKnown(),
      recover: () => controller.recoverByDiscovery(),
      lock: () => controller.lock(),
      signOut: () => controller.signOut(),
      cancel: () => controller.cancel(),
      forgetHint: () => controller.forgetHint(),
      noteInteraction: () => controller.noteInteraction(),
      unlockVault: () => controller.unlockVault(),
    },
    transactions: controller.transactions,
    review: controller.review,
    bindReviewGate: (check) => latch.bind(check),
    onLock: (listener) => controller.onLock(listener),
    dispose: () => {
      window.clearInterval(timer);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
      document.removeEventListener('visibilitychange', onVisible);
      controller.dispose();
    },
  };
}
