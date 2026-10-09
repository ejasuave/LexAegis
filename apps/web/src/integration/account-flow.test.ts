import { describe, expect, it } from 'vitest';
import { toEip712ReviewAction } from '@lexaegis/sdk/registry';
import { createAuthClient } from '@/features/account/auth-client';
import { deriveAccount, type DerivedAccount } from '@/features/account/derive-account';
import { failWith, succeed } from '@/features/account/errors';
import {
  ABSOLUTE_LIMIT_MS,
  IDLE_LIMIT_MS,
  reviewActionInScope,
  type LockReason,
} from '@/features/account/session-controller';
import {
  Backend,
  CONFIG,
  Channel,
  Clock,
  MemoryHints,
  createHarness,
} from '@/test-support/account-harness';
import { FakeAuthenticator } from '@/test-support/fake-authenticator';

/*
 * The real session controller, real Mera SDK functions, real request guard and real SIWE
 * service, joined in memory. The authenticator and clock are scripted, so nothing here is
 * evidence of real-device PRF support, prompt counts or synced-credential recovery.
 */

const MINUTE = 60_000;
const address = (h: ReturnType<typeof createHarness>) =>
  h.controller.getSnapshot().account?.address;

describe('create account and sign in', () => {
  it('creates the account, unlocks signing and signs in with one ceremony', async () => {
    const h = createHarness();
    expect(await h.controller.createAndSignIn()).toEqual({ ok: true, data: null });

    const snapshot = h.controller.getSnapshot();
    expect(snapshot.account).toEqual({ address: address(h), verifiedThisSession: true });
    expect(snapshot.signing.state).toBe('unlocked');
    expect(snapshot.signing.expiresAt).toBe(h.clock.now + ABSOLUTE_LIMIT_MS);
    expect(snapshot.backend).toMatchObject({ state: 'signed_in', address: address(h) });
    expect(snapshot.lastEvent).toBe('signed_in');
    expect(snapshot.fallbackAssertion).toBe(false);
    // One creation ceremony; backend sign-in needed no second passkey prompt.
    expect(h.authenticator.calls).toEqual({ create: 1, get: 0 });
    expect(h.backend.store.sessions.size).toBe(1);
  });

  it('records the fallback assertion when the authenticator needs one', async () => {
    const h = createHarness({ authenticatorOptions: { createTimePrf: false } });
    await h.controller.createAndSignIn();
    expect(h.controller.getSnapshot().fallbackAssertion).toBe(true);
    expect(h.authenticator.calls).toEqual({ create: 1, get: 1 });
  });

  it('ignores a double click: one ceremony, one account', async () => {
    const h = createHarness();
    h.authenticator.hold();
    const first = h.controller.createAndSignIn();
    expect(await h.controller.createAndSignIn()).toEqual({ ok: false, code: 'BUSY' });
    expect(await h.controller.recoverByDiscovery()).toEqual({ ok: false, code: 'BUSY' });
    h.authenticator.release();
    expect((await first).ok).toBe(true);
    expect(h.authenticator.credentials).toHaveLength(1);
  });

  it('reports unsupported PRF, warns that a passkey may exist, and never loops creation', async () => {
    const h = createHarness({ authenticatorOptions: { prfSupported: false } });
    expect(await h.controller.createAndSignIn()).toEqual({ ok: false, code: 'PRF_UNAVAILABLE' });
    const snapshot = h.controller.getSnapshot();
    expect(snapshot).toMatchObject({
      account: null,
      ceremony: 'idle',
      lastError: 'PRF_UNAVAILABLE',
      passkeyMayExist: true,
    });
    expect(snapshot.signing.state).toBe('locked');
    expect(h.authenticator.calls.create).toBe(1);
    expect(h.backend.store.challenges.size).toBe(0);
  });

  it('treats a dismissed prompt as not completed and stays signed out', async () => {
    const h = createHarness();
    h.authenticator.failNext = 'NotAllowedError';
    expect(await h.controller.createAndSignIn()).toEqual({ ok: false, code: 'NOT_COMPLETED' });
    expect(h.controller.getSnapshot().backend.state).toBe('unknown');
    expect(h.controller.getSnapshot().signing.state).toBe('locked');
  });

  it('discards a ceremony that finishes after Cancel', async () => {
    const h = createHarness();
    h.authenticator.hold();
    const pending = h.controller.createAndSignIn();
    h.controller.cancel();
    expect(h.controller.getSnapshot()).toMatchObject({ ceremony: 'idle', lastEvent: 'cancelled' });
    h.authenticator.release();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(h.controller.getSnapshot().account).toBeNull();
    expect(h.controller.getSnapshot().signing.state).toBe('locked');
    expect(h.backend.store.sessions.size).toBe(0);
  });

  it('keeps the local account when the backend is down, and says so', async () => {
    const h = createHarness();
    h.backend.online = false;
    expect(await h.controller.createAndSignIn()).toEqual({
      ok: false,
      code: 'BACKEND_UNAVAILABLE',
    });
    const snapshot = h.controller.getSnapshot();
    expect(snapshot.signing.state).toBe('unlocked');
    expect(snapshot.backend.state).toBe('unavailable');
    expect(snapshot.account?.verifiedThisSession).toBe(true);
  });
});

