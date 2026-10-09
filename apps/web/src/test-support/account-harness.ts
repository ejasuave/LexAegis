/**
 * lexaegis-test-only
 * TEST SUPPORT. Wires the real session controller, real Mera functions, the real request guard
 * and the real auth service together in memory, with a scripted authenticator and clock.
 */
import { createPasskeyWithPrfOutput, getPasskeyPrfOutput } from '@category-labs/mera';
import { createAuthClient, type AuthClient } from '@/features/account/auth-client';
import type { AccountConfig } from '@/features/account/config';
import type { PublicAccountProfile } from '@/features/account/derivation-profile';
import { PasskeyCeremonies } from '@/features/account/mera-passkeys';
import { productionReviewGate, type ReviewGate } from '@/features/account/review-signing';
import {
  SessionController,
  type ControllerDependencies,
  type TabChannel,
  type VaultConsumer,
} from '@/features/account/session-controller';
import { readGuardedJson } from '@/server/auth/request-guard';
import { createAuthService, type AuthService } from '@/server/auth/service';
import { FakeAuthenticator, type FakeAuthenticatorOptions } from './fake-authenticator';
import { createMemoryAuthStore, type MemoryAuthStore } from './memory-auth-store';

export const ORIGIN = 'https://app.lexaegis.test';
export const CONFIG: AccountConfig = {
  origin: ORIGIN,
  rpId: 'app.lexaegis.test',
  rpName: 'LexAegis',
  chainId: '10143',
  registryAddress: `0x${'ab'.repeat(20)}`,
};
export const START = Date.parse('2026-10-08T12:00:00Z');

export class Clock {
  now = START;
  advance(ms: number): void {
    this.now += ms;
  }
}

/** A browser-like fetch against the real guard and service, with a cookie jar. */
export class Backend {
  readonly store: MemoryAuthStore = createMemoryAuthStore();
  readonly service: AuthService;
  readonly jar = new Map<string, string>();
  online = true;
  /** Every response body seen, for secret-sentinel scans. */
  readonly responses: string[] = [];
  readonly requests: string[] = [];
  #counter = 0;

  constructor(
    readonly clock: Clock,
    origin = ORIGIN,
    chainId = CONFIG.chainId,
  ) {
    this.service = createAuthService({
      store: this.store,
      config: { origin, chainId, secureCookies: true },
      now: () => new Date(clock.now),
      randomBytes: (length) => {
        this.#counter += 1;
        return Uint8Array.from({ length }, (_, index) => (this.#counter * 31 + index * 7) & 0xff);
      },
    });
  }

  cookieHeader(): string | null {
    return this.jar.size === 0
      ? null
      : [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  readonly fetch = async (path: string, init: RequestInit): Promise<Response> => {
    if (!this.online) throw new TypeError('network down');
    const request = new Request(`${ORIGIN}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string> | undefined), origin: ORIGIN },
      ...(init.body != null && { body: init.body }),
    });
    if (typeof init.body === 'string') this.requests.push(init.body);
    const cookies = this.cookieHeader();
    let reply;
    if (path === '/api/auth/me') reply = await this.service.me(cookies, 'req');
    else {
      const guarded = await readGuardedJson(request, ORIGIN);
      if (!guarded.ok) return new Response('{}', { status: 403 });
      if (path === '/api/auth/challenge') reply = await this.service.challenge(guarded.body, 'req');
      else if (path === '/api/auth/verify')
        reply = await this.service.verify(guarded.body, cookies, 'req');
      else reply = await this.service.logout(cookies, 'req');
    }
    for (const cookie of reply.cookies) {
      const [pair = '', ...attributes] = cookie.split('; ');
      const [name = '', value = ''] = pair.split('=');
      if (attributes.includes('Max-Age=0')) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = JSON.stringify(reply.body);
    this.responses.push(text);
    return new Response(text, { status: reply.status });
  };
}

export class MemoryHints {
  value: PublicAccountProfile | null = null;
  raw: string | null = null;
  load = (): PublicAccountProfile | null => this.value;
  save = (profile: PublicAccountProfile): void => {
    this.value = profile;
    this.raw = JSON.stringify(profile);
  };
  forget = (): void => {
    this.value = null;
    this.raw = null;
  };
}

export class Channel implements TabChannel {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: unknown[] = [];
  peer: Channel | null = null;
  postMessage(message: unknown): void {
    this.sent.push(message);
    this.peer?.onmessage?.({ data: message });
  }
  close(): void {
    this.onmessage = null;
  }
}

export interface HarnessOptions {
  authenticator?: FakeAuthenticator;
  authenticatorOptions?: FakeAuthenticatorOptions;
  backend?: Backend;
  clock?: Clock;
  hints?: MemoryHints;
  channel?: Channel;
  reviewGate?: ReviewGate;
  vaultConsumer?: VaultConsumer | null;
  config?: AccountConfig;
  auth?: AuthClient;
  derive?: ControllerDependencies['derive'];
}

export function createHarness(options: HarnessOptions = {}) {
  const clock = options.clock ?? new Clock();
  const authenticator =
    options.authenticator ?? new FakeAuthenticator(options.authenticatorOptions);
  const config = options.config ?? CONFIG;
  const backend = options.backend ?? new Backend(clock, ORIGIN, config.chainId);
  const hints = options.hints ?? new MemoryHints();
  const channel = options.channel ?? new Channel();
  const ceremonies = new PasskeyCeremonies(config, {
    create: createPasskeyWithPrfOutput,
    get: getPasskeyPrfOutput,
    webAuthnClient: authenticator.client,
  });
  const controller = new SessionController({
    config,
    ceremonies,
    auth: options.auth ?? createAuthClient(backend.fetch),
    now: () => clock.now,
    hints,
    channel,
    reviewGate: options.reviewGate ?? productionReviewGate,
    vaultConsumer: options.vaultConsumer ?? null,
    ...(options.derive !== undefined && { derive: options.derive }),
  });
  return { clock, authenticator, backend, hints, channel, config, ceremonies, controller };
}
