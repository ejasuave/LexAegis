import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { LOGIN_STATEMENT, buildLoginMessage, checkLoginMessage } from '@/lib/login-message';
import { createMemoryAuthStore } from '@/test-support/memory-auth-store';
import { clearCookie, cookieNames, readCookie, serializeCookie } from './cookies';
import { AUTH_BODY_LIMIT, readGuardedJson } from './request-guard';
import { createAuthService, loadAuthConfig, sha256Hex, type AuthConfig } from './service';
import { CHALLENGE_TTL_MS, SESSION_TTL_MS } from './store';

// Synthetic test keys. They hold nothing and sign only inside this file.
const signer = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const ADDRESS = signer.address.toLowerCase();
const ORIGIN = 'https://app.lexaegis.test';
const CONFIG: AuthConfig = { origin: ORIGIN, chainId: '10143', secureCookies: true };
const START = Date.parse('2026-10-08T12:00:00Z');

function setup(config: AuthConfig | null = CONFIG, withStore = true) {
  const store = createMemoryAuthStore();
  const clock = { now: START };
  let counter = 0;
  const service = createAuthService({
    store: withStore ? store : null,
    config,
    now: () => new Date(clock.now),
    randomBytes: (length) => {
      counter += 1;
      return Uint8Array.from({ length }, (_, index) => (counter * 17 + index * 13) & 0xff);
    },
  });
  return { store, clock, service };
}

interface Challenge {
  challengeId: string;
  message: string;
}
const cookieOf = (reply: { cookies: readonly string[] }, name: string) =>
  reply.cookies
    .map((cookie) => cookie.split('; ')[0] ?? '')
    .find((pair) => pair.startsWith(`${name}=`)) ?? '';

async function challenge(s: ReturnType<typeof setup>, address = ADDRESS) {
  const reply = await s.service.challenge({ address, chainId: '10143' }, 'req');
  return {
    reply,
    body: reply.body as Challenge,
    preauth: cookieOf(reply, '__Host-lexaegis_preauth'),
  };
}

async function signIn(s: ReturnType<typeof setup>, extraCookies = '') {
  const c = await challenge(s);
  const signature = await signer.signMessage({ message: c.body.message });
  const reply = await s.service.verify(
    { challengeId: c.body.challengeId, signature },
    `${c.preauth}; ${extraCookies}`,
    'req',
  );
  return { ...c, signature, reply, session: cookieOf(reply, '__Host-lexaegis_session') };
}

describe('login message', () => {
  const fields = {
    origin: ORIGIN,
    address: ADDRESS,
    chainId: '10143',
    nonce: 'a'.repeat(32),
    issuedAt: new Date(START),
  };
  const message = buildLoginMessage(fields) ?? '';
  const expected = {
    origin: ORIGIN,
    address: ADDRESS,
    chainId: '10143',
    now: new Date(START + 1000),
  };

  it('is an EIP-4361 message scoped to signing in only', () => {
    expect(
      message.startsWith('app.lexaegis.test wants you to sign in with your Ethereum account:'),
    ).toBe(true);
    expect(message).toContain(signer.address);
    expect(message).toContain(LOGIN_STATEMENT);
    expect(message).toContain(`URI: ${ORIGIN}`);
    expect(message).toContain('Version: 1');
    expect(message).toContain('Chain ID: 10143');
    expect(message).toContain('Expiration Time: 2026-10-08T12:05:00.000Z');
    expect(checkLoginMessage(message, expected)).toMatchObject({ ok: true, nonce: 'a'.repeat(32) });
  });

  it.each([
    ['another address', { ...expected, address: stranger.address.toLowerCase() }],
    ['another domain and URI', { ...expected, origin: 'https://evil.test' }],
    ['another port', { ...expected, origin: `${ORIGIN}:8443` }],
    ['another chain', { ...expected, chainId: '143' }],
    ['another nonce', { ...expected, nonce: 'b'.repeat(32) }],
    ['an expired message', { ...expected, now: new Date(START + CHALLENGE_TTL_MS) }],
    ['a message from the future', { ...expected, now: new Date(START - 120_000) }],
  ])('rejects %s', (_label, expectation) => {
    expect(checkLoginMessage(message, expectation)).toEqual({ ok: false });
  });

  it.each([
    ['an altered statement', message.replace('only signs you in', 'approves everything')],
    ['an added resource', `${message}\nResources:\n- https://evil.test`],
    ['an added request ID', `${message}\nRequest ID: 1`],
    ['a longer lifetime', message.replace('12:05:00.000Z', '13:05:00.000Z')],
    ['arbitrary text', 'Please sign this to continue'],
    ['an empty string', ''],
  ])('rejects %s', (_label, altered) => {
    expect(checkLoginMessage(altered, expected)).toEqual({ ok: false });
  });
});