describe('recovery', () => {
  async function created() {
    const h = createHarness();
    await h.controller.createAndSignIn();
    return { h, original: address(h) };
  }

  it('reproduces the same address with an empty browser cache and no backend session', async () => {
    const { h, original } = await created();
    // "Clear storage and cookies": a new tab state sharing only the authenticator.
    const fresh = createHarness({ authenticator: h.authenticator, clock: h.clock });
    expect(fresh.controller.getSnapshot().account).toBeNull();
    expect(await fresh.controller.recoverByDiscovery()).toEqual({ ok: true, data: null });
    expect(address(fresh)).toBe(original);
    expect(fresh.controller.getSnapshot().lastEvent).toBe('signed_in');
    // No new passkey was made to "recover".
    expect(h.authenticator.credentials).toHaveLength(1);
    expect(h.authenticator.calls.create).toBe(1);
  });

  it('derives the account before any backend call, so recovery works with the backend down', async () => {
    const { h, original } = await created();
    const fresh = createHarness({ authenticator: h.authenticator });
    fresh.backend.online = false;
    await fresh.controller.recoverByDiscovery();
    expect(address(fresh)).toBe(original);
    expect(fresh.controller.getSnapshot().signing.state).toBe('unlocked');
  });

  it('unlocks a known account with its pinned credential', async () => {
    const { h, original } = await created();
    h.controller.lock();
    expect(await h.controller.recoverKnown()).toEqual({ ok: true, data: null });
    expect(address(h)).toBe(original);
    expect(h.controller.getSnapshot().signing.state).toBe('unlocked');
    // Already signed in for this address: no second challenge.
    expect(h.backend.store.challenges.size).toBe(1);
  });

  it('rejects a tampered hint that claims another address', async () => {
    const { h } = await created();
    h.controller.lock();
    const hint = h.hints.load();
    if (hint === null) throw new Error('no hint');
    h.hints.value = { ...hint, address: `0x${'12'.repeat(20)}` };
    expect(await h.controller.recoverKnown()).toEqual({ ok: false, code: 'ADDRESS_MISMATCH' });
    const snapshot = h.controller.getSnapshot();
    expect(snapshot.signing.state).toBe('locked');
    expect(snapshot.lastEvent).toBe('recovery_mismatch');
  });

  it('rejects a different credential answering for a known account', async () => {
    const { h } = await created();
    const other = createHarness({ authenticator: h.authenticator });
    await other.controller.createAndSignIn();
    h.controller.lock();
    // The authenticator answers with the second passkey although the first was requested.
    h.authenticator.answerWith = h.authenticator.credentials[1]?.id ?? null;
    const result = await h.controller.recoverKnown();
    expect(result.ok).toBe(false);
    expect(h.controller.getSnapshot().signing.state).toBe('locked');
  });

  it('lets the user forget an invalid hint and retry discovery', async () => {
    const { h, original } = await created();
    h.hints.value = {
      ...(h.hints.load() as NonNullable<ReturnType<MemoryHints['load']>>),
      credentialId: 'AAAA',
    };
    h.controller.forgetHint();
    expect(h.controller.getSnapshot()).toMatchObject({ account: null, hasHint: false });
    expect(h.hints.load()).toBeNull();
    await h.controller.recoverByDiscovery();
    expect(address(h)).toBe(original);
  });

  it('never creates an account when recovery fails', async () => {
    const h = createHarness();
    expect((await h.controller.recoverByDiscovery()).ok).toBe(false);
    expect(h.authenticator.credentials).toHaveLength(0);
    expect(h.controller.getSnapshot().account).toBeNull();
  });

  it('switches account without mixing sessions', async () => {
    const { h, original } = await created();
    h.authenticator.pick = 1;
    const second = createHarness({
      authenticator: h.authenticator,
      backend: h.backend,
      clock: h.clock,
    });
    await second.controller.createAndSignIn();
    expect(address(second)).not.toBe(original);
    // The backend session was rotated to the new account; the old token is revoked.
    const live = [...h.backend.store.sessions.values()].filter((s) => s.revokedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]?.address).toBe(address(second));
  });
});

