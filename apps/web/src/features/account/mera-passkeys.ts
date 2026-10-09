import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  isMeraError,
  type PasskeyCredentialMetadata,
  type WebAuthnClient,
} from '@category-labs/mera';
import type { AccountConfig } from './config';
import { credentialIdSchema } from './derivation-profile';
import { failWith, succeed, wipe, type AccountErrorCode, type AccountResult } from './errors';

const PRF_BYTES = 32;

export interface CreatedPasskey {
  readonly credential: PasskeyCredentialMetadata;
  /** Caller-owned PRF output. The caller must wipe it. */
  readonly prfOutput: Uint8Array<ArrayBuffer>;
  /**
   * Whether creation needed a second (assertion) ceremony. Known only when the WebAuthn client
   * is observable; null in the browser, where the SDK does not report it. Never assume one prompt.
   */
  readonly fallbackAssertion: boolean | null;
}

export interface EvaluatedPasskey {
  readonly credentialId: string;
  /** Caller-owned PRF output. The caller must wipe it. */
  readonly prfOutput: Uint8Array<ArrayBuffer>;
}

export interface PasskeyDependencies {
  readonly create: typeof createPasskeyWithPrfOutput;
  readonly get: typeof getPasskeyPrfOutput;
  /** Mera's own seam for the ceremony transport. Only tests supply one. */
  readonly webAuthnClient?: WebAuthnClient;
  readonly timeoutMs?: number;
}

/** Mera's real functions with its default browser WebAuthn client. */
export const defaultPasskeyFunctions: Pick<PasskeyDependencies, 'create' | 'get'> = {
  create: createPasskeyWithPrfOutput,
  get: getPasskeyPrfOutput,
};
const DEFAULT_DEPENDENCIES: PasskeyDependencies = defaultPasskeyFunctions;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function causeName(error: unknown): string | null {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  if (cause !== null && typeof cause === 'object' && 'name' in cause) {
    return typeof cause.name === 'string' ? cause.name : null;
  }
  return null;
}

/**
 * Maps a thrown value to a redaction-safe code. Mera reports cancellation, a missing API and an
 * unexpected credential under one broad code, so only the underlying cause is used to tell them
 * apart, and an unrecognised cause stays a plain failure.
 */
export function mapPasskeyError(error: unknown): AccountErrorCode {
  if (!isMeraError(error)) return 'FAILED';
  switch (error.code) {
    case 'PRF_UNAVAILABLE':
      return 'PRF_UNAVAILABLE';
    case 'CRYPTO_UNAVAILABLE':
      return 'UNSUPPORTED';
    case 'PASSKEY_OPERATION_FAILED': {
      const name = causeName(error);
      if (name === 'AbortError') return 'CANCELLED';
      if (name === 'NotAllowedError') return 'NOT_COMPLETED';
      if (name === 'NotSupportedError' || name === 'SecurityError') return 'UNSUPPORTED';
      return 'FAILED';
    }
    default:
      return 'FAILED';
  }
}

/**
 * The only caller of Mera's passkey functions. One ceremony runs at a time, and each captures a
 * generation: a result that arrives after `cancel()` (Cancel, lock, sign-out, account switch,
 * navigation) is discarded and its bytes cleared. Mera exposes no abort signal, so cancelling
 * cannot dismiss the browser prompt and never removes a passkey an authenticator already made.
 */
export class PasskeyCeremonies {
  readonly #config: AccountConfig;
  readonly #deps: PasskeyDependencies;
  #generation = 0;
  #busy = false;

  constructor(config: AccountConfig, deps: PasskeyDependencies = DEFAULT_DEPENDENCIES) {
    this.#config = config;
    this.#deps = deps;
  }

  get busy(): boolean {
    return this.#busy;
  }

  /** Discards whatever ceremony is in flight. */
  cancel(): void {
    this.#generation += 1;
  }

  async #run<T extends { prfOutput: Uint8Array }, R>(
    ceremony: () => Promise<T>,
    accept: (result: T) => AccountResult<R>,
  ): Promise<AccountResult<R>> {
    if (this.#busy) return failWith('BUSY');
    this.#busy = true;
    const generation = this.#generation;
    try {
      const result = await ceremony();
      if (generation !== this.#generation) {
        wipe(result.prfOutput);
        return failWith('STALE');
      }
      const accepted = accept(result);
      if (!accepted.ok) wipe(result.prfOutput);
      return accepted;
    } catch (error) {
      return failWith(generation === this.#generation ? mapPasskeyError(error) : 'CANCELLED');
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Creates a passkey and evaluates `prfSalt` for it. Mera generates a fresh user handle, so
   * each call adds a credential. A failure after the authenticator created it leaves that
   * passkey behind; the caller offers recovery and never retries creation on its own.
   */
  create(
    labels: { readonly name: string; readonly displayName: string },
    prfSalt: Uint8Array<ArrayBuffer>,
  ): Promise<AccountResult<CreatedPasskey>> {
    let assertions = 0;
    const observed = this.#deps.webAuthnClient;
    const webAuthnClient: WebAuthnClient | undefined =
      observed === undefined
        ? undefined
        : {
            createCredential: (request) => observed.createCredential(request),
            getCredential: (request) => {
              assertions += 1;
              return observed.getCredential(request);
            },
          };
    const expectedSalt = prfSalt.slice();
    return this.#run(
      () =>
        this.#deps.create({
          rp: { id: this.#config.rpId, name: this.#config.rpName },
          user: labels,
          prfSalt,
          ...(this.#deps.timeoutMs !== undefined && { timeout: this.#deps.timeoutMs }),
          ...(webAuthnClient !== undefined && { webAuthnClient }),
        }),
      (result) => {
        const id = credentialIdSchema.safeParse(result.credentialId);
        if (
          !id.success ||
          result.prfOutput.length !== PRF_BYTES ||
          !sameBytes(result.prfSalt, expectedSalt)
        ) {
          return failWith('FAILED');
        }
        return succeed({
          credential: {
            credentialId: id.data,
            ...(result.transports !== undefined && { transports: [...result.transports] }),
          },
          prfOutput: result.prfOutput,
          fallbackAssertion: observed === undefined ? null : assertions > 0,
        });
      },
    );
  }

  /**
   * Evaluates `prfSalt` on an existing passkey. With `credential` the assertion is pinned and any
   * other credential is rejected; without it the browser offers the discoverable credentials for
   * this rpId, which is how recovery works with an empty cache.
   */
  evaluate(
    prfSalt: Uint8Array<ArrayBuffer>,
    credential?: PasskeyCredentialMetadata,
  ): Promise<AccountResult<EvaluatedPasskey>> {
    return this.#run(
      () =>
        this.#deps.get({
          rpId: this.#config.rpId,
          prfSalt,
          ...(credential !== undefined && { credential }),
          ...(this.#deps.timeoutMs !== undefined && { timeout: this.#deps.timeoutMs }),
          ...(this.#deps.webAuthnClient !== undefined && {
            webAuthnClient: this.#deps.webAuthnClient,
          }),
        }),
      (result) => {
        const id = credentialIdSchema.safeParse(result.credentialId);
        if (!id.success || result.prfOutput.length !== PRF_BYTES) return failWith('FAILED');
        if (credential !== undefined && id.data !== credential.credentialId) {
          return failWith('WRONG_CREDENTIAL');
        }
        return succeed({ credentialId: id.data, prfOutput: result.prfOutput });
      },
    );
  }
}