describe('challenge', () => {
  it('builds the message from configuration and binds it to a fresh pre-auth cookie', async () => {
    const s = setup();
    const { reply, body, preauth } = await challenge(s);
    expect(reply.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['challengeId', 'expiresAt', 'message']);
    expect(body.message).toContain(`URI: ${ORIGIN}`);
    expect(reply.cookies[0]).toBe(
      `${preauth}; Path=/; Max-Age=300; HttpOnly; SameSite=Strict; Secure`,
    );
    const stored = s.store.challenges.get(body.challengeId);
    // Only the hash of the pre-auth value is stored.
    expect(stored?.preauthHash).toBe(sha256Hex(preauth.split('=')[1] ?? ''));
    expect(JSON.stringify(stored)).not.toContain(preauth.split('=')[1]);
    expect(stored?.expiresAt.getTime()).toBe(START + CHALLENGE_TTL_MS);
  });

  it('uses unpredictable 128-bit identifiers and nonces', async () => {
    const s = setup();
    const a = await challenge(s);
    const b = await challenge(s);
    expect(a.body.challengeId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.body.challengeId).not.toBe(b.body.challengeId);
    expect(a.body.message).not.toBe(b.body.message);
  });

  it.each([
    ['a client-supplied message', { address: ADDRESS, chainId: '10143', message: 'sign this' }],
    ['a client-supplied domain', { address: ADDRESS, chainId: '10143', domain: 'evil.test' }],
    ['another chain', { address: ADDRESS, chainId: '143' }],
    ['a checksummed address', { address: signer.address, chainId: '10143' }],
    ['the zero address', { address: `0x${'00'.repeat(20)}`, chainId: '10143' }],
    ['nothing', null],
  ])('rejects %s', async (_label, body) => {
    const reply = await setup().service.challenge(body, 'req');
    expect(reply.status).toBe(400);
    expect(reply.cookies).toEqual([]);
  });

  it('rate-limits per address in the shared store', async () => {
    const s = setup();
    for (let i = 0; i < 10; i += 1) expect((await challenge(s)).reply.status).toBe(200);
    expect((await challenge(s)).reply.status).toBe(429);
    s.clock.now += 60_000;
    expect((await challenge(s)).reply.status).toBe(200);
  });
});

