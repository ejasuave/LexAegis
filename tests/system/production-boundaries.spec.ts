import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOSTILE_TEXT } from '../../apps/web/src/test-support/scripted-qwen-server';
import { scanArtifacts } from '../../tooling/src/exclusion';
import { readAssets, scanBrowserAssets, scanServerAssets } from '../../tooling/src/privacy/assets';
import { scanSecrets, scanSecretFiles } from '../../tooling/src/secrets';
import { selectQuote } from './harness/browser';
import { typeToAegis } from './harness/aegis';
import { createAccountAndVault } from './harness/flows';
import { buildVerifier } from './harness/verifier';
import { isBlocked, repository, startWebApp, type WebApp } from './harness/services';
import { startSuite, type Suite } from './harness/suite';

/*
 * SYSTEM EVIDENCE (browser_scripted / local_integration). Production-build boundaries, checked on the
 * PRODUCTION web build that the suite starts with `next build` and `next start`, on a production build
 * of the standalone verifier, and on the response headers the running server actually sends. Nothing
 * here reads a configuration file as proof of a header.
 *
 * Everything is synthetic and loopback: a throwaway database, an S3-compatible server, a scripted
 * provider and an Anvil chain. Canaries are synthetic; no scanner output carries a secret value.
 *
 * LIMITS. A passing scan is not proof the application has no vulnerability, and it cannot say that
 * same-origin JavaScript is unable to reach unlocked material. Deployed edge behaviour (CDN, host
 * header rewriting, TLS, HSTS) is a Chapter 13 check: this is a local `next start`, so Strict-
 * Transport-Security and any host-added header are deliberately not asserted here. The standalone
 * verifier is a static page; its CSP is a <meta> policy, which cannot carry `frame-ancestors`, so
 * framing protection for it has to come from the host (Chapter 13).
 */

const CASES = [
  'prod-bundles-carry-no-server-test-or-private-material',
  'prod-csp-nonce-and-framing-hold-on-the-running-build',
  'prod-headers-no-store-and-no-private-caches',
  'prod-hostile-text-renders-inert',
  'prod-test-seams-inert-and-redirects-refused',
  'prod-dependency-and-committable-secret-scans',
] as const;

let suite: Suite | undefined;
const extraServers: Server[] = [];
const extraApps: WebApp[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'prod-boundaries-'));

beforeAll(async () => {
  const started = await startSuite({ name: 'prod-boundaries', cases: CASES, localChain: true });
  if (isBlocked(started)) return;
  suite = started;
}, 600_000);
afterAll(async () => {
  for (const app of extraApps) await app.stop();
  for (const server of extraServers) {
    server.closeAllConnections();
    server.close();
  }
  await suite?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

const need = (context: { skip: () => never }): Suite => {
  if (suite === undefined) context.skip();
  return suite;
};

const webRoot = join(repository, 'apps', 'web');
const distOf = (s: Suite): string => join(webRoot, s.app.distDir);

/** Names of the server-only variables a browser asset must not even mention. */
function serverEnvNames(): string[] {
  const listed = readFileSync(join(repository, '.env.example'), 'utf8')
    .split('\n')
    .map((line) => /^([A-Z][A-Z0-9_]+)=/.exec(line)?.[1] ?? '')
    .filter((name) => name !== '' && !name.startsWith('NEXT_PUBLIC_') && !name.startsWith('VITE_'));
  return [
    ...listed,
    'ASSISTANT_TEST_PROVIDER_URL',
    'LEXAEGIS_TEST_MODE',
    'LEXAEGIS_TEST_CHAIN',
    'LEXAEGIS_TEST_CHAIN_DEPLOYMENT',
    'ERC8004_OPERATOR_KEY',
    'AGENT_IDENTITY_RPC_URL',
  ];
}

/** A flag or marker that would mean an authentication bypass or a simulated success shipped. */
const BYPASS_OR_MOCK =
  /(?:SKIP|DISABLE|BYPASS)_AUTH|x-test-account|dev[-_]?login|mockSuccess|MOCK_SUCCESS|simulateSuccess|SIMULATE_SUCCESS|fakeConfirm|FAKE_CONFIRM|forceConfirmed/i;

let verifierBuilt: string | undefined;
/** The standalone verifier, built once in production mode with synthetic non-secret configuration. */
function verifierDist(): string {
  if (verifierBuilt !== undefined) return verifierBuilt;
  const out = join(scratch, 'verifier-dist');
  buildVerifier(out, 'production', {
    VITE_RPC_URL: 'https://rpc.example.invalid/',
    VITE_RPC_ALLOWED_ORIGINS: 'https://rpc.example.invalid',
  });
  verifierBuilt = out;
  return out;
}

const registryKey = (): string =>
  (
    JSON.parse(readFileSync(join(repository, 'fixtures/registry-v1/vectors.json'), 'utf8')) as {
      signer: { privateKey: string };
    }
  ).signer.privateKey;

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    // Regular files only: a symbolic link is neither followed nor read.
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly text: string;
}

async function get(
  s: { readonly baseUrl: string },
  path: string,
  init: RequestInit = {},
): Promise<Reply> {
  const response = await fetch(`${s.baseUrl}${path}`, { redirect: 'manual', ...init });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    text: await response.text(),
  };
}