describe('signing session limits', () => {
  async function unlocked() {
    const h = createHarness({ reviewGate: () => succeed(null) });
    await h.controller.createAndSignIn();
    return h;
  }

  it('expires at the absolute limit even with constant interaction', async () => {
    const h = await unlocked();
    for (let elapsed = 0; elapsed < ABSOLUTE_LIMIT_MS - MINUTE; elapsed += MINUTE) {
      h.clock.advance(MINUTE);
      h.controller.noteInteraction();
    }
    expect(h.controller.getSnapshot().signing.state).toBe('unlocked');
    h.clock.advance(MINUTE);
    h.controller.noteInteraction();
    expect(h.controller.getSnapshot().signing.state).toBe('locked');
    expect(h.controller.getSnapshot().lastEvent).toBe('signing_expired');
  });

  it('expires after five idle minutes; a timer tick does not count as interaction', async () => {
    const h = await unlocked();
    h.clock.advance(IDLE_LIMIT_MS - 1);
    h.controller.tick();
    expect(h.controller.getSnapshot().signing.state).toBe('unlocked');
    h.clock.advance(1);
    h.controller.tick();
    expect(h.controller.getSnapshot()).toMatchObject({ lastError: 'SESSION_EXPIRED' });
    expect(h.controller.getSnapshot().signing.state).toBe('locked');
  });

  it('checks limits at signing time, not only on timers (resume after suspension)', async () => {
    const h = await unlocked();
    h.controller.lock();
    await h.controller.recoverKnown();
    // The machine slept: no timer fired, the clock simply moved.
    h.clock.advance(ABSOLUTE_LIMIT_MS + 1);
    h.backend.jar.clear();
    const fresh = await h.controller.signOut();
    expect(fresh.ok).toBe(true);
    expect(h.controller.getSnapshot().signing.state).toBe('locked');
  });

  it('ends the session when the clock goes backwards', async () => {
    const h = await unlocked();
    h.clock.advance(MINUTE);
    h.controller.tick();
    h.clock.advance(-30_000);
    h.controller.tick();
    expect(h.controller.getSnapshot().signing.state).toBe('locked');
  });

  it('cannot be revived by interaction after expiry', async () => {
    const h = await unlocked();
    h.clock.advance(IDLE_LIMIT_MS);
    h.controller.noteInteraction();
    h.controller.noteInteraction();
    expect(h.controller.getSnapshot().signing.state).toBe('locked');
  });
});