describe('verify', () => {
  it('signs in with a valid signature over the exact stored message and rotates the cookie', async () => {
    const s = setup();
    const { reply, session } = await signIn(s);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      address: ADDRESS,
      chainId: '10143',
      expiresAt: new Date(START + SESSION_TTL_MS).toISOString(),
    });
    expect(reply.cookies[0]).toBe(
      `${session}; Path=/; Max-Age=900; HttpOnly; SameSite=Strict; Secure`,
    );
    expect(reply.cookies[1]).toContain('__Host-lexaegis_preauth=; Path=/; Max-Age=0');
    for (const cookie of reply.cookies) expect(cookie).not.toMatch(/Domain=/i);
    // The bearer token is in the cookie only: hashed in storage, absent from the body.
    const token = session.split('=')[1] ?? '';
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(reply.body)).not.toContain(token);
    expect([...s.store.sessions.keys()]).toEqual([sha256Hex(token)]);
  });

  const failure = { status: 401, cookies: [] };

  it('rejects a signature from another key', async () => {
    const s = setup();
    const c = await challenge(s);
    const signature = await stranger.signMessage({ message: c.body.message });
    expect(
      await s.service.verify({ challengeId: c.body.challengeId, signature }, c.preauth, 'req'),
    ).toMatchObject(failure);
    expect(s.store.sessions.size).toBe(0);
  });

  it('rejects a signature over an altered message', async () => {
    const s = setup();
    const c = await challenge(s);
    const signature = await signer.signMessage({ message: c.body.message.replace('10143', '143') });
    expect(
      await s.service.verify({ challengeId: c.body.challengeId, signature }, c.preauth, 'req'),
    ).toMatchObject(failure);
  });

  it('rejects a missing or wrong pre-auth binding (login swapping)', async () => {
    const s = setup();
    const victim = await challenge(s);
    const attacker = await challenge(s);
    const signature = await signer.signMessage({ message: victim.body.message });
    const body = { challengeId: victim.body.challengeId, signature };
    expect(await s.service.verify(body, null, 'req')).toMatchObject(failure);
    expect(await s.service.verify(body, attacker.preauth, 'req')).toMatchObject(failure);
    expect(s.store.sessions.size).toBe(0);
    expect((await s.service.verify(body, victim.preauth, 'req')).status).toBe(200);
  });

  it('rejects an expired challenge and a replay', async () => {
    const s = setup();
    const c = await challenge(s);
    const signature = await signer.signMessage({ message: c.body.message });
    const body = { challengeId: c.body.challengeId, signature };
    s.clock.now += CHALLENGE_TTL_MS;
    expect(await s.service.verify(body, c.preauth, 'req')).toMatchObject(failure);

    const fresh = setup();
    const first = await signIn(fresh);
    const replay = await fresh.service.verify(
      { challengeId: first.body.challengeId, signature: first.signature },
      first.preauth,
      'req',
    );
    expect(replay).toMatchObject(failure);
    expect(fresh.store.sessions.size).toBe(1);
  });

  it('rejects a challenge stored for another origin, chain or with a tampered message', async () => {
    const s = setup();
    const c = await challenge(s);
    const stored = s.store.challenges.get(c.body.challengeId);
    if (stored === undefined) throw new Error('missing');
    for (const message of [
      buildLoginMessage({
        origin: 'https://evil.test',
        address: ADDRESS,
        chainId: '10143',
        nonce: 'c'.repeat(32),
        issuedAt: new Date(START),
      }),
      buildLoginMessage({
        origin: ORIGIN,
        address: ADDRESS,
        chainId: '143',
        nonce: 'c'.repeat(32),
        issuedAt: new Date(START),
      }),
      `${stored.message}\nResources:\n- https://evil.test`,
    ]) {
      s.store.challenges.set(stored.id, { ...stored, message: message ?? '' });
      const signature = await signer.signMessage({ message: message ?? '' });
      expect(
        await s.service.verify({ challengeId: stored.id, signature }, c.preauth, 'req'),
      ).toMatchObject(failure);
    }
  });

  it('answers every failure identically and takes ownership only from the stored challenge', async () => {
    const s = setup();
    const c = await challenge(s);
    const signature = await signer.signMessage({ message: c.body.message });
    const replies = await Promise.all([
      s.service.verify({ challengeId: 'f'.repeat(32), signature }, c.preauth, 'r1'),
      s.service.verify(
        { challengeId: c.body.challengeId, signature: `0x${'00'.repeat(65)}` },
        c.preauth,
        'r1',
      ),
      s.service.verify(
        { challengeId: c.body.challengeId, signature, address: stranger.address.toLowerCase() },
        c.preauth,
        'r1',
      ),
      s.service.verify('nonsense', c.preauth, 'r1'),
    ]);
    expect(new Set(replies.map((reply) => JSON.stringify(reply))).size).toBe(1);
    expect(replies[0].body).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHENTICATED', message: 'Sign-in failed.' },
    });
  });

  it('revokes the previous session when a new one replaces it', async () => {
    const s = setup();
    const first = await signIn(s);
    s.clock.now += 1000;
    const second = await signIn(s, first.session);
    expect(second.reply.status).toBe(200);
    expect(await s.service.session(first.session)).toBe('unauthenticated');
    expect(await s.service.session(second.session)).toMatchObject({ address: ADDRESS });
  });
});

describe('session, me and logout', () => {
  it('reads identity from the cookie only and expires after fifteen minutes without renewal', async () => {
    const s = setup();
    const { session } = await signIn(s);
    expect((await s.service.me(session, 'req')).body).toMatchObject({
      address: ADDRESS,
      chainId: '10143',
    });
    s.clock.now += SESSION_TTL_MS - 1;
    expect((await s.service.me(session, 'req')).status).toBe(200);
    s.clock.now += 1;
    // Using the session did not extend it.
    expect((await s.service.me(session, 'req')).status).toBe(401);
  });

  it('treats a missing, malformed or unknown cookie as unauthenticated', async () => {
    const s = setup();
    await signIn(s);
    for (const cookie of [
      null,
      '',
      '__Host-lexaegis_session=short',
      `__Host-lexaegis_session=${'0'.repeat(64)}`,
      `lexaegis_session=${'0'.repeat(64)}`,
    ]) {
      expect(await s.service.session(cookie)).toBe('unauthenticated');
    }
  });

  it('logout revokes the session and clears both cookies', async () => {
    const s = setup();
    const { session } = await signIn(s);
    const reply = await s.service.logout(session, 'req');
    expect(reply.status).toBe(200);
    expect(reply.cookies.map((cookie) => cookie.split(';')[0])).toEqual([
      '__Host-lexaegis_session=',
      '__Host-lexaegis_preauth=',
    ]);
    expect(await s.service.session(session)).toBe('unauthenticated');
  });

  it('is unavailable, never bypassed, without a database or a valid origin', async () => {
    for (const s of [setup(CONFIG, false), setup(null, true)]) {
      expect(
        (await s.service.challenge({ address: ADDRESS, chainId: '10143' }, 'req')).status,
      ).toBe(503);
      expect((await s.service.verify({}, null, 'req')).status).toBe(503);
      expect((await s.service.me(null, 'req')).status).toBe(503);
      expect(await s.service.session(`__Host-lexaegis_session=${'0'.repeat(64)}`)).toBe(
        'unavailable',
      );
    }
  });
});

