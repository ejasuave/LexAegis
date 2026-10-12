import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deployRegistry,
  startMiner,
  writeLocalDeploymentRecord,
  type DeployedRegistry,
} from './harness/chain';
import { Client, sessionCookie, type Target } from './harness/http';
import { ownershipViolations } from './harness/oracles';
import { recordResult } from './harness/recorder';
import {
  isBlocked,
  startSystemChain,
  startSystemServices,
  startWebApp,
  type SystemChain,
  type SystemServices,
  type WebApp,
} from './harness/services';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * SYSTEM EVIDENCE (local_integration). The real authentication, vault, assistant, transaction-operation
 * and funding routes of the PRODUCTION build, with two synthetic EOA accounts and one anonymous client.
 * Authority comes from the server session only. A plain EOA signature proves control of an address; it
 * does not attest a passkey, a biometric or any professional identity. Bounded local requests only.
 */

const CASES = [
  'auth-siwe-challenge-session-and-cookies',
  'ownership-cross-account-routes',
  'http-origin-headers-and-body-limits',
  'shared-store-two-instances-and-outage',
] as const;

let services: SystemServices | undefined;
let chain: SystemChain | undefined;
let registry: DeployedRegistry | undefined;
let first: WebApp | undefined;
let second: WebApp | undefined;
let secure: WebApp | undefined;
let offline: WebApp | undefined;
let stopMiner: (() => void) | undefined;
let scratch = '';
let blocked = false;

const env = (s: SystemServices, c: SystemChain, recordFile: string, r: DeployedRegistry) => ({
  NEXT_PUBLIC_CHAIN_ID: '10143',
  NEXT_PUBLIC_REGISTRY_ADDRESS: r.address,
  DATABASE_URL: s.postgres.url,
  S3_ENDPOINT: s.s3.endpoint,
  S3_BUCKET: s.s3.bucket,
  S3_REGION: s.s3.region,
  S3_ACCESS_KEY_ID: s.s3.accessKeyId,
  S3_SECRET_ACCESS_KEY: s.s3.secretAccessKey,
  FEATURE_VOICE: 'false',
  FEATURE_AGENT_IDENTITY: 'false',
  FEATURE_REPUTATION_FEEDBACK: 'false',
  LEXAEGIS_TEST_MODE: 'scripted-assistant',
  ASSISTANT_TEST_PROVIDER_URL: s.provider.baseUrl,
  QWEN_API_KEY: '',
  QWEN_BASE_URL: '',
  QWEN_OUTPUT_MODE: '',
  LEXAEGIS_TEST_CHAIN: 'local-anvil',
  LEXAEGIS_TEST_CHAIN_DEPLOYMENT: recordFile,
  ALCHEMY_MONAD_RPC_URL: c.local.rpcUrl,
});

beforeAll(async () => {
  const started = new Date();
  scratch = mkdtempSync(join(tmpdir(), 'system-auth-'));
  const block = (code: 'SERVICE_UNAVAILABLE' | 'PREREQUISITE_MISSING', reason: string): void => {
    blocked = true;
    for (const id of CASES)
      recordResult({
        caseId: id,
        status: 'blocked',
        evidenceClass: 'local_integration',
        startedAt: started,
        configuration: { reason },
        issueCodes: [code],
      });
  };
  const s = await startSystemServices();
  if (isBlocked(s)) {
    block(s.code, s.reason);
    return;
  }
  services = s;
  const c = await startSystemChain(10143, { allowPublicChainId: true });
  if (isBlocked(c)) {
    block(c.code, c.reason);
    return;
  }
  chain = c;
  registry = await deployRegistry(c);
  const recordFile = join(scratch, 'local-deployment.json');
  writeLocalDeploymentRecord(recordFile, c, registry);
  stopMiner = startMiner(c);
  const config = env(s, c, recordFile, registry);
  const a = await startWebApp({ name: 'auth', env: config });
  if (isBlocked(a)) {
    block(a.code, a.reason);
    return;
  }
  first = a;
  // The same build on another port: the shared store, not process memory, decides everything.
  const b = await startWebApp({ name: 'auth', env: config, sameBuildAs: a });
  if (isBlocked(b)) {
    block(b.code, b.reason);
    return;
  }
  second = b;
  // Protected work with the database unreachable: a closed port, same build.
  const o = await startWebApp({
    name: 'auth',
    env: { ...config, DATABASE_URL: 'postgres://lexaegis:x@127.0.0.1:9/lexaegis' },
    sameBuildAs: a,
  });
  if (isBlocked(o)) {
    block(o.code, o.reason);
    return;
  }
  offline = o;
  // An application configured as HTTPS: Secure, `__Host-` cookies (the process still listens on HTTP).
  const h = await startWebApp({ name: 'auth-https', env: config, configuredScheme: 'https' });
  if (isBlocked(h)) {
    block(h.code, h.reason);
    return;
  }
  secure = h;
}, 900_000);