/** A loopback server that records every request it receives. A hit means something reached it. */
async function recordingServer(
  respond?: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ origin: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(`${request.method ?? ''} ${request.url ?? ''}`);
    if (respond !== undefined) respond(request, response);
    else response.writeHead(200, { 'content-type': 'text/plain' }).end('canary');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  extraServers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { origin: `http://127.0.0.1:${String(address.port)}`, hits };
}

const directives = (policy: string): Map<string, string[]> =>
  new Map(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((parts) => parts[0] !== '')
      .map(([name, ...values]) => [name ?? '', values]),
  );

const PAGES = ['/vault', '/review', '/history', '/verify'] as const;

describe('[prod-bundles-carry-no-server-test-or-private-material] what the production builds emit', () => {
  it('the web build: no server variable name, test material, bypass or mock flag, private fixture or source map reaches a browser', async (context) => {
    const s = need(context);
    const dist = distOf(s);
    const clientRoot = join(dist, 'static');
    const client = readAssets(clientRoot, ['.js', '.css', '.html', '.json', '.map', '.txt']);
    expect(client.length).toBeGreaterThan(5);

    const scanned = scanBrowserAssets(client, {
      serverEnvNames: serverEnvNames(),
      canaries: [
        {
          id: 'storage-secret',
          class: 'storage_credential',
          kind: 'text',
          value: s.services.s3.secretAccessKey,
        },
        {
          id: 'storage-access-key',
          class: 'storage_credential',
          kind: 'text',
          value: s.services.s3.accessKeyId,
        },
        {
          id: 'provider-placeholder',
          class: 'provider_credential',
          kind: 'text',
          value: 'scripted-test-no-key',
        },
      ],
      privateFixtureMarkers: [
        'discrepancy-2000.pdf',
        'Northwind Demo Ltd',
        'SYNTHETIC SETTLEMENT AGREEMENT',
      ],
      publicSources: [],
    });
    // Public 64-hex constants (curve parameters, type hashes) need a named public source to be
    // classified. That classification belongs to `pnpm test:privacy:browser`; here every OTHER rule
    // must be silent, and the number of unclassified candidates is not hidden.
    const unclassified = scanned.findings.filter((f) => f.rule === 'UNCLASSIFIED_KEY_SHAPED');
    expect(scanned.findings.filter((f) => f.rule !== 'UNCLASSIFIED_KEY_SHAPED')).toEqual([]);
    expect(unclassified.length).toBeLessThan(40);

    // A source map would expose the original source. The build emits empty stubs: none lists a source.
    for (const file of client.filter((item) => item.name.endsWith('.map'))) {
      const map = JSON.parse(file.text) as { sources?: unknown[]; sourcesContent?: unknown };
      expect(map.sources ?? [], file.name).toEqual([]);
      expect(map.sourcesContent, file.name).toBeUndefined();
    }
    expect(
      client.filter((file) => BYPASS_OR_MOCK.test(file.text)).map((file) => file.name),
    ).toEqual([]);
    // The server bundle too: no test adapter, no test signer, no known development key, no registry key.
    expect(
      scanArtifacts([clientRoot, join(dist, 'server')], { extraSecrets: [registryKey()] }),
    ).toEqual([]);

    // What the running server serves agrees with what is on disk: no source map is reachable.
    const chunk = client.find(
      (file) => file.name.startsWith('chunks/') && file.name.endsWith('.js'),
    );
    expect(chunk).toBeDefined();
    const map = await get(s.app, `/_next/static/${chunk?.name ?? ''}.map`);
    expect(map.status).toBe(404);
  });

  it('the standalone verifier build: no server variable, test material or source map, and a CSP that allows only itself and the listed registry endpoints', () => {
    const out = verifierDist();
    const assets = readAssets(out, ['.js', '.css', '.html', '.json', '.map']);
    expect(assets.length).toBeGreaterThan(2);
    const scanned = scanBrowserAssets(assets, {
      serverEnvNames: serverEnvNames(),
      canaries: [],
      privateFixtureMarkers: ['discrepancy-2000.pdf', 'Northwind Demo Ltd'],
      publicSources: [],
    });
    expect(scanned.findings.filter((f) => f.rule !== 'UNCLASSIFIED_KEY_SHAPED')).toEqual([]);
    expect(assets.filter((file) => file.name.endsWith('.map'))).toEqual([]);
    expect(
      assets.filter((file) => BYPASS_OR_MOCK.test(file.text)).map((file) => file.name),
    ).toEqual([]);
    expect(scanArtifacts([out], { extraSecrets: [registryKey()] })).toEqual([]);

    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/
      .exec(html)?.[1]
      ?.replaceAll('&#39;', "'")
      .replaceAll('&apos;', "'")
      .replaceAll('&amp;', '&');
    expect(policy).toBeDefined();
    const parsed = directives(policy ?? '');
    expect(parsed.get('default-src')).toEqual(["'none'"]);
    expect(parsed.get('script-src')).toEqual(["'self'"]);
    expect(parsed.get('connect-src')).toEqual(["'self'", 'https://rpc.example.invalid']);
    expect(parsed.get('object-src')).toEqual(["'none'"]);
    expect(parsed.get('base-uri')).toEqual(["'none'"]);
    expect(parsed.get('form-action')).toEqual(["'none'"]);
    expect(policy).not.toMatch(/unsafe-|\*|https?:(?!\/\/rpc\.example\.invalid)/);
    // No inline script or handler: the policy has no 'unsafe-inline' to rely on.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[^<]/);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });
});

describe('[prod-csp-nonce-and-framing-hold-on-the-running-build] the policy the production server sends, and what the browser enforces', () => {
  it('every page carries a strict nonce policy with a fresh nonce per request, and every script and style tag carries it', async (context) => {
    const s = need(context);
    const nonces = new Set<string>();
    for (const path of PAGES) {
      for (let round = 0; round < 2; round += 1) {
        const page = await get(s.app, path);
        expect(page.status).toBe(200);
        const policy = page.headers['content-security-policy'] ?? '';
        const parsed = directives(policy);
        const nonce = /'nonce-([^']+)'/.exec(parsed.get('script-src')?.join(' ') ?? '')?.[1];
        expect(nonce, `${path} nonce`).toBeDefined();
        nonces.add(nonce ?? '');
        const script = parsed.get('script-src') ?? [];
        expect(script).toContain("'self'");
        expect(script).toContain("'strict-dynamic'");
        expect(script.join(' ')).not.toMatch(/unsafe-|\*|https?:|data:|blob:/);
        expect(parsed.get('style-src')?.join(' ')).toBe(`'self' 'nonce-${nonce ?? ''}'`);
        expect(parsed.get('default-src')).toEqual(["'self'"]);
        expect(parsed.get('connect-src')).toEqual(["'self'"]);
        expect(parsed.get('worker-src')).toEqual(["'self'"]);
        expect(parsed.get('object-src')).toEqual(["'none'"]);
        expect(parsed.get('frame-src')).toEqual(["'none'"]);
        expect(parsed.get('frame-ancestors')).toEqual(["'none'"]);
        expect(parsed.get('base-uri')).toEqual(["'self'"]);
        expect(parsed.get('form-action')).toEqual(["'self'"]);
        expect(policy).not.toMatch(/unsafe-eval|unsafe-inline|unsafe-hashes/);

        // Every script and style element in the HTML carries this request's nonce.
        const scripts = [...page.text.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1] ?? '');
        expect(scripts.length).toBeGreaterThan(0);
        for (const attributes of scripts)
          expect(attributes, `${path} script`).toContain(`nonce="${nonce ?? ''}"`);
        for (const [, attributes] of page.text.matchAll(/<style\b([^>]*)>/g))
          expect(attributes ?? '', `${path} style`).toContain(`nonce="${nonce ?? ''}"`);
        expect(page.text).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
        expect(page.text).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
      }
    }
    expect(nonces.size).toBe(PAGES.length * 2);
  });

  it('the browser enforces it: legitimate account, vault and PDF-worker features raise no violation, and every probe is blocked and recorded', async (context) => {
    const s = need(context);
    const canary = await recordingServer();
    const { page } = await s.newSession();
    await page.addInitScript(() => {
      const w = window as unknown as {
        __csp: { d: string; b: string; f: string; s: string }[];
        __ran?: number;
      };
      w.__csp = [];
      document.addEventListener(
        'securitypolicyviolation',
        (event) =>
          w.__csp.push({
            d: event.effectiveDirective,
            b: event.blockedURI.slice(0, 80),
            f: `${event.sourceFile.slice(-60)}:${String(event.lineNumber)}:${String(event.columnNumber)}`,
            s: event.sample,
          }),
        true,
      );
    });
    try {
      // Legitimate features first: passkey account, vault, encrypted save, PDF text extraction in a worker.
      await createAccountAndVault(page, s.app.origin);
      await page.getByLabel('New matter title').fill('SYSTEM-prod-csp-matter-1f40');
      await page.getByRole('button', { name: 'Create matter' }).click();
      await page.getByRole('link', { name: 'Review', exact: true }).click();
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await page
        .getByTestId('pdf-input')
        .setInputFiles(
          join(repository, 'fixtures', 'documents-v1', 'pdfs', 'discrepancy-2000.pdf'),
        );
      await page
        .getByText(/discrepancy-2000\.pdf: saved encrypted/)
        .first()
        .waitFor({ timeout: 40_000 });
      const early = await page.evaluate(() => (window as unknown as { __csp: unknown[] }).__csp);
      expect(early, 'the application itself raised a CSP violation').toEqual([]);

      const result = await page.evaluate(async (target) => {
        const w = window as unknown as { __ran?: number };
        const out: Record<string, string> = {};
        // 1. An inline event-handler attribute (created through innerHTML).
        const holder = document.createElement('div');
        holder.innerHTML = '<img src="x:" onerror="window.__ran = 3">';
        document.body.append(holder);
        // 2. A cross-origin fetch, a remote image, an object, a form post and a base element.
        out.fetch = await fetch(`${target}/fetch`).then(
          () => 'reached',
          () => 'blocked',
        );
        new Image().src = `${target}/image.png`;
        const object = document.createElement('object');
        object.data = `${target}/object`;
        document.body.append(object);
        const form = document.createElement('form');
        form.action = `${target}/form`;
        form.method = 'post';
        document.body.append(form);
        try {
          form.submit();
        } catch {
          // blocked is the expected outcome
        }
        const base = document.createElement('base');
        base.href = `${target}/base/`;
        document.head.append(base);
        // 3. A worker from a blob: and one from a data: URL.
        try {
          const worker = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'])));
          out.blobWorker = await new Promise<string>((resolve) => {
            worker.onmessage = () => resolve('ran');
            worker.onerror = () => resolve('blocked');
            setTimeout(() => resolve('blocked'), 1_500);
          });
        } catch (error) {
          out.blobWorker = (error as Error).name;
        }
        await new Promise((resolve) => setTimeout(resolve, 600));
        out.ran = String(w.__ran ?? 'none');
        return out;
      }, canary.origin);

      expect(result.ran).toBe('none');
      expect(result.fetch).toBe('blocked');
      expect(result.blobWorker).toBe('blocked');
      const violations = await page.evaluate(
        () =>
          (window as unknown as { __csp: { d: string; b: string; f: string; s: string }[] }).__csp,
      );
      const seen = new Set(violations.map((violation) => violation.d));
      for (const directive of [
        'script-src-attr',
        'connect-src',
        'img-src',
        'object-src',
        'form-action',
        'base-uri',
        'worker-src',
      ])
        expect(seen, `no ${directive} violation was recorded`).toContain(directive);
      // Nothing reached the canary server: the browser refused before connecting.
      expect(canary.hits).toEqual([]);

      // Injected markup: an unnonced inline <script> and an inline handler arriving in the server's
      // own HTML (the shape of a stored or reflected injection). The server's policy header is kept.
      const injected = await page.context().newPage();
      await injected.addInitScript(() => {
        const w = window as unknown as { __csp: string[] };
        w.__csp = [];
        document.addEventListener(
          'securitypolicyviolation',
          (event) => w.__csp.push(event.effectiveDirective),
          true,
        );
      });
      await injected.route(`${s.app.baseUrl}/verify`, async (route) => {
        const original = await route.fetch();
        const nonce = /'nonce-([^']+)'/.exec(
          original.headers()['content-security-policy'] ?? '',
        )?.[1];
        // The last script carries the page's own nonce, so only the policy (no 'unsafe-eval') stands
        // between it and string-to-code evaluation.
        const probe =
          "try { window.__eval = String(eval('1+1')); } catch (e) { window.__eval = e.name; }" +
          "try { window.__func = String(new Function('return 2')()); } catch (e) { window.__func = e.name; }";
        const body = (await original.text()).replace(
          '</body>',
          `<script>window.__ran = 1</script><img src="x:" onerror="window.__ran = 3"><script nonce="${nonce ?? ''}">${probe}</script></body>`,
        );
        await route.fulfill({ response: original, body });
      });
      await injected.goto(`${s.app.baseUrl}/verify`);
      await injected.waitForTimeout(1_000);
      expect(await injected.evaluate(() => String((window as { __ran?: number }).__ran))).toBe(
        'undefined',
      );
      const injectedSeen = new Set(
        await injected.evaluate(() => (window as unknown as { __csp: string[] }).__csp),
      );
      expect(
        await injected.evaluate(() => {
          const w = window as unknown as { __eval?: string; __func?: string };
          return `${w.__eval ?? 'unset'}/${w.__func ?? 'unset'}`;
        }),
      ).toBe('EvalError/EvalError');
      expect(injectedSeen).toContain('script-src-elem');
      expect(injectedSeen).toContain('script-src-attr');
      expect(injectedSeen).toContain('script-src');
    } finally {
      await page.context().close();
    }
  });

  it('another origin cannot frame or embed the application', async (context) => {
    const s = need(context);
    const target = `${s.app.baseUrl}/vault`;
    const host = await recordingServer((_request, response) => {
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<!doctype html><title>host</title><iframe name="f" src="${target}"></iframe><object name="o" data="${target}" type="text/html"></object><embed name="e" src="${target}" type="text/html">`,
        );
    });
    const { page } = await s.newSession({ authenticator: false });
    const messages: string[] = [];
    page.on('console', (message) => messages.push(message.text()));
    try {
      await page.goto(host.origin);
      await page.waitForTimeout(2_500);
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        const text = await frame
          .locator('body')
          .innerText({ timeout: 3_000 })
          .catch(() => '');
        expect(text, `a frame rendered the application (${frame.url()})`).not.toMatch(
          /Create account and sign in|Lock vault|Vault/,
        );
      }
      expect(messages.join('\n')).toMatch(
        /frame-ancestors|X-Frame-Options|Refused to (?:display|frame)/,
      );
    } finally {
      await page.context().close();
    }
  });
});

describe('[prod-headers-no-store-and-no-private-caches] response headers from the running production server', () => {
  const API_GET = [
    '/api/health',
    '/api/readiness',
    '/api/agent-card',
    '/api/agent-identity',
    '/api/auth/me',
    '/api/vault',
    '/api/history/status',
    '/api/chain/status',
    '/api/chain/account',
    '/api/chain/operations',
  ] as const;

  const commonHeaders = (reply: Reply, path: string): void => {
    expect(reply.headers['referrer-policy'], `${path} referrer-policy`).toBe('no-referrer');
    expect(reply.headers['x-content-type-options'], `${path} nosniff`).toBe('nosniff');
    expect(reply.headers['x-frame-options'], `${path} x-frame-options`).toBe('DENY');
    expect(reply.headers['permissions-policy'], `${path} permissions-policy`).toBe(
      'publickey-credentials-get=(self), publickey-credentials-create=(self), camera=(), microphone=(self), geolocation=(), payment=()',
    );
    expect(reply.headers['x-powered-by'], `${path} x-powered-by`).toBeUndefined();
    expect(
      Object.keys(reply.headers).filter((name) => name.startsWith('access-control-')),
      `${path} CORS grant`,
    ).toEqual([]);
  };

  it('pages and API responses, signed out and signed in, are never stored and never granted cross-origin', async (context) => {
    const s = need(context);
    const { page, context: browserContext } = await s.newSession();
    try {
      await createAccountAndVault(page, s.app.origin);
      const asUser = async (path: string): Promise<Reply> => {
        const response = await browserContext.request.get(`${s.app.baseUrl}${path}`, {
          maxRedirects: 0,
        });
        return {
          status: response.status(),
          headers: response.headers(),
          text: await response.text(),
        };
      };
      const signedOutProtected = new Set([
        '/api/auth/me',
        '/api/vault',
        '/api/chain/account',
        '/api/chain/operations',
      ]);
      for (const path of [...PAGES, '/', '/nope', ...API_GET]) {
        for (const [who, reply] of [
          ['signed out', await get(s.app, path, { headers: { origin: 'https://evil.example' } })],
          ['signed in', await asUser(path)],
        ] as const) {
          commonHeaders(reply, `${who} ${path}`);
          expect(reply.status, `${who} ${path}`).toBeLessThan(600);
          expect(reply.headers['cache-control'], `${who} ${path} cache-control`).toMatch(
            /no-store/,
          );
          if (who === 'signed out' && signedOutProtected.has(path))
            expect(reply.status, `${who} ${path}`).toBe(401);
          if (path.startsWith('/api/')) {
            expect(reply.headers['content-type'], path).toMatch(/application\/json/);
            expect(reply.headers['set-cookie'] ?? '', `${who} ${path} set-cookie`).not.toMatch(
              /\S/,
            );
          }
        }
      }
      // A method the route does not export is a bare 405 with no body: it holds no data. It does not
      // get a Cache-Control from the framework, so it is checked for what it can carry instead.
      const wrongMethod = await get(s.app, '/api/assistant/runs');
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.text).toBe('');
      commonHeaders(wrongMethod, 'GET /api/assistant/runs');

      // A cross-origin preflight is not granted, and a foreign-origin mutation with a valid session
      // cookie is refused without ending the session.
      const preflight = await get(s.app, '/api/vault', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      });
      expect(
        Object.keys(preflight.headers).filter((name) => name.startsWith('access-control-')),
      ).toEqual([]);
      const foreign = await browserContext.request.post(`${s.app.baseUrl}/api/auth/logout`, {
        headers: { origin: 'https://evil.example' },
        data: {},
      });
      expect(foreign.status()).toBe(403);
      expect((await asUser('/api/auth/me')).status).toBe(200);
    } finally {
      await browserContext.close();
    }
  });

  it('no service worker, no Cache Storage and no stored private HTML: a titled matter never reaches a page body or the build output', async (context) => {
    const s = need(context);
    const title = 'SYSTEM-prod-private-title-5c92';
    const { page, context: browserContext } = await s.newSession();
    try {
      await createAccountAndVault(page, s.app.origin);
      await page.getByLabel('New matter title').fill(title);
      await page.getByRole('button', { name: 'Create matter' }).click();
      await page
        .getByRole('button', { name: new RegExp(title) })
        .first()
        .waitFor({ timeout: 15_000 });
      for (const path of ['/', ...PAGES]) {
        const response = await browserContext.request.get(`${s.app.baseUrl}${path}`);
        expect(await response.text(), `${path} body`).not.toContain(title);
        expect(response.headers()['x-nextjs-cache'] ?? '', `${path} ISR cache`).not.toMatch(
          /HIT|STALE/,
        );
      }
      const state = await page.evaluate(async () => ({
        workers: (await navigator.serviceWorker.getRegistrations()).length,
        caches: await caches.keys(),
        controller: navigator.serviceWorker.controller === null,
      }));
      expect(state).toEqual({ workers: 0, caches: [], controller: true });
      for (const path of ['/sw.js', '/service-worker.js', '/manifest.webmanifest'])
        expect((await get(s.app, path)).status, path).toBe(404);

      // Prerendered output, the data cache and the image cache hold nothing the user typed.
      const holders = files(distOf(s))
        .filter((file) => statSync(file).size < 20 * 1024 * 1024)
        .filter((file) => readFileSync(file, 'utf8').includes(title))
        .map((file) => relative(distOf(s), file).split(sep).join('/'));
      expect(holders).toEqual([]);
    } finally {
      await browserContext.close();
    }
  });
});

/** A one-page text PDF, written from the specification, whose text is the given lines. */
function textPdf(lines: readonly string[]): Buffer {
  const escape = (text: string): string =>
    text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const content = `BT /F1 11 Tf 40 740 Td 15 TL ${lines.map((line) => `(${escape(line)}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(Buffer.byteLength(content, 'latin1'))} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const HOSTILE_TITLE = '<img src=x onerror="window.__xss=11"> matter';
const HOSTILE_FILENAME = '<img src=x onerror="window.__xss=21">.pdf';
const HOSTILE_LINES = [
  'HOSTILE-DOC Total settlement payment: GBP 24,000',
  '<img src=x onerror="window.__xss=31"> <script>window.__xss=32</script>',
  '[open](javascript:window.__xss=33) javascript:window.__xss=34 data:text/html,<b>x</b>',
  '<iframe src="https://example.invalid/"></iframe> **not bold** <a href="https://example.invalid">x</a>',
];

/** What the DOM must never contain as a result of untrusted text. */
async function domInertness(page: Page): Promise<{
  xss: unknown;
  injected: string[];
  unsafeLinks: string[];
  violations: unknown[];
}> {
  return page.evaluate(() => {
    const w = window as unknown as { __xss?: unknown; __csp?: unknown[] };
    const injected = [
      ...document.querySelectorAll('img[src="x"], iframe, object, embed, script:not([src]), base'),
    ]
      .filter((element) => !element.hasAttribute('nonce') || element.tagName !== 'SCRIPT')
      .map((element) => element.tagName.toLowerCase());
    const unsafeLinks = [...document.querySelectorAll('a[href], area[href], form[action]')]
      .map((element) => element.getAttribute('href') ?? element.getAttribute('action') ?? '')
      .filter((value) => /^\s*(?:javascript|data|vbscript):/i.test(value));
    return { xss: w.__xss, injected, unsafeLinks, violations: w.__csp ?? [] };
  });
}

describe('[prod-hostile-text-renders-inert] untrusted text is shown as text', () => {
  it('a hostile matter title, file name, extracted document text and model answer execute nothing, create no element, link or request, and still read as text', async (context) => {
    const s = need(context);
    const requests: string[] = [];
    const { page } = await s.newSession();
    page.on('request', (request) => requests.push(request.url()));
    await page.addInitScript(() => {
      const w = window as unknown as { __csp: unknown[] };
      w.__csp = [];
      document.addEventListener(
        'securitypolicyviolation',
        (event) => w.__csp.push(event.effectiveDirective),
        true,
      );
    });
    try {
      const account = await createAccountAndVault(page, s.app.origin);
      expect(account.address).toMatch(/^0x/);
      await page.getByLabel('New matter title').fill(HOSTILE_TITLE);
      await page.getByRole('button', { name: 'Create matter' }).click();
      await page.getByText(HOSTILE_TITLE).first().waitFor({ timeout: 15_000 });
      expect(await page.locator('body').innerText()).toContain(
        '<img src=x onerror="window.__xss=11">',
      );

      await page.getByRole('link', { name: 'Review', exact: true }).click();
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await page.getByTestId('pdf-input').setInputFiles({
        name: HOSTILE_FILENAME,
        mimeType: 'application/pdf',
        buffer: textPdf(HOSTILE_LINES),
      });
      await page
        .getByText(/saved encrypted/)
        .first()
        .waitFor({ timeout: 40_000 });
      const shown = await page.locator('body').innerText();
      expect(shown).toContain('<img src=x onerror="window.__xss=21">.pdf');
      expect(shown).toContain('<script>window.__xss=32</script>');
      expect(shown).toContain('javascript:window.__xss=34');
      expect(shown).toContain('**not bold**');

      // Model output: the scripted provider returns hostile prose inside an otherwise valid, cited answer.
      expect(await selectQuote(page, '24,000')).toBe(true);
      await typeToAegis(page, 'HOSTILE-TEST explain this clause');
      await page.getByTestId('disclosure-preview').waitFor({ timeout: 15_000 });
      await page.getByTestId('disclosure-send').click();
      await expect
        .poll(
          () =>
            page
              .getByTestId('assistant-run')
              .last()
              .getAttribute('data-state')
              .catch(() => null),
          {
            timeout: 40_000,
          },
        )
        .toBe('completed');
      const answer = await page.getByTestId('assistant-run').last().innerText();
      expect(answer).toContain('<script>window.__xss=2</script>');
      expect(answer).toContain('javascript:window.__xss=3');
      expect(answer).toContain('**bold**');
      expect(answer).toContain('# heading');

      const inert = await domInertness(page);
      expect(inert.xss).toBeUndefined();
      expect(inert.injected).toEqual([]);
      expect(inert.unsafeLinks).toEqual([]);
      // Inert means never attempted: the policy was not even asked to block anything.
      expect(inert.violations).toEqual([]);
      expect(requests.filter((url) => /example\.invalid|[?&]x=|\/x$/.test(url))).toEqual([]);
      expect(HOSTILE_TEXT.length).toBeLessThan(300);
    } finally {
      await page.context().close();
    }
  });

  it('request bodies and path parameters cannot choose a fetch target, and a hostile one is refused before any request leaves', async (context) => {
    const s = need(context);
    const canary = await recordingServer();
    const { page, context: browserContext } = await s.newSession();
    try {
      await createAccountAndVault(page, s.app.origin);
      const headers = { origin: s.app.origin, 'content-type': 'application/json' };
      const post = (path: string, data: unknown) =>
        browserContext.request.post(`${s.app.baseUrl}${path}`, { headers, data });
      for (const [path, data] of [
        [
          '/api/assistant/runs',
          { baseUrl: canary.origin, url: `${canary.origin}/x`, model: 'x', message: 'hi' },
        ],
        ['/api/chain/funding', { rpcUrl: canary.origin }],
        ['/api/chain/operations', { endpoint: canary.origin, rpcUrl: canary.origin }],
      ] as const) {
        const response = await post(path, data);
        expect(response.status(), path).toBeGreaterThanOrEqual(400);
        expect(response.status(), path).toBeLessThan(500);
      }
      for (const parameter of [
        encodeURIComponent(`${canary.origin}/`),
        encodeURIComponent('../../etc/passwd'),
        '0xZZ',
      ]) {
        for (const path of [
          `/api/history/receipts/${parameter}/${parameter}`,
          `/api/chain/state/${parameter}/${parameter}`,
          `/api/chain/receipts/${parameter}/${parameter}`,
          `/api/history/reviewers/${parameter}`,
        ]) {
          const response = await browserContext.request.get(`${s.app.baseUrl}${path}`);
          expect(response.status(), path).toBeGreaterThanOrEqual(400);
          expect(response.status(), path).toBeLessThan(500);
        }
      }
      // Give any stray server-side fetch time to arrive; none should have been made.
      await page.waitForTimeout(1_000);
      expect(canary.hits).toEqual([]);
    } finally {
      await browserContext.close();
    }
  });
});

describe('[prod-test-seams-inert-and-redirects-refused] a deployed process has no test seam, and an endpoint cannot be redirected', () => {
  it('the same build started without the test environment has no scripted provider and no local chain, and reports the typed state instead', async (context) => {
    const s = need(context);
    const bare = await startWebApp({
      name: 'prod-boundaries-bare',
      sameBuildAs: s.app,
      env: {
        ...s.appEnv,
        LEXAEGIS_TEST_MODE: '',
        ASSISTANT_TEST_PROVIDER_URL: '',
        LEXAEGIS_TEST_CHAIN: '',
        LEXAEGIS_TEST_CHAIN_DEPLOYMENT: '',
        ALCHEMY_MONAD_RPC_URL: '',
        QWEN_API_KEY: '',
      },
    });
    if (isBlocked(bare)) throw new Error('the unconfigured process did not start');
    extraApps.push(bare);
    const before = s.services.provider.requests.length;
    const { page, context: browserContext } = await s.newSession();
    try {
      await createAccountAndVault(page, s.app.origin);
      const readiness = await get(bare, '/api/readiness');
      const status = await get(bare, '/api/chain/status');
      const both = `${readiness.text}\n${status.text}`;
      // Neither the scripted provider's label nor the local registry nor a success appears.
      expect(both).not.toMatch(/scripted-test|scripted-assistant/i);
      if (s.registry !== null)
        expect(both.toLowerCase()).not.toContain(s.registry.address.toLowerCase());
      expect(readiness.status).toBe(503);
      expect(readiness.headers['cache-control']).toMatch(/no-store/);
      // The registry it reports is the committed public artifact, and it says so: not configured.
      expect((JSON.parse(status.text) as { status: string }).status).toBe('not_configured');
      // Starting a run on the bare process is a typed refusal, never a scripted answer.
      const run = await browserContext.request.post(`${bare.baseUrl}/api/assistant/runs`, {
        headers: { origin: s.app.origin, 'content-type': 'application/json' },
        data: { message: 'hello' },
      });
      expect(run.status()).toBeGreaterThanOrEqual(400);
      expect(await run.text()).not.toMatch(/scripted|completed/i);
      expect(s.services.provider.requests.length).toBe(before);
    } finally {
      await browserContext.close();
    }
  });

  it('a chain endpoint that answers with a redirect is not followed', async (context) => {
    const s = need(context);
    if (s.chain === null) throw new Error('chain');
    const target = await recordingServer();
    const redirector = await recordingServer((_request, response) => {
      response.writeHead(307, { location: `${target.origin}/rpc` }).end();
    });
    const redirected = await startWebApp({
      name: 'prod-boundaries-redirect',
      sameBuildAs: s.app,
      env: { ...s.appEnv, ALCHEMY_MONAD_RPC_URL: redirector.origin },
    });
    if (isBlocked(redirected)) throw new Error('the redirect process did not start');
    extraApps.push(redirected);
    const { page, context: browserContext } = await s.newSession();
    try {
      await createAccountAndVault(page, s.app.origin);
      const response = await browserContext.request.get(`${redirected.baseUrl}/api/chain/status`);
      expect(response.status()).toBeLessThan(600);
      const text = await response.text();
      // A failed read is `unknown` with a typed reason, never a status read from the redirect target.
      expect(JSON.parse(text)).toMatchObject({ status: 'unknown', reason: 'RPC_UNAVAILABLE' });
      // The redirector was asked (the application did try its configured endpoint)...
      expect(redirector.hits.length).toBeGreaterThan(0);
      // ...and nothing it redirected to was ever contacted.
      expect(target.hits).toEqual([]);
    } finally {
      await browserContext.close();
    }
  });
});

describe('[prod-dependency-and-committable-secret-scans] advisories, and secrets in what could be committed', () => {
  it('pnpm audit reports no known vulnerability in production dependencies (an unreachable registry is blocked, never clean)', (context) => {
    const run = spawnSync('pnpm', ['audit', '--prod', '--json'], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 120_000,
    });
    interface AuditReport {
      readonly advisories?: Record<string, unknown>;
      readonly metadata?: unknown;
    }
    const parse = (text: string): AuditReport | null => {
      try {
        return JSON.parse(text) as AuditReport;
      } catch {
        return null;
      }
    };
    const report = parse(run.stdout);
    // No parseable audit means the registry or network is unavailable: that is not zero vulnerabilities.
    if (report?.metadata === undefined) return context.skip();
    expect(Object.keys(report.advisories ?? {})).toEqual([]);
  });

  it('no committable file holds a credential shape, and the scanner is not vacuous', () => {
    const listed = spawnSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        cwd: repository,
        encoding: 'utf8',
      },
    );
    expect(listed.status).toBe(0);
    const names = listed.stdout.split('\0').filter((name) => name !== '');
    expect(names.length).toBeGreaterThan(500);
    expect(scanSecretFiles(repository, names)).toEqual([]);

    // Negative control: the same scanner finds a planted synthetic key, a private-key block and a
    // credential-bearing URL.
    const planted = join(scratch, 'planted');
    const sample = join(planted, 'sample.txt');
    spawnSync('mkdir', ['-p', planted]);
    writeFileSync(
      sample,
      [
        // Assembled here so this file holds no literal of its own that the scanner would flag.
        ['api', '_key = "', 'ab'.repeat(32), '"'].join(''),
        ['-----', 'BEGIN', ' PRIVATE ', 'KEY', '-----'].join(''),
        ['postgres:', '//', 'user:pass@db.example.invalid/x'].join(''),
      ].join('\n'),
    );
    expect(
      scanSecrets(planted, {})
        .map((finding) => finding.rule)
        .sort(),
    ).toEqual(['KEY_ASSIGNMENT', 'PRIVATE_KEY_BLOCK', 'URL_CREDENTIALS'].sort());
  });

  it('the build outputs of both applications hold no credential shape (by shape, not by the source scanner, which misreads minified code)', (context) => {
    const s = need(context);
    const text = ['.js', '.css', '.html', '.json', '.txt', '.rsc', '.meta'];
    const outputs = [
      ...readAssets(distOf(s), text, 5 * 1024 * 1024).map((file) => ({
        ...file,
        name: `web/${file.name}`,
      })),
      ...readAssets(verifierDist(), text).map((file) => ({
        ...file,
        name: `verifier/${file.name}`,
      })),
    ];
    expect(outputs.length).toBeGreaterThan(50);
    // Key and token shapes, and the synthetic credentials this run actually used.
    expect(
      scanServerAssets(outputs, [
        {
          id: 'storage-secret',
          class: 'storage_credential',
          kind: 'text',
          value: s.services.s3.secretAccessKey,
        },
        {
          id: 'storage-access-key',
          class: 'storage_credential',
          kind: 'text',
          value: s.services.s3.accessKeyId,
        },
      ]),
    ).toEqual([]);
    // A credential in a URL, with quotes excluded from the user-info so minified code is not misread.
    const urlCredential =
      /[a-z][a-z0-9+.-]*:\/\/[^\s/@:"'`]+:[^\s/@"'`]+@(?!127\.0\.0\.1|localhost)[a-z0-9.-]+/i;
    expect(
      outputs.filter((file) => urlCredential.test(file.text)).map((file) => file.name),
    ).toEqual([]);
  });
});
