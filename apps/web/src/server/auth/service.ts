import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { getAddress, verifyMessage } from 'viem';
import { z } from 'zod';
import { chainIdSchema, nonZeroAddressSchema } from '@lexaegis/protocol/v1';
import { createApplicationError, type ApplicationError, type ErrorCode } from '@lexaegis/protocol';
import { loadPublicConfig } from '@/config/public';
import { challengeViewSchema, sessionViewSchema, type SessionView } from '@/lib/auth-schema';
import { buildLoginMessage, checkLoginMessage } from '@/lib/login-message';
import { clearCookie, cookieNames, readCookie, serializeCookie } from './cookies';
import { CHALLENGE_TTL_MS, SESSION_TTL_MS, type AuthStore } from './store';

/*
 * Backend sign-in with EIP-4361. Proves control of the derived address; it does not attest a
 * biometric, a passkey provider or a professional identity, and it never touches the registry's
 * action nonce. Pure of framework code so it is tested directly and against real PostgreSQL.
 */

export interface AuthConfig {
  /** Configured origin. Never derived from Host or forwarding headers. */
  readonly origin: string;
  readonly chainId: string;
  readonly secureCookies: boolean;
}

type EnvRecord = Readonly<Record<string, string | undefined>>;

/** Null unless a valid origin and chain are configured. HTTP is accepted for localhost only. */
export function loadAuthConfig(env: EnvRecord): AuthConfig | null {
  const loaded = loadPublicConfig(env);
  if (!loaded.ok) return null;
  const { appOrigin, chainId } = loaded.config;
  if (appOrigin === undefined || chainId === undefined) return null;
  const url = new URL(appOrigin);
  const secure = url.protocol === 'https:';
  if (!secure && url.hostname !== 'localhost') return null;
  return { origin: appOrigin, chainId, secureCookies: secure };
}

export interface AuthDependencies {
  /** Null when no database is configured: every operation is then unavailable. */
  readonly store: AuthStore | null;
  readonly config: AuthConfig | null;
  readonly now: () => Date;
  readonly randomBytes: (length: number) => Uint8Array;
}

export interface AuthReply {
  readonly status: number;
  readonly body: unknown;
  readonly cookies: readonly string[];
}

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  NOT_CONFIGURED: 503,
};

const challengeRequestSchema = z.strictObject({
  address: nonZeroAddressSchema,
  chainId: chainIdSchema,
});
const verifyRequestSchema = z.strictObject({
  challengeId: z.string().regex(/^[0-9a-f]{32}$/),
  signature: z.string().regex(/^0x[0-9a-f]{130}$/),
});

const MINUTE = 60_000;