describe('lock, sign out and page lifecycle', () => {
  it('lock ends local signing, keeps backend sign-in separate and fires the vault cleanup hook', async () => {
    const h = createHarness();
    await h.controller.createAndSignIn();
    const reasons: LockReason[] = [];
    h.controller.onLock((reason) => reasons.push(reason));
    h.controller.lock();
    const snapshot = h.controller.getSnapshot();
    expect(snapshot.signing.state).toBe('locked');
    expect(snapshot.backend.state).toBe('signed_in');
    expect(reasons).toEqual(['user']);
    // Locking twice does not fire the hook again: there is nothing left to clear.
    h.controller.lock();
    expect(reasons).toEqual(['user']);
  });

  it('sign out locks locally and revokes the backend session', async () => {
    const h = createHarness();
    await h.controller.createAndSignIn();
    expect(await h.controller.signOut()).toEqual({ ok: true, data: null });
    expect(h.controller.getSnapshot()).toMatchObject({
      backend: { state: 'signed_out' },
      lastEvent: 'signed_out',
    });
    expect([...h.backend.store.sessions.values()].every((s) => s.revokedAt !== null)).toBe(true);
    expect(h.backend.jar.size).toBe(0);
  });

  it('still locks locally when revocation cannot reach the backend, and reports that honestly', async () => {
    const h = createHarness();
    await h.controller.createAndSignIn();
    h.backend.online = false;
    expect(await h.controller.signOut()).toEqual({ ok: false, code: 'BACKEND_UNAVAILABLE' });
    const snapshot = h.controller.getSnapshot();
    expect(snapshot.signing.state).toBe('locked');
    expect(snapshot.backend.state).toBe('unavailable');
    expect(snapshot.lastError).toBe('BACKEND_UNAVAILABLE');
  });

  it('pagehide ends the session and a back-forward-cache restore cannot revive it', async () => {
    const h = createHarness();
    await h.controller.createAndSignIn();
    h.controller.handlePageHide();
    expect(h.controller.getSnapshot().signing.state).toBe('locked');
    h.controller.handlePageShow(true);
    expect(h.controller.getSnapshot().signing.state).toBe('locked');
  });

  it('discards a sign-in whose backend answer arrives after a lock', async () => {
    const clock = new Clock();
    const backend = new Backend(clock);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = createHarness({ clock, backend });
    const slow = createHarness({
      clock,
      backend,
      authenticator: h.authenticator,
      auth: {
        me: () => Promise.resolve(succeed(null)),
        challenge: async () => {
          await gate;
          return failWith('BACKEND_UNAVAILABLE');
        },
        verify: () => Promise.resolve(failWith('BACKEND_REJECTED')),
        logout: () => Promise.resolve(succeed(null)),
      },
    });
    const pending = slow.controller.createAndSignIn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    slow.controller.lock();
    release();
    expect(await pending).toEqual({ ok: false, code: 'STALE' });
    expect(slow.controller.getSnapshot().backend.state).not.toBe('signed_in');
  });

  it('another tab receives only a public invalidation notice and must unlock on its own', async () => {
    const a = new Channel();
    const b = new Channel();
    a.peer = b;
    const authenticator = new FakeAuthenticator();
    const clock = new Clock();
    const backend = new Backend(clock);
    const hints = new MemoryHints();
    const first = createHarness({ authenticator, clock, backend, hints, channel: a });
    await first.controller.createAndSignIn();
    const second = createHarness({ authenticator, clock, backend, hints, channel: b });
    expect(second.controller.getSnapshot().signing.state).toBe('locked');
    expect(second.controller.getSnapshot().account?.verifiedThisSession).toBe(false);

    await first.controller.signOut();
    expect(a.sent).toEqual([{ type: 'account_invalidated' }, { type: 'account_invalidated' }]);
    expect(JSON.stringify(a.sent)).not.toMatch(/0x[0-9a-f]{40,}/);
  });
});

describe('backend identity', () => {
  it('a cached hint alone is never signed in', async () => {
    const h = createHarness();
    await h.controller.createAndSignIn();
    const later = createHarness({ authenticator: h.authenticator, hints: h.hints });
    await later.controller.refreshBackend();
    expect(later.controller.getSnapshot()).toMatchObject({
      account: { verifiedThisSession: false },
      backend: { state: 'signed_out', address: null },
    });
    expect(later.controller.getSnapshot().signing.state).toBe('locked');
  });

  it('ends the local signer when the backend reports a different account', async () => {
    const h = createHarness();
    await h.controller.createAndSignIn();
    for (const [key, session] of h.backend.store.sessions) {
      h.backend.store.sessions.set(key, { ...session, address: `0x${'34'.repeat(20)}` });
    }
    await h.controller.refreshBackend();
    expect(h.controller.getSnapshot().signing.state).toBe('locked');
  });
});

describe('vault boundary', () => {
  it('is unavailable until Chapter 5 supplies a consumer, and is not evaluated during onboarding', async () => {
    const h = createHarness();
    await h.controller.createAndSignIn();
    expect(await h.controller.unlockVault()).toEqual({ ok: false, code: 'UNAVAILABLE' });
    // Only the account salt has been evaluated: one PRF output so far.
    expect(h.authenticator.prfOutputs).toHaveLength(1);
  });

  it('hands vault-salt bytes, distinct from account bytes, to the consumer and zeroes them after', async () => {
    let seen: Uint8Array | null = null;
    let copy = '';
    const h = createHarness({
      vaultConsumer: (bytes) => {
        seen = bytes;
        copy = Buffer.from(bytes).toString('hex');
      },
    });
    await h.controller.createAndSignIn();
    expect(await h.controller.unlockVault()).toEqual({ ok: true, data: null });
    expect(copy).toHaveLength(64);
    expect(copy).not.toBe(h.authenticator.prfOutputs[0]);
    expect((seen as Uint8Array | null)?.every((value) => value === 0)).toBe(true);
    // The vault unlock was its own ceremony, pinned to the verified credential.
    expect(h.authenticator.calls.get).toBe(1);
  });

  it('zeroes the bytes when the consumer throws', async () => {
    let seen: Uint8Array | null = null;
    const h = createHarness({
      vaultConsumer: (bytes) => {
        seen = bytes;
        throw new Error('vault failed');
      },
    });
    await h.controller.createAndSignIn();
    expect(await h.controller.unlockVault()).toEqual({ ok: false, code: 'FAILED' });
    expect((seen as Uint8Array | null)?.every((value) => value === 0)).toBe(true);
  });

  it('refuses a returned credential other than the verified one, and an unverified account', async () => {
    const h = createHarness({ vaultConsumer: () => undefined });
    expect(await h.controller.unlockVault()).toEqual({ ok: false, code: 'SESSION_LOCKED' });
    await h.controller.createAndSignIn();
    const other = createHarness({ authenticator: h.authenticator });
    await other.controller.createAndSignIn();
    h.authenticator.answerWith = h.authenticator.credentials[1]?.id ?? null;
    expect((await h.controller.unlockVault()).ok).toBe(false);
  });
});