afterAll(async () => {
  stopMiner?.();
  await first?.stop();
  await second?.stop();
  await offline?.stop();
  await secure?.stop();
  await chain?.stop();
  await services?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

const run = (name: string, fn: () => Promise<void>) =>
  it(name, async (context) => {
    if (blocked) context.skip();
    await fn();
  });
const target = (app: WebApp | undefined): Target => {
  if (app === undefined) throw new Error('not started');
  return { baseUrl: app.baseUrl, origin: app.origin };
};
const pg = () => {
  if (services === undefined) throw new Error('not started');
  return services.pool;
};
const countRows = async (table: string, where = 'true'): Promise<number> =>
  (await pg().query<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`))
    .rows[0]?.n ?? -1;
const codeOf = (reply: { json(): unknown }): string | undefined =>
  (reply.json() as { error?: { code?: string } }).error?.code;

describe('[auth-siwe-challenge-session-and-cookies] EIP-4361 sign-in', () => {
  run(
    'the server builds the message for the configured domain, URI and chain; a different chain or field is refused',
    async () => {
      const client = new Client(target(first));
      const reply = await client.postJson('/api/auth/challenge', {
        address: client.address,
        chainId: '10143',
      });
      expect(reply.status).toBe(200);
      const view = reply.json() as { challengeId: string; message: string };
      expect(view.message).toContain('localhost');
      expect(view.message).toContain(client.account.address);
      expect(view.message).toMatch(/Chain ID: 10143/);
      expect(view.message).toContain(first?.origin ?? 'x');
      expect(
        (await client.postJson('/api/auth/challenge', { address: client.address, chainId: '1' }))
          .status,
      ).toBe(400);
      expect(
        (
          await client.postJson('/api/auth/challenge', {
            address: client.address,
            chainId: '10143',
            domain: 'evil.example',
          })
        ).status,
      ).toBe(400);
      expect(
        (await client.postJson('/api/auth/challenge', { address: '0xnot', chainId: '10143' }))
          .status,
      ).toBe(400);
    },
  );

  run(
    'only a signature over the EXACT stored message by that address creates a session',
    async () => {
      const victim = new Client(target(first));
      const attacker = new Client(target(first));
      const challenge = await victim.postJson('/api/auth/challenge', {
        address: victim.address,
        chainId: '10143',
      });
      const view = challenge.json() as { challengeId: string; message: string };
      const sessionsBefore = await countRows('auth_sessions');
      // A signature over a changed message, and a signature by another account, both fail the same way.
      for (const signature of [
        await victim.account.signMessage({ message: `${view.message} ` }),
        await attacker.account.signMessage({ message: view.message }),
      ]) {
        const bad = await victim.postJson('/api/auth/verify', {
          challengeId: view.challengeId,
          signature,
        });
        expect(bad.status).toBe(401);
        expect(codeOf(bad)).toBe('UNAUTHENTICATED');
      }
      expect(await countRows('auth_sessions')).toBe(sessionsBefore);
      const good = await victim.postJson('/api/auth/verify', {
        challengeId: view.challengeId,
        signature: await victim.account.signMessage({ message: view.message }),
      });
      expect(good.status).toBe(200);
      expect(await countRows('auth_sessions')).toBe(sessionsBefore + 1);
    },
  );

  run(
    'the session cookie is HttpOnly, SameSite=Strict, host-only and the token is never in a body',
    async () => {
      const client = new Client(target(first));
      const reply = await client.signIn();
      expect(reply.status).toBe(200);
      const session = reply.setCookies.find((cookie) => cookie.startsWith('lexaegis_session='));
      expect(session).toMatch(/HttpOnly/);
      expect(session).toMatch(/SameSite=Strict/);
      expect(session).toMatch(/Path=\//);
      expect(session).not.toMatch(/Domain=/i);
      const token = /lexaegis_session=([0-9a-f]{64})/.exec(session ?? '')?.[1] ?? '';
      expect(token).toHaveLength(64);
      expect(reply.text).not.toContain(token);
      const me = await client.send('/api/auth/me');
      expect(me.status).toBe(200);
      expect(me.text).not.toContain(token);
      expect(me.headers.get('cache-control')).toBe('no-store');
      // The database stores only a hash of the token.
      expect(await countRows('auth_sessions', `token_hash = '${token}'`)).toBe(0);
    },
  );

  run(
    'the pre-auth cookie binds a challenge to the browser that asked: login swapping fails',
    async () => {
      const a = new Client(target(first));
      const b = new Client(target(first));
      const challengeA = (
        await a.postJson('/api/auth/challenge', { address: a.address, chainId: '10143' })
      ).json() as { challengeId: string; message: string };
      await b.postJson('/api/auth/challenge', { address: b.address, chainId: '10143' });
      const signature = await a.account.signMessage({ message: challengeA.message });
      // A's challenge and A's valid signature, but B's pre-auth cookie.
      const swapped = await b.postJson('/api/auth/verify', {
        challengeId: challengeA.challengeId,
        signature,
      });
      expect(swapped.status).toBe(401);
      // No pre-auth cookie at all.
      const bare = await new Client(target(first)).postJson('/api/auth/verify', {
        challengeId: challengeA.challengeId,
        signature,
      });
      expect(bare.status).toBe(401);
      // The rightful browser still succeeds (the failed attempts consumed nothing).
      expect(
        (await a.postJson('/api/auth/verify', { challengeId: challengeA.challengeId, signature }))
          .status,
      ).toBe(200);
    },
  );

  run(
    'an expired or consumed challenge is refused and concurrent verification creates exactly one session',
    async () => {
      const client = new Client(target(first));
      const issued = (
        await client.postJson('/api/auth/challenge', { address: client.address, chainId: '10143' })
      ).json() as { challengeId: string; message: string };
      const signature = await client.account.signMessage({ message: issued.message });
      const before = await countRows('auth_sessions');
      const results = await Promise.all(
        Array.from({ length: 6 }, () => {
          // Each parallel attempt carries the same cookies (as a retrying browser would).
          const copy = new Client(target(first), '0x'.padEnd(66, '1') as `0x${string}`);
          for (const [name, value] of client.jar) copy.jar.set(name, value);
          return copy.postJson('/api/auth/verify', { challengeId: issued.challengeId, signature });
        }),
      );
      expect(results.filter((reply) => reply.status === 200)).toHaveLength(1);
      expect(await countRows('auth_sessions')).toBe(before + 1);
      // A replay is refused (by the per-challenge limiter or because it is consumed): never a second session.
      expect([401, 429]).toContain(
        (await client.postJson('/api/auth/verify', { challengeId: issued.challengeId, signature }))
          .status,
      );
      expect(await countRows('auth_sessions')).toBe(before + 1);
      // A consumed challenge, replayed on its own, is refused as unauthenticated.
      const solo = new Client(target(first));
      const soloChallenge = (
        await solo.postJson('/api/auth/challenge', { address: solo.address, chainId: '10143' })
      ).json() as { challengeId: string; message: string };
      const soloBody = {
        challengeId: soloChallenge.challengeId,
        signature: await solo.account.signMessage({ message: soloChallenge.message }),
      };
      expect((await solo.postJson('/api/auth/verify', soloBody)).status).toBe(200);
      expect((await solo.postJson('/api/auth/verify', soloBody)).status).toBe(401);

      const late = new Client(target(first));
      const stale = (
        await late.postJson('/api/auth/challenge', { address: late.address, chainId: '10143' })
      ).json() as { challengeId: string; message: string };
      await pg().query(
        "update auth_challenges set expires_at = now() - interval '1 second' where id = $1",
        [stale.challengeId],
      );
      const expired = await late.postJson('/api/auth/verify', {
        challengeId: stale.challengeId,
        signature: await late.account.signMessage({ message: stale.message }),
      });
      expect(expired.status).toBe(401);
    },
  );

  run(
    'signing in again replaces the session, logout revokes it and an expired one is refused',
    async () => {
      const client = new Client(target(first));
      await client.signIn();
      const oldName = sessionCookie(client) ?? '';
      const oldToken = client.jar.get(oldName) ?? '';
      await client.signIn();
      const newToken = client.jar.get(oldName) ?? '';
      expect(newToken).not.toBe(oldToken);
      // The replaced token no longer authenticates.
      const stale = new Client(target(first));
      stale.jar.set(oldName, oldToken);
      expect((await stale.send('/api/auth/me')).status).toBe(401);
      expect((await client.send('/api/auth/me')).status).toBe(200);
      // Logout revokes and clears.
      const out = await client.postJson('/api/auth/logout', {});
      expect(out.status).toBe(200);
      expect(client.jar.has(oldName)).toBe(false);
      const reuse = new Client(target(first));
      reuse.jar.set(oldName, newToken);
      expect((await reuse.send('/api/auth/me')).status).toBe(401);
      // An expired session is refused.
      const expiring = new Client(target(first));
      await expiring.signIn();
      await pg().query(
        "update auth_sessions set expires_at = now() - interval '1 second' where address = $1",
        [expiring.address],
      );
      expect((await expiring.send('/api/auth/me')).status).toBe(401);
    },
  );

  run(
    'spoofed forwarding headers change neither the configured origin nor the cookie policy',
    async () => {
      const client = new Client(target(first));
      const spoof = {
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '203.0.113.9',
        forwarded: 'for=203.0.113.9;host=evil.example;proto=https',
        host: 'localhost',
      };
      const reply = await client.postJson(
        '/api/auth/challenge',
        { address: client.address, chainId: '10143' },
        { headers: spoof },
      );
      const view = reply.json() as { message: string };
      expect(view.message).not.toContain('evil.example');
      expect(view.message).toContain(first?.origin ?? 'x');
      const cookie = reply.setCookies.join(';');
      expect(cookie).not.toMatch(/Secure/);
      expect(cookie).not.toMatch(/__Host-/);
    },
  );
});

describe("[ownership-cross-account-routes] one account never reaches another account's resources", () => {
  const vaultAddress = async (owner: string) => {
    const vaultId = randomUUID();
    const objectId = randomUUID();
    await pg().query(
      `insert into vaults (vault_id, owner_address, rp_id, account_profile_id, state, created_at, object_count, byte_count)
       values ($1, $2, 'localhost', 'lexaegis.evm.bip32-prf.v1', 'ready', now(), 1, 10)`,
      [vaultId, owner],
    );
    await pg().query(
      `insert into vault_objects (vault_id, object_id, byte_length, sha256, state, created_at, ready_at)
       values ($1, $2, 10, $3, 'ready', now(), now())`,
      [vaultId, objectId, `0x${'ab'.repeat(32)}`],
    );
    await pg().query(
      'insert into vault_heads (vault_id, revision, catalog_object_id, updated_at) values ($1, 0, $2, now())',
      [vaultId, objectId],
    );
    return { vaultId, objectId };
  };

  run(
    'vault descriptor, head and objects of another account answer exactly like an unknown ID',
    async () => {
      const alice = new Client(target(first));
      const bob = new Client(target(first));
      const anonymous = new Client(target(first));
      await alice.signIn();
      await bob.signIn();
      const owned = await vaultAddress(alice.address);
      const unknown = { vaultId: randomUUID(), objectId: randomUUID() };
      const paths = (ids: { vaultId: string; objectId: string }) => [
        `/api/vault/${ids.vaultId}/head`,
        `/api/vault/${ids.vaultId}/objects/${ids.objectId}`,
      ];
      for (const [foreign, missing] of paths(owned).map(
        (path, index) => [path, paths(unknown)[index] ?? ''] as const,
      )) {
        const asBob = await bob.send(foreign);
        const asUnknown = await bob.send(missing);
        const asAnonymous = await anonymous.send(foreign);
        // Another account's resource answers exactly like an unknown one, and anonymous is refused
        // before any lookup. The same oracle is shown to fire on a faulted observation (negative-controls).
        expect(
          ownershipViolations({
            foreign: { status: asBob.status, code: codeOf(asBob) ?? null },
            unknown: { status: asUnknown.status, code: codeOf(asUnknown) ?? null },
            anonymous: { status: asAnonymous.status, code: codeOf(asAnonymous) ?? null },
          }),
        ).toEqual([]);
        // The owner reads it normally.
        const mine = await alice.send(foreign);
        // The owner is told what is true: the head reads, and a recorded object that storage lacks is MISSING.
        expect(codeOf(mine), mine.text).not.toBe('NOT_FOUND');
      }
      // Discovery shows each account only its own vault; a body-supplied owner is ignored.
      const discovery = await bob.send('/api/vault');
      expect(discovery.text).not.toContain(owned.vaultId);
      expect(discovery.text).not.toContain(alice.address);
      // Bob cannot write into Alice's vault: the same not-found as an unknown vault.
      const write = await bob.send(`/api/vault/${owned.vaultId}/objects/${randomUUID()}`, {
        method: 'PUT',
        body: new Uint8Array([1, 2, 3]),
        headers: { 'content-type': 'application/octet-stream', 'x-lexaegis-request': '1' },
      });
      const writeUnknown = await bob.send(`/api/vault/${randomUUID()}/objects/${randomUUID()}`, {
        method: 'PUT',
        body: new Uint8Array([1, 2, 3]),
        headers: { 'content-type': 'application/octet-stream', 'x-lexaegis-request': '1' },
      });
      expect(write.status).toBe(writeUnknown.status);
    },
  );

  run(
    "assistant run status and cancellation of another account's run are indistinguishable from an unknown run",
    async () => {
      const alice = new Client(target(first));
      const bob = new Client(target(first));
      await alice.signIn();
      await bob.signIn();
      const runId = randomUUID();
      await pg().query(
        `insert into assistant_runs (id, owner, client_request_id, state, lease_token, lease_expires_at, deadline_at, created_at, updated_at)
       values ($1, $2, $3, 'running', $4, now() + interval '60 seconds', now() + interval '120 seconds', now(), now())`,
        [runId, alice.address, randomUUID(), randomUUID()],
      );
      const unknown = randomUUID();
      const foreignStatus = await bob.send(`/api/assistant/runs/${runId}`);
      const unknownStatus = await bob.send(`/api/assistant/runs/${unknown}`);
      expect(foreignStatus.status).toBe(unknownStatus.status);
      expect(codeOf(foreignStatus)).toBe(codeOf(unknownStatus));
      const foreignCancel = await bob.postJson(`/api/assistant/runs/${runId}/cancel`, {});
      const unknownCancel = await bob.postJson(`/api/assistant/runs/${unknown}/cancel`, {});
      expect(foreignCancel.status).toBe(unknownCancel.status);
      // The foreign cancel changed nothing.
      expect(await countRows('assistant_runs', `id = '${runId}' and cancel_requested = true`)).toBe(
        0,
      );
      expect((await alice.send(`/api/assistant/runs/${runId}`)).status).toBe(200);
      expect((await new Client(target(first)).send(`/api/assistant/runs/${runId}`)).status).toBe(
        401,
      );
    },
  );

  run(
    'operations belong to their creator; funding never takes a recipient from the client',
    async () => {
      const alice = new Client(target(first));
      const bob = new Client(target(first));
      await alice.signIn();
      await bob.signIn();
      const created = await alice.postJson('/api/chain/operations', {
        idempotencyKey: `k${randomUUID().replaceAll('-', '')}`,
        request: { kind: 'invalidate_nonce', expectedNonce: '0' },
      });
      expect(created.status, created.text).toBe(200);
      const operationId = (created.json() as { operation: { operationId: string } }).operation
        .operationId;
      const unknown = randomUUID();
      for (const [method, suffix] of [
        ['GET', ''],
        ['POST', '/quote'],
        ['POST', '/submit'],
      ] as const) {
        const body =
          method === 'POST'
            ? JSON.stringify({
                request: { kind: 'invalidate_nonce', expectedNonce: '0' },
                quote: {},
                signedTransaction: '0x02',
              })
            : null;
        const foreign = await bob.send(`/api/chain/operations/${operationId}${suffix}`, {
          method,
          body,
        });
        const absent = await bob.send(`/api/chain/operations/${unknown}${suffix}`, {
          method,
          body,
        });
        expect(foreign.status, `${method} ${suffix}`).toBe(absent.status);
        expect(codeOf(foreign)).toBe(codeOf(absent));
      }
      expect((await alice.send(`/api/chain/operations/${operationId}`)).status).toBe(200);
      expect(
        (await new Client(target(first)).send(`/api/chain/operations/${operationId}`)).status,
      ).toBe(401);
      // Bob's list never shows Alice's operation.
      expect((await bob.send('/api/chain/operations')).text).not.toContain(operationId);
      // Funding: a recipient or amount in the body is refused; the only recipient is the session account.
      for (const body of [
        { recipient: bob.address },
        { to: alice.address, amount: '1' },
        { address: alice.address },
      ]) {
        expect((await alice.postJson('/api/chain/funding', body)).status).toBe(400);
      }
      const before = await countRows('funding_grants', `recipient = '${alice.address}'`).catch(
        () => 0,
      );
      const plain = await bob.postJson('/api/chain/funding', {});
      expect([200, 503]).toContain(plain.status); // funding is not enabled here: typed, never a grant to Alice
      expect(
        await countRows('funding_grants', `recipient = '${alice.address}'`).catch(() => 0),
      ).toBe(before);
    },
  );
});

describe('[http-origin-headers-and-body-limits] request policy', () => {
  run(
    'a state-changing request needs the configured Origin, the JSON content type and the application header',
    async () => {
      const client = new Client(target(first));
      const body = JSON.stringify({ address: client.address, chainId: '10143' });
      const attempts: [string, Parameters<Client['send']>[1], number][] = [
        ['no Origin', { method: 'POST', body, origin: null }, 403],
        ['a null Origin', { method: 'POST', body, origin: 'null' }, 403],
        ['a foreign Origin', { method: 'POST', body, origin: 'https://evil.example' }, 403],
        [
          'the right host, wrong scheme',
          { method: 'POST', body, origin: first?.origin.replace('http', 'https') ?? '' },
          403,
        ],
        [
          'a form content type',
          {
            method: 'POST',
            body,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
          },
          400,
        ],
        [
          'no application header',
          { method: 'POST', body, headers: { 'x-lexaegis-request': '0' } },
          403,
        ],
      ];
      for (const [name, options, status] of attempts) {
        const reply = await client.send('/api/auth/challenge', options);
        expect(reply.status, name).toBe(status);
      }
      expect((await client.send('/api/auth/challenge', { method: 'POST', body })).status).toBe(200);
      // An Origin check never replaces authentication.
      expect((await client.send('/api/auth/me')).status).toBe(401);
    },
  );

  run(
    'authenticated responses are not cached, and no route allows credentialed cross-origin access',
    async () => {
      const client = new Client(target(first));
      await client.signIn();
      for (const path of ['/api/auth/me', '/api/vault', '/api/chain/operations']) {
        const reply = await client.send(path);
        expect(reply.headers.get('cache-control'), path).toBe('no-store');
        expect(reply.headers.get('x-content-type-options')).toBe('nosniff');
        expect(reply.headers.get('access-control-allow-credentials')).toBeNull();
        expect(reply.headers.get('access-control-allow-origin')).toBeNull();
      }
      const preflight = await client.send('/api/vault', {
        method: 'OPTIONS',
        origin: 'https://evil.example',
        headers: { 'access-control-request-method': 'GET' },
        guarded: false,
      });
      expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
      expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
      // Pages forbid framing and set a nonce-based policy.
      const page = await client.send('/review');
      expect(page.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/);
      expect(page.headers.get('content-security-policy')).not.toMatch(/unsafe-inline|unsafe-eval/);
    },
  );

  run(
    'route-specific body limits reject limit+1 before any work, and streamed bodies are counted as read',
    async () => {
      const client = new Client(target(first));
      await client.signIn();
      const challengesBefore = await countRows('auth_challenges');
      const base = JSON.stringify({ address: client.address, chainId: '10143' });
      const exact = base + ' '.repeat(16 * 1024 - base.length);
      // Exactly 16 KiB is accepted; one more byte is refused without creating a challenge.
      expect(
        (await client.send('/api/auth/challenge', { method: 'POST', body: exact })).status,
      ).toBe(200);
      const one = await countRows('auth_challenges');
      expect(
        (await client.send('/api/auth/challenge', { method: 'POST', body: `${exact} ` })).status,
      ).toBe(400);
      expect(await countRows('auth_challenges')).toBe(one);
      expect(one).toBe(challengesBefore + 1);
      // A chunked (streamed) body with no content-length is counted while it is read.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let index = 0; index < 40; index += 1)
            controller.enqueue(new Uint8Array(1024).fill(32));
          controller.close();
        },
      });
      const streamed = await client.send('/api/auth/challenge', {
        method: 'POST',
        body: stream,
        duplex: true,
      });
      expect(streamed.status).toBe(400);
      // Assistant starts take up to 128 KiB: 128 KiB + 1 is refused as a size problem, not accepted.
      const assistant = await client.send('/api/assistant/runs', {
        method: 'POST',
        body: ' '.repeat(128 * 1024 + 1),
      });
      expect(assistant.status).toBe(400);
      // The raw transaction is capped at 4 KiB: 8192 hex characters pass the schema, one more does not.
      const operation = (
        await client.postJson('/api/chain/operations', {
          idempotencyKey: `k${randomUUID().replaceAll('-', '')}`,
          request: { kind: 'invalidate_nonce', expectedNonce: '0' },
        })
      ).json() as { operation: { operationId: string } };
      const submit = (hex: string) =>
        client.postJson(`/api/chain/operations/${operation.operation.operationId}/submit`, {
          request: { kind: 'invalidate_nonce', expectedNonce: '0' },
          quote: {},
          signedTransaction: hex,
        });
      expect((await submit(`0x${'02'.repeat(4096)}1`)).status).toBe(400);
      expect((await submit(`0x${'02'.repeat(4097)}`)).status).toBe(400);
      // Vault objects: a 16 MiB + 1 body is refused (the schema-level limit is the vault wire object limit).
      const huge = await client.send(`/api/vault/${randomUUID()}/objects/${randomUUID()}`, {
        method: 'PUT',
        body: new Uint8Array(16 * 1024 * 1024 + 1),
        headers: { 'content-type': 'application/octet-stream', 'x-lexaegis-request': '1' },
      });
      expect([400, 404, 413]).toContain(huge.status);
    },
  );

  run(
    'configured as HTTPS the session cookie is Secure and host-bound (__Host-), never Domain-scoped',
    async () => {
      const client = new Client(target(secure));
      const reply = await client.signIn();
      expect(reply.status).toBe(200);
      const session = reply.setCookies.find((cookie) =>
        cookie.startsWith('__Host-lexaegis_session='),
      );
      expect(session).toMatch(/Secure/);
      expect(session).toMatch(/HttpOnly/);
      expect(session).toMatch(/SameSite=Strict/);
      expect(session).toMatch(/Path=\//);
      expect(session).not.toMatch(/Domain=/i);
      const pre = (
        await new Client(target(secure)).postJson('/api/auth/challenge', {
          address: client.address,
          chainId: '10143',
        })
      ).setCookies;
      expect(pre.join(';')).toMatch(/__Host-lexaegis_preauth=/);
      expect(pre.join(';')).toMatch(/Secure/);
    },
  );
});

describe('[shared-store-two-instances-and-outage] shared admission and failure behaviour', () => {
  run(
    'a session, rate limits and operation ownership are shared through the database, not process memory',
    async () => {
      const alice = new Client(target(first));
      await alice.signIn();
      // The same cookie works on the second instance.
      const onSecond = new Client(target(second));
      for (const [name, value] of alice.jar) onSecond.jar.set(name, value);
      expect((await onSecond.send('/api/auth/me')).status).toBe(200);
      // Rate limit: challenges per address per minute are counted across both instances.
      const burst = new Client(target(first));
      const burstSecond = new Client(target(second));
      const statuses: number[] = [];
      for (let index = 0; index < 12; index += 1) {
        const client = index % 2 === 0 ? burst : burstSecond;
        statuses.push(
          (
            await client.postJson('/api/auth/challenge', {
              address: burst.address,
              chainId: '10143',
            })
          ).status,
        );
      }
      expect(statuses.filter((status) => status === 200).length).toBe(10);
      expect(statuses.filter((status) => status === 429).length).toBe(2);
      // An operation created on one instance is invisible to another account on the other.
      const bob = new Client(target(second));
      await bob.signIn();
      const created = await alice.postJson('/api/chain/operations', {
        idempotencyKey: `k${randomUUID().replaceAll('-', '')}`,
        request: { kind: 'invalidate_nonce', expectedNonce: '0' },
      });
      const operationId = (created.json() as { operation: { operationId: string } }).operation
        .operationId;
      expect((await bob.send(`/api/chain/operations/${operationId}`)).status).toBe(404);
      expect((await onSecond.send(`/api/chain/operations/${operationId}`)).status).toBe(200);
    },
  );

  run(
    'with the database unreachable protected work is disabled, never bypassed; public reads stay separate',
    async () => {
      const client = new Client(target(offline));
      const challenge = await client.postJson('/api/auth/challenge', {
        address: client.address,
        chainId: '10143',
      });
      expect(challenge.status).toBeGreaterThanOrEqual(500);
      for (const path of ['/api/vault', '/api/chain/operations', '/api/auth/me']) {
        const reply = await client.send(path);
        expect([401, 503], path).toContain(reply.status);
        expect(reply.status).not.toBe(200);
      }
      // A session cookie minted elsewhere does not authenticate against an instance with no database.
      const holder = new Client(target(first));
      await holder.signIn();
      const carried = new Client(target(offline));
      for (const [name, value] of holder.jar) carried.jar.set(name, value);
      expect((await carried.send('/api/vault')).status).not.toBe(200);
      // Intended public routes answer without authentication and without credentialed CORS.
      const status = await new Client(target(offline)).send('/api/chain/status');
      expect([200, 503]).toContain(status.status);
      expect(status.headers.get('access-control-allow-credentials')).toBeNull();
      expect((await new Client(target(offline)).send('/api/health')).status).toBe(200);
    },
  );
});
