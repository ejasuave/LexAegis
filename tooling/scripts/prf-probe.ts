/**
 * Probes the pinned Chromium virtual authenticator through a real credential creation and
 * assertion with the WebAuthn PRF extension. A successful addVirtualAuthenticator call alone is
 * not evidence. This exercises the browser and authenticator only: there is no application
 * signer or vault path yet (Chapters 4 and 5), so same-input stability and purpose separation
 * are shown at the credential boundary, not through application code.
 */
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { recordEvidence } from '../src/evidence-writer';
import { ROOT, stamp } from './lib';

const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>probe</title>');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('no port');
const origin = `http://localhost:${String(address.port)}`;

interface PageResult {
  created: boolean;
  prfEnabledAtCreate: boolean | null;
  prfAvailable: boolean;
  stable: boolean;
  separated: boolean;
  lengthBytes: number;
  error: string | null;
}

async function probe(): Promise<{
  outcome: PageResult;
  cdpAccepted: 'hasPrf' | 'rejected';
  version: string;
}> {
  const browser = await chromium.launch({ headless: true });
  let cdpAccepted: 'hasPrf' | 'rejected' = 'rejected';
  try {
    const version = browser.version();
    const context = await browser.newContext();
    const page = await context.newPage();
    // tsx's esbuild step injects a __name helper into functions; the page needs a stand-in for it.
    await page.addInitScript('window.__name = (target) => target;');
    await page.goto(origin);
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const options = {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    };
    try {
      await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: { ...options, hasPrf: true } as never,
      });
      cdpAccepted = 'hasPrf';
    } catch {
      await cdp.send('WebAuthn.addVirtualAuthenticator', { options: options as never });
    }

    const outcome = await page.evaluate(async (): Promise<PageResult> => {
      const result: PageResult = {
        created: false,
        prfEnabledAtCreate: null,
        prfAvailable: false,
        stable: false,
        separated: false,
        lengthBytes: 0,
        error: null,
      };
      try {
        const bytes = (text: string) => new TextEncoder().encode(text);
        const created = (await navigator.credentials.create({
          publicKey: {
            rp: { name: 'probe', id: 'localhost' },
            user: {
              id: crypto.getRandomValues(new Uint8Array(16)),
              name: 'probe',
              displayName: 'probe',
            },
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
            extensions: { prf: {} },
          },
        })) as PublicKeyCredential;
        result.created = true;
        const createExt = created.getClientExtensionResults() as { prf?: { enabled?: boolean } };
        result.prfEnabledAtCreate = createExt.prf?.enabled ?? null;

        const evaluate = async (salt: string): Promise<Uint8Array | null> => {
          const assertion = (await navigator.credentials.get({
            publicKey: {
              challenge: crypto.getRandomValues(new Uint8Array(32)),
              rpId: 'localhost',
              allowCredentials: [{ type: 'public-key', id: created.rawId }],
              userVerification: 'required',
              extensions: { prf: { eval: { first: bytes(salt) } } },
            },
          })) as PublicKeyCredential;
          const first = (
            assertion.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }
          ).prf?.results?.first;
          return first === undefined ? null : new Uint8Array(first);
        };
        const a1 = await evaluate('lexaegis/probe/purpose-a');
        const a2 = await evaluate('lexaegis/probe/purpose-a');
        const b = await evaluate('lexaegis/probe/purpose-b');
        result.prfAvailable = a1 !== null && a2 !== null && b !== null;
        if (a1 && a2 && b) {
          const same = (x: Uint8Array, y: Uint8Array) =>
            x.length === y.length && x.every((v, i) => v === y[i]);
          result.lengthBytes = a1.length;
          result.stable = same(a1, a2);
          result.separated = !same(a1, b);
        }
      } catch (error) {
        result.error = error instanceof Error ? error.name : 'unknown';
      }
      return result;
    });
    return { outcome, cdpAccepted, version };
  } finally {
    await browser.close();
    server.close();
  }
}

const { outcome, cdpAccepted, version } = await probe();

const ok =
  outcome.created &&
  outcome.prfAvailable &&
  outcome.stable &&
  outcome.separated &&
  outcome.lengthBytes === 32;
console.log(
  JSON.stringify(
    { browser: `chromium ${version}`, cdpPrfOption: cdpAccepted, ...outcome },
    null,
    2,
  ),
);

const reasons = [
  'AUTHENTICATOR_MODE_VIRTUAL',
  'PASSKEY_STEP_REQUIRES_REAL_DEVICE_EVIDENCE',
  'APPLICATION_PATH_PENDING',
];
await recordEvidence({
  root: ROOT,
  results: [
    stamp({
      id: `prf-probe-${new Date().toISOString().slice(0, 10)}-${stampSuffix()}`,
      subject: 'prf-virtual-authenticator-probe',
      command: 'pnpm exec tsx tooling/scripts/prf-probe.ts',
      evidenceClass: 'virtual_authenticator',
      outcome: ok ? 'pass' : 'fail',
      reasonCodes: ok ? reasons : [outcome.error ? 'PROBE_ERROR' : 'PRF_UNAVAILABLE', ...reasons],
      facts: {
        browser: `chromium ${version}`,
        cdpPrfOption: cdpAccepted,
        credentialCreated: outcome.created,
        prfEvaluated: outcome.prfAvailable,
        sameInputStable: outcome.stable,
        purposeSeparated: outcome.separated,
        outputBytes: String(outcome.lengthBytes),
        authenticatorMode: 'virtual',
        realDeviceEvidence: false,
      },
    }),
  ],
});
process.exit(ok ? 0 : 1);

function stampSuffix(): string {
  return Math.random().toString(36).slice(2, 7);
}