describe('secret handling', () => {
  it('keeps PRF output and key material out of snapshots, hints, tab messages, requests and responses', async () => {
    const h = createHarness({ vaultConsumer: () => undefined });
    const snapshots: string[] = [];
    h.controller.subscribe(() => snapshots.push(JSON.stringify(h.controller.getSnapshot())));
    await h.controller.createAndSignIn();
    await h.controller.unlockVault();
    h.controller.lock();
    await h.controller.recoverKnown();
    await h.controller.signOut();

    const surfaces = [
      ...snapshots,
      h.hints.raw ?? '',
      JSON.stringify(h.channel.sent),
      ...h.backend.requests,
      ...h.backend.responses,
      JSON.stringify([...h.backend.store.challenges.values()]),
      JSON.stringify([...h.backend.store.sessions.values()]),
    ].join('\n');
    expect(h.authenticator.prfOutputs.length).toBeGreaterThanOrEqual(3);
    for (const prf of h.authenticator.prfOutputs) expect(surfaces).not.toContain(prf);
    // Bearer tokens are stored hashed and never returned in a body.
    for (const token of h.backend.jar.values()) expect(surfaces).not.toContain(token);
    expect(surfaces).not.toMatch(/privateKey|prfOutput|chainCode|xprv/);
  });

  it('exposes no signer, session or raw signing method on the controller or its snapshot', async () => {
    const h = createHarness();
    await h.controller.createAndSignIn();
    const keys = [
      ...Object.keys(h.controller),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(h.controller)),
    ];
    expect(keys.join(' ')).not.toMatch(
      /signDigest|signMessage|signTypedData|privateKey|session\b|account\b/i,
    );
    expect(Object.isFrozen(h.controller.getSnapshot())).toBe(true);
    expect(JSON.stringify(h.controller)).toBe('{"review":{},"transactions":{}}');
  });
});