export function createAuthService(deps: AuthDependencies) {
  const fail = (
    code: ErrorCode,
    message: string,
    requestId: string,
    cookies: string[] = [],
  ): AuthReply => ({
    status: STATUS[code] ?? 500,
    body: {
      ok: false,
      error: createApplicationError(code, message, requestId) satisfies ApplicationError,
    },
    cookies,
  });
  const unavailable = (requestId: string) =>
    fail('NOT_CONFIGURED', 'Account sign-in is not configured.', requestId);
  // One answer for every sign-in failure, so a caller cannot tell which check rejected it.
  const rejected = (requestId: string) => fail('UNAUTHENTICATED', 'Sign-in failed.', requestId);
  const windowStart = (now: Date) => new Date(Math.floor(now.getTime() / MINUTE) * MINUTE);

  return {
    /** Issues a server-built login message bound to a fresh pre-auth cookie. */
    async challenge(body: unknown, requestId: string): Promise<AuthReply> {
      const { store, config } = deps;
      if (store === null || config === null) return unavailable(requestId);
      const parsed = challengeRequestSchema.safeParse(body);
      if (!parsed.success || parsed.data.chainId !== config.chainId) {
        return fail('INVALID_INPUT', 'The sign-in request is not valid.', requestId);
      }
      const now = deps.now();
      const allowed =
        (await store.allow(`challenge:${parsed.data.address}`, windowStart(now), 10)) &&
        (await store.allow('challenge:all', windowStart(now), 600));
      if (!allowed)
        return fail('RATE_LIMITED', 'Too many sign-in attempts. Try again shortly.', requestId);

      const nonce = hex(deps.randomBytes(16));
      const message = buildLoginMessage({
        origin: config.origin,
        address: parsed.data.address,
        chainId: config.chainId,
        nonce,
        issuedAt: now,
      });
      if (message === null)
        return fail('INVALID_INPUT', 'The sign-in request is not valid.', requestId);

      const preauth = hex(deps.randomBytes(32));
      const id = hex(deps.randomBytes(16));
      const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
      await store.createChallenge({
        id,
        address: parsed.data.address,
        chainId: config.chainId,
        message,
        preauthHash: sha256Hex(preauth),
        createdAt: now,
        expiresAt,
      });
      await store.cleanup(now, 200);
      const names = cookieNames(config.secureCookies);
      return {
        status: 200,
        body: challengeViewSchema.parse({
          challengeId: id,
          message,
          expiresAt: expiresAt.toISOString(),
        }),
        cookies: [
          serializeCookie(names.preauth, preauth, CHALLENGE_TTL_MS / 1000, config.secureCookies),
        ],
      };
    },

    /** Verifies the signature over the exact stored message and rotates the session cookie. */
    async verify(
      body: unknown,
      cookieHeader: string | null,
      requestId: string,
    ): Promise<AuthReply> {
      const { store, config } = deps;
      if (store === null || config === null) return unavailable(requestId);
      const parsed = verifyRequestSchema.safeParse(body);
      if (!parsed.success) return rejected(requestId);
      const now = deps.now();
      if (!(await store.allow(`verify:${parsed.data.challengeId}`, windowStart(now), 5))) {
        return fail('RATE_LIMITED', 'Too many sign-in attempts. Try again shortly.', requestId);
      }
      const names = cookieNames(config.secureCookies);
      const preauth = readCookie(cookieHeader, names.preauth);
      const challenge = await store.getChallenge(parsed.data.challengeId);
      if (preauth === null || challenge === null) return rejected(requestId);
      const preauthHash = sha256Hex(preauth);
      if (challenge.preauthHash !== preauthHash || challenge.consumedAt !== null)
        return rejected(requestId);
      if (challenge.expiresAt.getTime() <= now.getTime()) return rejected(requestId);

      const check = checkLoginMessage(challenge.message, {
        origin: config.origin,
        address: challenge.address,
        chainId: challenge.chainId,
        now,
      });
      if (!check.ok || challenge.chainId !== config.chainId) return rejected(requestId);

      // EOA recovery over the EIP-191 hash of the exact stored bytes.
      const signed = await verifyMessage({
        address: getAddress(challenge.address),
        message: challenge.message,
        signature: parsed.data.signature as `0x${string}`,
      }).catch(() => false);
      if (!signed) return rejected(requestId);

      const token = hex(deps.randomBytes(32));
      const previous = readCookie(cookieHeader, names.session);
      const session = await store.consumeChallengeAndCreateSession({
        challengeId: challenge.id,
        preauthHash,
        now,
        tokenHash: sha256Hex(token),
        sessionExpiresAt: new Date(now.getTime() + SESSION_TTL_MS),
        ...(previous !== null && { replacesTokenHash: sha256Hex(previous) }),
      });
      if (session === null) return rejected(requestId);
      return {
        status: 200,
        body: sessionViewSchema.parse({
          address: session.address,
          chainId: session.chainId,
          expiresAt: session.expiresAt.toISOString(),
        }),
        cookies: [
          serializeCookie(names.session, token, SESSION_TTL_MS / 1000, config.secureCookies),
          clearCookie(names.preauth, config.secureCookies),
        ],
      };
    },

    /** The authenticated identity, read from the cookie only. */
    async session(
      cookieHeader: string | null,
    ): Promise<SessionView | 'unauthenticated' | 'unavailable'> {
      const { store, config } = deps;
      if (store === null || config === null) return 'unavailable';
      const token = readCookie(cookieHeader, cookieNames(config.secureCookies).session);
      if (token === null) return 'unauthenticated';
      const session = await store.getSession(sha256Hex(token), deps.now());
      return session === null
        ? 'unauthenticated'
        : {
            address: session.address,
            chainId: session.chainId,
            expiresAt: session.expiresAt.toISOString(),
          };
    },

    async me(cookieHeader: string | null, requestId: string): Promise<AuthReply> {
      const session = await this.session(cookieHeader);
      if (session === 'unavailable') return unavailable(requestId);
      if (session === 'unauthenticated')
        return fail('UNAUTHENTICATED', 'Not signed in.', requestId);
      return { status: 200, body: session, cookies: [] };
    },

    /** Revokes the session and clears both cookies. Clearing happens even when revocation cannot. */
    async logout(cookieHeader: string | null, requestId: string): Promise<AuthReply> {
      const { store, config } = deps;
      if (config === null) return unavailable(requestId);
      const names = cookieNames(config.secureCookies);
      const cleared = [
        clearCookie(names.session, config.secureCookies),
        clearCookie(names.preauth, config.secureCookies),
      ];
      if (store === null) return { ...unavailable(requestId), cookies: cleared };
      const token = readCookie(cookieHeader, names.session);
      if (token !== null) await store.revokeSession(sha256Hex(token), deps.now());
      return { status: 200, body: { signedOut: true }, cookies: cleared };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;

export const systemRandomBytes = (length: number): Uint8Array => nodeRandomBytes(length);