describe('configuration and cookies', () => {
  it('requires HTTPS outside localhost and takes the origin from configuration', () => {
    const env = (origin: string) => ({
      NEXT_PUBLIC_APP_ORIGIN: origin,
      NEXT_PUBLIC_CHAIN_ID: '10143',
    });
    expect(loadAuthConfig(env('https://app.lexaegis.test'))).toEqual(CONFIG);
    expect(loadAuthConfig(env('http://localhost:3000'))).toEqual({
      origin: 'http://localhost:3000',
      chainId: '10143',
      secureCookies: false,
    });
    expect(loadAuthConfig(env('http://app.lexaegis.test'))).toBeNull();
    expect(loadAuthConfig({ NEXT_PUBLIC_APP_ORIGIN: 'https://app.lexaegis.test' })).toBeNull();
    expect(loadAuthConfig({})).toBeNull();
  });

  it('uses __Host- names with Secure on HTTPS and isolates the plain names to localhost HTTP', () => {
    expect(cookieNames(true)).toEqual({
      session: '__Host-lexaegis_session',
      preauth: '__Host-lexaegis_preauth',
    });
    expect(cookieNames(false)).toEqual({
      session: 'lexaegis_session',
      preauth: 'lexaegis_preauth',
    });
    expect(serializeCookie('n', 'v', 60, false)).toBe(
      'n=v; Path=/; Max-Age=60; HttpOnly; SameSite=Strict',
    );
    expect(clearCookie('n', true)).toBe('n=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure');
  });

  it('reads only well-formed 256-bit tokens', () => {
    const token = 'ab'.repeat(32);
    expect(readCookie(`a=1; n=${token}; b=2`, 'n')).toBe(token);
    expect(readCookie(`n=${token.toUpperCase()}`, 'n')).toBeNull();
    expect(readCookie(`n=${token}x`, 'n')).toBeNull();
    expect(readCookie(`xn=${token}`, 'n')).toBeNull();
    expect(readCookie(null, 'n')).toBeNull();
  });
});

describe('request guard', () => {
  const post = (headers: Record<string, string>, body = '{"a":1}') =>
    new Request(`${ORIGIN}/api/auth/challenge`, { method: 'POST', headers, body });
  const good = { origin: ORIGIN, 'content-type': 'application/json', 'x-lexaegis-request': '1' };

  it('accepts the exact origin, JSON and the request header', async () => {
    expect(await readGuardedJson(post(good), ORIGIN)).toEqual({ ok: true, body: { a: 1 } });
    expect(
      (
        await readGuardedJson(
          post({ ...good, 'content-type': 'application/json; charset=utf-8' }),
          ORIGIN,
        )
      ).ok,
    ).toBe(true);
  });

  it.each([
    [
      'a missing Origin',
      { 'content-type': 'application/json', 'x-lexaegis-request': '1' },
      'ORIGIN',
    ],
    ['another origin', { ...good, origin: 'https://evil.test' }, 'ORIGIN'],
    ['the same host on another port', { ...good, origin: `${ORIGIN}:8443` }, 'ORIGIN'],
    ['a null origin', { ...good, origin: 'null' }, 'ORIGIN'],
    [
      'a form content type',
      { ...good, 'content-type': 'application/x-www-form-urlencoded' },
      'CONTENT_TYPE',
    ],
    ['text/plain', { ...good, 'content-type': 'text/plain' }, 'CONTENT_TYPE'],
    ['a missing request header', { origin: ORIGIN, 'content-type': 'application/json' }, 'HEADER'],
  ])('rejects %s', async (_label, headers, reason) => {
    expect(await readGuardedJson(post(headers), ORIGIN)).toEqual({ ok: false, reason });
  });

  it('ignores forwarding headers: only the configured origin counts', async () => {
    const forwarded = {
      ...good,
      origin: 'https://evil.test',
      'x-forwarded-host': 'app.lexaegis.test',
      host: 'app.lexaegis.test',
    };
    expect(await readGuardedJson(post(forwarded), ORIGIN)).toEqual({ ok: false, reason: 'ORIGIN' });
  });

  it('enforces the 16 KiB body limit and rejects malformed JSON', async () => {
    const big = JSON.stringify({ a: 'x'.repeat(AUTH_BODY_LIMIT) });
    expect(await readGuardedJson(post(good, big), ORIGIN)).toEqual({
      ok: false,
      reason: 'TOO_LARGE',
    });
    expect(await readGuardedJson(post(good, '{not json'), ORIGIN)).toEqual({
      ok: false,
      reason: 'MALFORMED',
    });
  });
});
