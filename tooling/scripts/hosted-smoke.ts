/**
 * pnpm hosted:smoke [--app <https-origin>] [--verifier <https-origin>] [--allow-http] [--evidence]
 *
 * Unauthenticated, bounded checks of a deployed candidate through its real origins: liveness,
 * readiness shape, security headers, a served static asset, an oversized control body, and the
 * independent verifier. Everything that needs a person, a passkey ceremony, paid inference or a
 * fee-paying transaction is reported as `not_run` with its reason, never as passing.
 *
 * Origins default to deploy/target.json. With none configured the result is `blocked`. --allow-http
 * exists only to test this script against a local server; such a run never writes evidence.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib';

type State = 'pass' | 'fail' | 'blocked' | 'not_run';
interface Check {
  id: string;
  state: State;
  detail: string;
}

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const target = JSON.parse(readFileSync(join(ROOT, 'deploy/target.json'), 'utf8')) as {
  origins: { app: string | null; verifier: string | null };
};
const app = option('--app') ?? target.origins.app;
const verifier = option('--verifier') ?? target.origins.verifier;
const allowHttp = flag('--allow-http');
const checks: Check[] = [];
const add = (id: string, state: State, detail: string): void => {
  checks.push({ id, state, detail });
};

function httpsOrigin(value: string | null, name: string): string | null {
  if (value === null) {
    add(`${name}.origin`, 'blocked', 'origin not configured');
    return null;
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' && !allowHttp) {
    add(`${name}.origin`, 'fail', 'origin is not HTTPS');
    return null;
  }
  return url.origin;
}

async function get(url: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), ...init });
  } catch {
    return null;
  }
}

async function appChecks(origin: string): Promise<void> {
  const live = await get(`${origin}/api/health`);
  add(
    'app.liveness',
    live?.status === 200 && (live.headers.get('content-type') ?? '').includes('json')
      ? 'pass'
      : 'fail',
    `status ${live?.status ?? 'unreachable'}`,
  );
  const ready = await get(`${origin}/api/readiness`);
  const body: unknown = ready === null ? null : await ready.json().catch(() => null);
  const status =
    typeof body === 'object' && body !== null ? (body as { status?: unknown }).status : undefined;
  add(
    'app.readiness',
    ready !== null && typeof status === 'string' ? 'pass' : 'fail',
    `HTTP ${ready?.status ?? 'unreachable'}, reported status ${String(status)}; a 503 is an honest not-ready report, not a pass of the product`,
  );
  const page = await get(`${origin}/verify`);
  const required = [
    'content-security-policy',
    'x-content-type-options',
    'referrer-policy',
    'permissions-policy',
    'x-frame-options',
  ];
  const missing = required.filter((name) => page?.headers.get(name) == null);
  add(
    'app.headers',
    page !== null && page.status === 200 && missing.length === 0 ? 'pass' : 'fail',
    missing.length === 0 ? `status ${page?.status}` : `missing ${missing.join(',')}`,
  );
  add(
    'app.cache',
    page?.headers.get('cache-control')?.includes('no-store') ? 'pass' : 'fail',
    page?.headers.get('cache-control') ?? 'no cache-control',
  );
  const html = page === null ? '' : await page.clone().text();
  const script = /src="(\/_next\/static\/[^"]+\.js)"/.exec(html)?.[1];
  const asset = script === undefined ? null : await get(`${origin}${script}`);
  add(
    'app.static-asset',
    asset?.status === 200 ? 'pass' : 'fail',
    script === undefined ? 'no script found in page' : `status ${asset?.status ?? 'unreachable'}`,
  );
  const big = await get(`${origin}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'x-lexaegis-request': '1' },
    body: JSON.stringify({ pad: 'x'.repeat(17 * 1024) }),
  });
  const bigState: State =
    big !== null && big.status >= 400 && big.status < 500
      ? 'pass'
      : big?.status === 503
        ? 'blocked'
        : 'fail';
  add(
    'app.oversize-control',
    bigState,
    `status ${big?.status ?? 'unreachable'} for a 17 KiB control body${bigState === 'blocked' ? ' (auth unavailable, so the bound was not demonstrated)' : ''}`,
  );
}

async function verifierChecks(origin: string): Promise<void> {
  const root = await get(`${origin}/`);
  const html = root === null ? '' : await root.text();
  add(
    'verifier.page',
    root?.status === 200 && html.includes('Content-Security-Policy') ? 'pass' : 'fail',
    `status ${root?.status ?? 'unreachable'}, CSP meta ${html.includes('Content-Security-Policy')}`,
  );
  add(
    'verifier.no-session',
    root !== null && root.headers.get('set-cookie') === null ? 'pass' : 'fail',
    'no cookie set',
  );
  const health = await get(`${origin}/healthz`);
  add(
    'verifier.health',
    health?.status === 200 ? 'pass' : 'fail',
    `status ${health?.status ?? 'unreachable'}`,
  );
}

const appOrigin = httpsOrigin(app, 'app');
const verifierOrigin = httpsOrigin(verifier, 'verifier');
if (appOrigin !== null) await appChecks(appOrigin);
if (verifierOrigin !== null) await verifierChecks(verifierOrigin);

for (const [id, reason] of [
  ['journey.passkey-onboarding', 'needs a person and a real passkey ceremony'],
  [
    'journey.sse-progressive',
    'needs an authenticated session and a protected release probe or scripted provider; no paid inference',
  ],
  ['journey.16mib-upload', 'needs an authenticated session on the deployed vault path'],
  [
    'journey.registry-execution',
    'needs an approved, fee-paying testnet transaction with separate confirmations',
  ],
  ['journey.envio-history', 'needs a deployed, synced indexer'],
  ['journey.storage-cleared-recovery', 'needs the final rpId and a person to clear storage'],
  ['journey.second-device', 'needs a second supported device'],
  ['journey.reference-only-verify-offline', 'needs a browser session with the web backend blocked'],
] as const)
  add(id, 'not_run', reason);

for (const check of checks) console.log(`${check.state.padEnd(8)} ${check.id}: ${check.detail}`);
const failed = checks.some((check) => check.state === 'fail');
const blocked = checks.some((check) => check.state === 'blocked');
const outcome = failed ? 'fail' : blocked ? 'blocked' : 'partial';
console.log(`outcome: ${outcome} (not_run checks keep the product claims they gate open)`);

if (flag('--evidence') && !allowHttp && appOrigin !== null && verifierOrigin !== null) {
  const file = `docs/evidence/chapter13-hosted-smoke-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(
    join(ROOT, file),
    `${JSON.stringify({ schema: 'lexaegis.hosted-smoke.v1', checkedAt: new Date().toISOString(), origins: { app: appOrigin, verifier: verifierOrigin }, outcome, checks }, null, 2)}\n`,
  );
  console.log(`evidence: ${file}`);
}
process.exit(failed ? 1 : blocked ? 3 : 0);
