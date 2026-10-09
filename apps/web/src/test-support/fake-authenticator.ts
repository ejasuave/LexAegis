/**
 * lexaegis-test-only
 * TEST SUPPORT. A scripted WebAuthn client for Mera's `webAuthnClient` seam. It stands in for
 * the browser and an authenticator in unit tests; real Mera code still runs on top of it. It is
 * not evidence of real PRF support, prompt counts or synced-credential recovery.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { WebAuthnClient } from '@category-labs/mera';

interface StoredCredential {
  readonly id: Uint8Array;
  readonly rpId: string;
  /** Per-credential secret: the PRF is HMAC-like, deterministic in (secret, salt). */
  readonly secret: Uint8Array;
}

export interface FakeAuthenticatorOptions {
  /** Evaluate PRF during creation (no fallback assertion needed). */
  createTimePrf?: boolean;
  /** Authenticator has no PRF at all. */
  prfSupported?: boolean;
}

function domError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

export class FakeAuthenticator {
  readonly credentials: StoredCredential[] = [];
  readonly calls = { create: 0, get: 0 };
  /** Hex of every PRF output handed out, so tests can prove none of them leaks. */
  readonly prfOutputs: string[] = [];
  options: Required<FakeAuthenticatorOptions>;
  /** When set, the next ceremony rejects with a DOMException-like error of this name. */
  failNext: string | null = null;
  /** When set, ceremonies wait for release() before answering. */
  #gate: Promise<void> | null = null;
  #open: (() => void) | null = null;
  /** Which discoverable credential the "user" picks when the request is not pinned. */
  pick = 0;
  /** Forces an assertion to answer with this credential even when another was requested. */
  answerWith: Uint8Array | null = null;

  constructor(options: FakeAuthenticatorOptions = {}) {
    this.options = { createTimePrf: true, prfSupported: true, ...options };
  }

  hold(): void {
    this.#gate = new Promise((resolve) => {
      this.#open = resolve;
    });
  }

  release(): void {
    this.#open?.();
    this.#gate = null;
    this.#open = null;
  }

  #prf(credential: StoredCredential, salt: Uint8Array): Uint8Array {
    const output = new Uint8Array(
      createHash('sha256').update(credential.secret).update(salt).digest(),
    );
    this.prfOutputs.push(Buffer.from(output).toString('hex'));
    return output;
  }

  async #before(): Promise<void> {
    if (this.#gate !== null) await this.#gate;
    const failure = this.failNext;
    if (failure !== null) {
      this.failNext = null;
      throw domError(failure);
    }
  }

  readonly client: WebAuthnClient = {
    createCredential: async (request) => {
      this.calls.create += 1;
      await this.#before();
      const credential: StoredCredential = {
        id: new Uint8Array(randomBytes(16)),
        rpId: request.rp.id,
        secret: new Uint8Array(randomBytes(32)),
      };
      this.credentials.push(credential);
      const { prfSupported, createTimePrf } = this.options;
      return {
        credentialId: credential.id.slice(),
        transports: ['internal'],
        prfEnabled: prfSupported,
        ...(prfSupported && createTimePrf && { prfOutput: this.#prf(credential, request.prfSalt) }),
      };
    },
    getCredential: async (request) => {
      this.calls.get += 1;
      await this.#before();
      const forRp = this.credentials.filter((credential) => credential.rpId === request.rpId);
      const wanted = this.answerWith ?? request.allowCredential?.credentialId;
      const selected =
        wanted === undefined
          ? forRp[this.pick]
          : forRp.find((credential) => Buffer.from(credential.id).equals(Buffer.from(wanted)));
      if (selected === undefined) throw domError('NotAllowedError');
      return {
        credentialId: selected.id.slice(),
        ...(this.options.prfSupported && { prfOutput: this.#prf(selected, request.prfSalt) }),
      };
    },
  };
}