describe('key lifetime and signing scope', () => {
  function capturing() {
    const captured: DerivedAccount[] = [];
    const derive = (prfOutput: Uint8Array) => {
      const result = deriveAccount(prfOutput);
      if (result.ok) captured.push(result.data);
      return result;
    };
    return { captured, derive };
  }

  it.each([
    ['Lock', (h: ReturnType<typeof createHarness>) => h.controller.lock()],
    ['Sign out', (h: ReturnType<typeof createHarness>) => void h.controller.signOut()],
    [
      'expiry',
      (h: ReturnType<typeof createHarness>) => {
        h.clock.advance(IDLE_LIMIT_MS);
        h.controller.tick();
      },
    ],
    ['page hide', (h: ReturnType<typeof createHarness>) => h.controller.handlePageHide()],
    ['account switch', (h: ReturnType<typeof createHarness>) => h.controller.forgetHint()],
  ])(
    '%s ends the Mera session itself, so even a retained reference cannot sign',
    async (_label, end) => {
      const { captured, derive } = capturing();
      const h = createHarness({ derive });
      await h.controller.createAndSignIn();
      const live = captured[0];
      if (live === undefined) throw new Error('nothing derived');
      await expect(live.account.signMessage({ message: 'x' })).resolves.toMatch(/^0x/);
      end(h);
      await expect(live.account.signMessage({ message: 'x' })).rejects.toMatchObject({
        code: 'SESSION_ENDED',
      });
    },
  );

  it('does not release a signature that completes after a lock', async () => {
    // A signer whose signature is produced but only delivered once the gate opens.
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let produced = 0;
    const h = createHarness({
      reviewGate: () => succeed(null),
      derive: (prfOutput) => {
        const result = deriveAccount(prfOutput);
        if (!result.ok) return result;
        const { account } = result.data;
        return succeed({
          ...result.data,
          account: {
            ...account,
            signTypedData: (async (parameters: Parameters<typeof account.signTypedData>[0]) => {
              const signature = await account.signTypedData(parameters);
              produced += 1;
              await gate;
              return signature;
            }) as typeof account.signTypedData,
          },
        });
      },
    });
    await h.controller.createAndSignIn();
    const reviewer = h.controller.getSnapshot().account?.address ?? '';
    const commitment = `0x${'a1'.repeat(32)}`;
    const request = {
      action: {
        chainId: CONFIG.chainId,
        registryAddress: CONFIG.registryAddress,
        action: {
          reviewer,
          action: 0,
          commitment,
          replacementCommitment: `0x${'00'.repeat(32)}`,
          nonce: '0',
          deadline: String(Math.floor(h.clock.now / 1000) + 600),
        },
      },
      packageReference: {
        schema: 'lexaegis.receipt-ref.v1',
        chainId: CONFIG.chainId,
        registryAddress: CONFIG.registryAddress,
        reviewerAddress: reviewer,
        commitment,
      },
    };
    const ticket = h.controller.review.preview(request);
    if (!ticket.ok) throw new Error(ticket.code);
    const pending = h.controller.review.confirm(ticket.data, request);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(produced).toBe(1);
    h.controller.lock();
    open();
    // The signature existed in memory, but the lock came first: it is not handed out.
    expect(await pending).toEqual({ ok: false, code: 'SESSION_LOCKED' });
  });

  it.each([
    ['arbitrary text', 'Please sign this to continue'],
    ['a login message for another site', null],
  ])('never signs %s presented as a login challenge', async (_label, message) => {
    const clock = new Clock();
    const backend = new Backend(clock);
    const real = createAuthClient(backend.fetch);
    const elsewhere = new Backend(clock, 'https://evil.test');
    let verifyCalls = 0;
    const h = createHarness({
      clock,
      backend,
      auth: {
        ...real,
        challenge: async (address, chainId) => {
          if (message !== null)
            return succeed({ challengeId: 'a'.repeat(32), message, expiresAt: 'x' });
          const reply = await elsewhere.service.challenge({ address, chainId }, 'req');
          return succeed(reply.body as { challengeId: string; message: string; expiresAt: string });
        },
        verify: (challengeId, signature) => {
          verifyCalls += 1;
          return real.verify(challengeId, signature);
        },
      },
    });
    expect(await h.controller.createAndSignIn()).toEqual({ ok: false, code: 'SCOPE_REJECTED' });
    // No signature was produced, so nothing was sent for verification.
    expect(verifyCalls).toBe(0);
    expect(h.controller.getSnapshot().backend.state).toBe('signed_out');
  });

  it('checks review typed data against account, chain, registry and deadline at signing time', () => {
    const address = `0x${'12'.repeat(20)}`;
    const typed = toEip712ReviewAction({
      domain: {
        name: 'LexAegisProofOfReview',
        version: '1',
        chainId: CONFIG.chainId,
        verifyingContract: CONFIG.registryAddress,
      },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        ReviewAction: [
          { name: 'reviewer', type: 'address' },
          { name: 'action', type: 'uint8' },
          { name: 'commitment', type: 'bytes32' },
          { name: 'replacementCommitment', type: 'bytes32' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'ReviewAction',
      message: {
        reviewer: address,
        action: 0,
        commitment: `0x${'a1'.repeat(32)}`,
        replacementCommitment: `0x${'00'.repeat(32)}`,
        nonce: '0',
        deadline: '1000',
      },
    });
    if (!typed.ok) throw new Error(typed.error.code);
    const data = typed.data;
    expect(reviewActionInScope(data, CONFIG, address, 999n)).toBe(true);
    expect(reviewActionInScope(data, CONFIG, address, 1000n)).toBe(false);
    expect(reviewActionInScope(data, CONFIG, `0x${'34'.repeat(20)}`, 999n)).toBe(false);
    expect(reviewActionInScope(data, { ...CONFIG, chainId: '143' }, address, 999n)).toBe(false);
    expect(
      reviewActionInScope(
        data,
        { ...CONFIG, registryAddress: `0x${'cd'.repeat(20)}` },
        address,
        999n,
      ),
    ).toBe(false);
    expect(reviewActionInScope(data, { ...CONFIG, registryAddress: null }, address, 999n)).toBe(
      false,
    );
  });
});
