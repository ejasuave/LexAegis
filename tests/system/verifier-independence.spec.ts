import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Hex } from 'viem';
import type { BrowserContext, Page, Request, Route } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildIssueAction,
  buildRevokeAction,
  buildSupersedeAction,
  buildTypedData,
  defaultActionDeadline,
  proofOfReviewRegistryAbi as abi,
  toAbiReviewAction,
  toEip712ReviewAction,
  type BoundReviewAction,
} from '@lexaegis/sdk/registry';
import {
  accounts,
  expectOk,
  prepareLocalPackage,
  type LocalBinding,
} from '../../contracts/integration/harness';
import {
  addMatterAndDocument,
  approveSendAndExport,
  clearOriginState,
  confirmFactsAndCheck,
  createAccountAndVault,
  decideRecordAndFreeze,
} from './harness/flows';
import { chainDefinition, fund } from './harness/chain';
import { isBlocked } from './harness/services';
import { startSuite, type Suite } from './harness/suite';
import { buildVerifier, serveStatic } from './harness/verifier';

/*
 * SYSTEM EVIDENCE (browser_scripted). The standalone verifier, in a fresh isolated context with no
 * LexAegis cookies, passkey, vault or backend, checks the exact readable bundles downloaded from two
 * complete local journeys. The chain is a loopback Anvil; the registry code is the unchanged v1
 * registry. This demonstrates the verifier's behaviour on LexAegis's own output: it is not an
 * independent implementation, an independent adoption, or a separately authored verifier.
 */

const CASES = [
  'verifier-local-checks-offline-and-no-disclosure',
  'verifier-substitution-and-expectation-provenance',
  'verifier-malformed-inputs-and-modes',
  'verifier-registry-failures-and-public-report',
  'verifier-export-handoff-and-persistence',
] as const;

/** The parts of a readable export the mutations touch. Everything else passes through untouched. */
interface Draft {
  schema: string;
  receiptReference: { commitment: string; [key: string]: string };
  opening: { blindingNonce: string; manifest: Record<string, unknown> & { packageId: string } };
  artifacts: { id: string; bytes: string }[];
  [key: string]: unknown;
}

interface Bundle {
  readonly page: Page;
  readonly exportPath: string;
  readonly reference: string;
  readonly text: string;
  readonly json: Draft;
}

let suite: Suite | undefined;
let scratch = '';
let verifierOrigin = '';
let stopServer: (() => void) | undefined;
let bundleA: Bundle | undefined;
let bundleB: Bundle | undefined;

async function journey(s: Suite, title: string): Promise<Bundle> {
  const { page } = await s.newSession();
  await page.addInitScript(() => {
    // Records every cross-document handoff attempt so the export tests can assert there was none.
    const log: unknown[] = [];
    (window as unknown as { __handoff: unknown[] }).__handoff = log;
    const post = window.postMessage.bind(window);
    window.postMessage = ((...args: unknown[]) => {
      log.push([
        'postMessage',
        typeof args[1] === 'string' ? args[1] : JSON.stringify(args[1] ?? ''),
      ]);
      post(...(args as [unknown, string]));
    }) as typeof window.postMessage;
    const open = window.open.bind(window);
    window.open = (...args: unknown[]) => {
      log.push(['open', typeof args[0] === 'string' ? args[0] : '']);
      return open(...(args as Parameters<typeof open>));
    };
  });
  const account = await createAccountAndVault(page, s.app.origin);
  if (s.chain === null) throw new Error('chain');
  await fund(s.chain, account.address, 10n * 10n ** 18n);
  await addMatterAndDocument(page, title);
  await confirmFactsAndCheck(page);
  await decideRecordAndFreeze(page, `Journey ${title}.`);
  const out = await approveSendAndExport(page, scratch);
  const text = readFileSync(out.exportPath, 'utf8');
  return { page, ...out, text, json: JSON.parse(text) as Draft };
}

beforeAll(async () => {
  const started = await startSuite({
    name: 'verifier-independence',
    cases: CASES,
    localChain: true,
  });
  if (isBlocked(started)) return;
  scratch = mkdtempSync(join(tmpdir(), 'system-verifier-'));
  if (started.chain === null || started.registry === null) throw new Error('chain');
  const dist = join(scratch, 'verifier');
  buildVerifier(dist, 'loopback-test', {
    VITE_REGISTRY_POLICY_JSON: JSON.stringify(started.registry.policy),
    VITE_RPC_URL: `${started.chain.local.rpcUrl}/`,
    VITE_RPC_ALLOWED_ORIGINS: started.chain.local.rpcUrl,
  });
  const server = await serveStatic(dist);
  verifierOrigin = server.origin;
  stopServer = () => server.server.close();
  suite = started;
  bundleA = await journey(started, 'SYSTEM-verifier-A');
  bundleB = await journey(started, 'SYSTEM-verifier-B');
}, 1_200_000);
afterAll(async () => {
  stopServer?.();
  await suite?.stop();
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------
// A fresh, isolated verifier context: no LexAegis cookie, passkey, vault or backend.

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

class VerifierSession {
  readonly seen: Seen[] = [];
  page!: Page;
  context!: BrowserContext;
  /** Everything the page asked for, by origin. */
  private constructor(
    private readonly rpcOrigin: string,
    private readonly allowRpc: boolean,
  ) {}

  static async open(
    s: Suite,
    options: {
      allowRpc?: boolean;
      rpcHandler?: Parameters<BrowserContext['route']>[1];
      /** Observe requests without intercepting them, so the browser's HTTP cache stays in play. */
      observeOnly?: boolean;
    } = {},
  ): Promise<VerifierSession> {
    const rpcOrigin = new URL(s.chain?.local.rpcUrl ?? '').origin;
    const session = new VerifierSession(rpcOrigin, options.allowRpc === true);
    session.context = await s.browser.newContext({
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
    });
    const record = (request: Request) =>
      session.seen.push({
        url: request.url(),
        method: request.method(),
        body: request.postData() ?? '',
      });
    if (options.observeOnly === true) session.context.on('request', record);
    else
      await session.context.route('**/*', async (route, request) => {
        const url = new URL(request.url());
        record(request);
        if (url.origin === verifierOrigin) await route.continue();
        else if (url.origin === rpcOrigin && options.allowRpc === true) {
          if (options.rpcHandler !== undefined) await options.rpcHandler(route, request);
          else await route.continue();
        } else await route.abort();
      });
    session.page = await session.context.newPage();
    await session.page.goto(verifierOrigin);
    await session.page.getByTestId('file-input').waitFor({ timeout: 30_000 });
    return session;
  }

  /** Requests after the initial load. */
  get afterLoad(): Seen[] {
    return this.seen.filter((entry) => !entry.url.startsWith(verifierOrigin));
  }

  async file(path: string, kind: 'file' | 'opening' = 'file'): Promise<void> {
    if (kind === 'opening') await this.page.getByLabel('Opening file plus a reference').check();
    await this.page.getByTestId('file-input').setInputFiles(path);
  }

  async check(reference: string | null): Promise<void> {
    if (reference !== null) await this.page.getByTestId('reference-input').fill(reference);
    await this.page.getByTestId('check-files').click();
  }

  text(testId: string): Promise<string> {
    return this.page.getByTestId(testId).innerText();
  }

  /** Waits for either a result panel or a failure and returns which. */
  async settle(): Promise<'result' | 'failure'> {
    const outcome = await Promise.race([
      this.page
        .getByTestId('panel-manifest')
        .waitFor({ timeout: 45_000 })
        .then(() => 'result' as const),
      this.page
        .getByTestId('failure')
        .waitFor({ timeout: 45_000 })
        .then(() => 'failure' as const),
    ]);
    // Results are written after the local job finishes; give the label its final value.
    await this.page.waitForTimeout(300);
    return outcome;
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

const written = (name: string, content: string | Buffer): string => {
  const path = join(scratch, name);
  writeFileSync(path, content);
  return path;
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const variant = (bundle: Bundle, mutate: (draft: Draft) => void): string => {
  const draft = clone(bundle.json);
  mutate(draft);
  return written(
    `variant-${String(Date.now())}-${String(Math.random()).slice(2, 8)}.json`,
    JSON.stringify(draft),
  );
};
const withField = (reference: string, field: string, value: string): string => {
  const parsed = JSON.parse(reference) as Record<string, string>;
  parsed[field] = value;
  return JSON.stringify(parsed);
};
const flipLast = (hex: string): string => `${hex.slice(0, -1)}${hex.endsWith('0') ? '1' : '0'}`;

/** Strings that must never leave the machine through a verifier request or public report. */
function privateStrings(bundle: Bundle): string[] {
  const opening = bundle.json.opening as {
    blindingNonce: string;
    manifest: { packageId: string; artifacts: { sha256: string; label: string | null }[] };
  };
  const artifacts = bundle.json.artifacts as { bytes: string }[];
  return [
    opening.blindingNonce,
    opening.manifest.packageId,
    ...opening.manifest.artifacts.map((artifact) => artifact.sha256),
    ...opening.manifest.artifacts.flatMap((artifact) =>
      artifact.label === null ? [] : [artifact.label],
    ),
    ...artifacts.map((artifact) => artifact.bytes.slice(0, 48)),
    'review-export',
  ].map((value) => value.toLowerCase());
}
const mentionsPrivate = (haystack: string, bundle: Bundle): string[] => {
  const lower = haystack.toLowerCase();
  return privateStrings(bundle).filter(
    (needle) => lower.includes(needle) || lower.includes(needle.replace(/^0x/, '')),
  );
};

const needSuite = (context: { skip: () => never }): { s: Suite; a: Bundle; b: Bundle } => {
  if (suite === undefined || bundleA === undefined || bundleB === undefined) context.skip();
  return { s: suite, a: bundleA, b: bundleB };
};

describe('[verifier-local-checks-offline-and-no-disclosure] local verification needs no network and discloses nothing', () => {
  it('with the network cut after load, files verify locally against the independent reference', async (context) => {
    const { s, a } = needSuite(context);
    // Observed, not intercepted: interception switches the browser cache off, and the worker script
    // is fetched on first use (see docs/END-OF-BUILD-NOTES.md), so it must come from the cache here.
    const v = await VerifierSession.open(s, { observeOnly: true });
    try {
      expect((await v.context.cookies()).length).toBe(0);
      await v.file(a.exportPath);
      await v.page.getByTestId('panel-manifest').waitFor({ timeout: 30_000 });
      await v.page.getByTestId('clear').click();
      const failed: string[] = [];
      v.context.on('requestfailed', (request) => failed.push(request.url()));
      await v.context.setOffline(true);
      const before = v.seen.length;
      await v.file(a.exportPath);
      await v.page.getByTestId('panel-manifest').waitFor({ timeout: 30_000 });
      await v.check(a.reference);
      await expect
        .poll(() => v.text('label-artifacts'), { timeout: 30_000 })
        .toMatch(/Every committed artifact matches/);
      expect(await v.text('label-manifest')).toBe('Files match the reference you supplied');
      expect(await v.text('reference-origin')).toBe('Supplied independently by you.');
      // The registry was not asked, so no registry claim is made.
      expect(await v.text('label-registry')).toBe('Registry identity unverified');
      // With the network down, nothing failed and nothing but the verifier's own cached script ran.
      expect(failed).toEqual([]);
      for (const entry of v.seen.slice(before)) {
        expect(new URL(entry.url).origin, entry.url).toBe(verifierOrigin);
        expect(entry.method).toBe('GET');
        expect(entry.url).toContain('/assets/');
      }
    } finally {
      await v.close();
    }
  });

  it('a registry check sends only public values to the configured test RPC and never a private digest, nonce, label, content or file name', async (context) => {
    const { s, a } = needSuite(context);
    const v = await VerifierSession.open(s, { allowRpc: true });
    try {
      await v.file(a.exportPath);
      await v.page.getByTestId('panel-manifest').waitFor({ timeout: 30_000 });
      await v.check(a.reference);
      await expect
        .poll(() => v.text('label-artifacts'), { timeout: 30_000 })
        .toMatch(/Every committed artifact matches/);
      const reference = JSON.parse(a.reference) as { reviewerAddress: string };
      await v.page.getByTestId('signer-input').fill(reference.reviewerAddress);
      await v.page.getByTestId('check-registry').click();
      await v.page
        .getByText(/Active at block/)
        .first()
        .waitFor({ timeout: 60_000 });
      expect(await v.text('label-lifecycle')).toMatch(/Receipt binds to the verified files/);
      expect(await v.text('label-signer')).toBe('Signer meets your selected rule');
      expect(v.afterLoad.length).toBeGreaterThan(0);
      const rpcOrigin = new URL(s.chain?.local.rpcUrl ?? '').origin;
      expect(v.afterLoad.every((entry) => new URL(entry.url).origin === rpcOrigin)).toBe(true);
      expect(v.afterLoad.every((entry) => entry.method === 'POST')).toBe(true);
      for (const entry of v.afterLoad)
        expect(mentionsPrivate(`${entry.url}\n${entry.body}`, a), entry.body.slice(0, 120)).toEqual(
          [],
        );
      // The disclosure sentence names the endpoint and says no file, opening, name or hash is sent.
      expect(await v.text('disclosure')).toMatch(/No file, opening, file name or hash is sent/);
    } finally {
      await v.close();
    }
  });

  it('a file cannot supply its own endpoint, registry policy or trust: such fields are refused and nothing is contacted', async (context) => {
    const { s, a } = needSuite(context);
    const planted = 'http://127.0.0.1:9/planted-rpc';
    for (const [name, mutate] of [
      ['top-level rpcUrl', (d: Draft) => (d.rpcUrl = planted)],
      ['top-level registry policy', (d: Draft) => (d.registryPolicy = { chainId: '1' })],
      ['trusted signers', (d: Draft) => (d.trustedSigners = [a.json.receiptReference])],
      ['field inside the receipt reference', (d: Draft) => (d.receiptReference.rpcUrl = planted)],
      ['field inside the manifest', (d: Draft) => (d.opening.manifest.rpcUrl = planted)],
    ] as const) {
      const v = await VerifierSession.open(s, { allowRpc: true });
      try {
        await v.file(variant(a, mutate));
        expect(await v.settle(), name).toBe('failure');
        expect(await v.text('failure'), name).toMatch(
          /fields this verifier does not accept|does not match the review export format/,
        );
        expect(v.afterLoad.length, name).toBe(0);
        expect(
          v.seen.some((entry) => entry.url.includes('planted-rpc')),
          name,
        ).toBe(false);
        // The configured policy is still the verifier's own build policy.
        expect(await v.text('policy')).toContain('10143');
      } finally {
        await v.close();
      }
    }
  });
});

describe('[verifier-substitution-and-expectation-provenance] the independently supplied reference catches substitution', () => {
  it('a mutated file, manifest, nonce or reference field is caught, and the control passes', async (context) => {
    const { s, a } = needSuite(context);
    const v = await VerifierSession.open(s);
    const run = async (path: string, reference: string | null) => {
      await v.page.getByTestId('clear').click();
      await v.file(path);
      const first = await v.settle();
      if (first === 'result' && reference !== null) await v.check(reference);
      return v.settle();
    };
    try {
      // Control: the unmodified file with the original reference.
      expect(await run(a.exportPath, a.reference)).toBe('result');
      await expect
        .poll(() => v.text('label-artifacts'))
        .toMatch(/Every committed artifact matches/);

      // One artifact byte changed (first base64url character), same length, same manifest.
      const flipped = variant(a, (d) => {
        const artifact = d.artifacts[0];
        if (artifact === undefined) throw new Error('the export has no artifact');
        artifact.bytes = `${artifact.bytes.startsWith('J') ? 'K' : 'J'}${artifact.bytes.slice(1)}`;
      });
      expect(await run(flipped, a.reference)).toBe('result');
      await expect
        .poll(() => v.text('label-artifacts'))
        .toMatch(/An artifact differs from what was committed/);
      expect(await v.text('inventory')).toMatch(/Changed/);

      // A manifest field changed: it no longer opens the commitment.
      const manifest = variant(
        a,
        (d) => (d.opening.manifest.packageId = '00000000-0000-4000-8000-000000000000'),
      );
      expect(await run(manifest, a.reference)).toBe('result');
      await expect
        .poll(() => v.text('label-manifest'))
        .toBe('Files do not match the expected reference');
      expect(await v.text('label-artifacts')).not.toMatch(/Every committed artifact matches/);

      // The opening nonce changed.
      const nonce = variant(
        a,
        (d) => (d.opening.blindingNonce = flipLast(d.opening.blindingNonce)),
      );
      expect(await run(nonce, a.reference)).toBe('result');
      await expect
        .poll(() => v.text('label-manifest'))
        .toBe('Files do not match the expected reference');

      // The file declares a different commitment from the one you expect: reported, and not used.
      const declared = variant(
        a,
        (d) => (d.receiptReference.commitment = flipLast(d.receiptReference.commitment)),
      );
      expect(await run(declared, a.reference)).toBe('result');
      await expect
        .poll(() => v.text('declared-conflict'))
        .toMatch(/declares a different reference. It was not used/);
      expect(await v.text('reference-origin')).toBe('Supplied independently by you.');

      // Your expected reference differs from the file in one field: caught.
      for (const field of ['commitment', 'reviewerAddress', 'registryAddress'] as const) {
        const reference = JSON.parse(a.reference) as Record<string, string>;
        const altered = withField(
          a.reference,
          field,
          field === 'commitment'
            ? flipLast(reference[field] ?? '')
            : flipLast(reference[field] ?? ''),
        );
        expect(await run(a.exportPath, altered), field).toBe('result');
        await expect
          .poll(() => v.text('label-manifest'), { message: field })
          .toBe('Files do not match the expected reference');
      }
    } finally {
      await v.close();
    }
  });

  it('an entire internally consistent bundle from another journey is rejected by the original reference', async (context) => {
    const { s, a, b } = needSuite(context);
    const v = await VerifierSession.open(s);
    try {
      // Control: bundle B is consistent with ITS OWN reference.
      await v.file(b.exportPath);
      await v.page.getByTestId('panel-manifest').waitFor({ timeout: 30_000 });
      await v.check(b.reference);
      await expect
        .poll(() => v.text('label-artifacts'))
        .toMatch(/Every committed artifact matches/);
      // Substitution: B presented for A's reference.
      await v.check(a.reference);
      await expect
        .poll(() => v.text('label-manifest'))
        .toBe('Files do not match the expected reference');
      expect(await v.text('label-artifacts')).not.toMatch(/Every committed artifact matches/);
      expect(await v.text('declared-conflict')).toMatch(/declares a different reference/);
    } finally {
      await v.close();
    }
  });

  it('with no independent reference the result says so and never claims an authenticated origin', async (context) => {
    const { s, a } = needSuite(context);
    const v = await VerifierSession.open(s);
    try {
      await v.file(a.exportPath);
      await v.page.getByTestId('panel-manifest').waitFor({ timeout: 30_000 });
      await expect
        .poll(() => v.text('label-manifest'))
        .toBe('Files match the reference declared inside the file');
      expect(await v.text('origin-warning')).toMatch(/taken from the file itself/);
      expect(await v.text('reference-origin')).toBe(
        'Taken from the imported file. Not independently supplied.',
      );
      const page = await v.page.innerText('body');
      expect(page).not.toMatch(/authenticated|trusted origin|independently verified|\bvalid\b/i);
    } finally {
      await v.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Case 3: malformed inputs, limits, cancellation and what each mode may claim.

const MIB = 1024 * 1024;
/** The portable limits, mirrored from @lexaegis/protocol/portable (frozen with the readable export). */
const LIMITS = { encoded: 48 * MIB, structured: 1 * MIB, artifacts: 128, perArtifact: 10 * MIB };

describe('[verifier-malformed-inputs-and-modes] wrong inputs fail with a typed message, and each mode claims only what it checked', () => {
  const failing: [string, (a: Bundle) => string | Buffer, RegExp][] = [
    [
      'an encrypted backup',
      () => JSON.stringify({ schema: 'lexaegis.encrypted-review-export.v1' }),
      /encrypted backup/,
    ],
    [
      'saved matter context',
      () => JSON.stringify({ schema: 'lexaegis.matter-context-export.v1' }),
      /saved matter context/,
    ],
    [
      'another version of the export',
      (a) => JSON.stringify({ ...a.json, schema: 'lexaegis.review-export.v2' }),
      /version this verifier does not support/,
    ],
    [
      'an unrelated JSON document',
      () => JSON.stringify({ schema: 'something.else' }),
      /not a readable review export/,
    ],
    ['a byte-order mark', (a) => `\ufeff${a.text}`, /strict JSON/],
    ['trailing text', (a) => `${a.text} trailing`, /strict JSON/],
    [
      'a duplicate key',
      () => '{"schema":"lexaegis.review-export.v1","schema":"lexaegis.review-export.v1"}',
      /strict JSON/,
    ],
    ['nesting beyond the depth limit', () => `${'['.repeat(64)}${']'.repeat(64)}`, /strict JSON/],
    [
      'a missing artifact',
      (a) => {
        const d = clone(a.json);
        d.artifacts.shift();
        return JSON.stringify(d);
      },
      /not exactly the ones the manifest lists/,
    ],
    [
      'an extra artifact',
      (a) => {
        const d = clone(a.json);
        d.artifacts.push({ id: '00000000-0000-4000-8000-0000000000aa', bytes: 'AAAA' });
        return JSON.stringify(d);
      },
      /not exactly the ones the manifest lists|does not match the review export format/,
    ],
    [
      'a duplicated artifact',
      (a) => {
        const d = clone(a.json);
        d.artifacts.push(clone(d.artifacts[0] ?? { id: '', bytes: '' }));
        return JSON.stringify(d);
      },
      /not exactly the ones the manifest lists|does not match the review export format/,
    ],
    [
      'reordered artifacts',
      (a) => {
        const d = clone(a.json);
        d.artifacts.reverse();
        return JSON.stringify(d);
      },
      /not exactly the ones the manifest lists/,
    ],
    [
      'more artifacts than the count limit',
      (a) => {
        const d = clone(a.json);
        d.artifacts = Array.from({ length: LIMITS.artifacts + 1 }, (_, index) => ({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          bytes: 'AAAA',
        }));
        return JSON.stringify(d);
      },
      /does not match the review export format|not exactly the ones the manifest lists/,
    ],
    [
      'an artifact over the per-artifact size limit',
      (a) => {
        const d = clone(a.json);
        d.artifacts[0] = {
          id: d.artifacts[0]?.id ?? '',
          bytes: 'A'.repeat(Math.ceil((LIMITS.perArtifact * 4) / 3) + 8),
        };
        return JSON.stringify(d);
      },
      /larger than the 10 MiB limit|does not match the review export format/,
    ],
    [
      'an artifact that is not canonical base64url',
      (a) => {
        const d = clone(a.json);
        d.artifacts[0] = { id: d.artifacts[0]?.id ?? '', bytes: `${d.artifacts[0]?.bytes ?? ''}=` };
        return JSON.stringify(d);
      },
      /not canonical base64url|does not match the review export format/,
    ],
  ];

  it('refuses each unsupported input with its own message, no result and no network request', async (context) => {
    const { s, a } = needSuite(context);
    const v = await VerifierSession.open(s, { allowRpc: true });
    try {
      for (const [name, build, message] of failing) {
        await v.page.getByTestId('clear').click();
        await v.file(written(`bad-${String(Math.random()).slice(2, 8)}.json`, build(a)));
        expect(await v.settle(), name).toBe('failure');
        expect(await v.text('failure'), name).toMatch(message);
        expect(await v.page.getByTestId('panel-manifest').count(), name).toBe(0);
        expect(await v.page.getByTestId('no-results').count(), name).toBe(1);
        expect(await v.page.innerText('body'), name).not.toMatch(/Every committed artifact/);
      }
      expect(v.afterLoad.length).toBe(0);
    } finally {
      await v.close();
    }
  });

  it('size limits are enforced before the file is read: a readable export over 48 MiB and an opening over 1 MiB', async (context) => {
    const { s, a } = needSuite(context);
    const v = await VerifierSession.open(s);
    try {
      await v.file(written('too-large.json', Buffer.alloc(LIMITS.encoded + 1, 0x20)));
      expect(await v.settle()).toBe('failure');
      expect(await v.text('failure')).toMatch(/larger than the limit and was not read/);
      await v.page.getByTestId('clear').click();
      await v.page.getByTestId('reference-input').fill(a.reference);
      await v.file(
        written('opening-too-large.json', Buffer.alloc(LIMITS.structured + 1, 0x20)),
        'opening',
      );
      expect(await v.settle()).toBe('failure');
      expect(await v.text('failure')).toMatch(/larger than the limit and was not read/);
      expect(v.afterLoad.length).toBe(0);
    } finally {
      await v.close();
    }
  });

  it('Cancel stops a running worker job: no result appears afterwards and the next check works', async (context) => {
    const { s, a } = needSuite(context);
    // Three near-limit artifacts make the local job long enough to interrupt. The content does not
    // match the manifest, which is irrelevant: only the job's lifetime is under test.
    const heavy = variant(a, (d) => {
      const filler = 'A'.repeat(Math.ceil((LIMITS.perArtifact * 4) / 3) - 8);
      for (const artifact of d.artifacts.slice(0, 3)) artifact.bytes = filler;
    });
    const v = await VerifierSession.open(s);
    try {
      let cancelled = false;
      for (let attempt = 0; attempt < 5 && !cancelled; attempt += 1) {
        await v.page.getByTestId('clear').click();
        const choosing = v.file(heavy);
        await v.page
          .getByTestId('progress')
          .filter({ hasText: /Reading|Starting|Parsing|Decoded|Hashing/ })
          .waitFor({ timeout: 30_000 })
          .catch(() => undefined);
        await choosing;
        if ((await v.page.getByTestId('cancel').getAttribute('aria-disabled')) === 'true') continue;
        await v.page.getByTestId('cancel').click();
        await v.page.getByTestId('failure').waitFor({ timeout: 10_000 });
        cancelled = /cancelled/.test(await v.text('failure'));
      }
      expect(cancelled, 'the job was cancelled while it was running').toBe(true);
      // A late result from the cancelled job must not appear.
      await v.page.waitForTimeout(4_000);
      expect(await v.text('failure')).toMatch(/The check was cancelled/);
      expect(await v.page.getByTestId('panel-manifest').count()).toBe(0);
      // The verifier is usable again.
      await v.page.getByTestId('clear').click();
      await v.file(a.exportPath);
      await v.page.getByTestId('panel-manifest').waitFor({ timeout: 30_000 });
      await v.check(a.reference);
      await expect
        .poll(() => v.text('label-artifacts'), { timeout: 30_000 })
        .toMatch(/Every committed artifact matches/);
    } finally {
      await v.close();
    }
  });

  it('reference-only and manifest-only inputs never claim that artifacts were verified', async (context) => {
    const { s, a, b } = needSuite(context);
    const v = await VerifierSession.open(s);
    try {
      // Reference only: no files at all.
      await v.page.getByTestId('reference-input').fill(a.reference);
      await v.page.getByTestId('inspect-reference').click();
      await v.page.getByTestId('panel-manifest').waitFor({ timeout: 15_000 });
      expect(await v.text('label-manifest')).toBe('Files not supplied');
      expect(await v.text('label-artifacts')).toBe('Artifacts not supplied');
      expect(await v.page.innerText('body')).toMatch(/Mode: reference only/);
      expect(await v.page.innerText('body')).not.toMatch(/Every committed artifact matches/);

      // Manifest only: the opening and the independent reference, with no artifact bytes.
      await v.page.getByTestId('clear').click();
      await v.page.getByTestId('reference-input').fill(a.reference);
      await v.file(written('opening-only.json', JSON.stringify(a.json.opening)), 'opening');
      await v.page.getByTestId('panel-manifest').waitFor({ timeout: 30_000 });
      expect(await v.text('label-manifest')).toBe('Files match the reference you supplied');
      expect(await v.text('label-artifacts')).toBe('Artifacts not supplied');
      expect(await v.page.innerText('body')).toMatch(/Mode: manifest only/);
      expect(await v.page.innerText('body')).not.toMatch(/Every committed artifact matches/);

      // The same opening against another journey's reference is a mismatch, not a pass.
      await v.page.getByTestId('reference-input').fill(b.reference);
      await v.check(null);
      await expect
        .poll(() => v.text('label-manifest'))
        .toBe('Files do not match the expected reference');

      // An opening with no independent reference at all is refused, never self-trusted.
      await v.page.getByTestId('clear').click();
      await v.file(written('opening-no-ref.json', JSON.stringify(a.json.opening)), 'opening');
      expect(await v.settle()).toBe('failure');
      expect(await v.text('failure')).toMatch(/no reference of its own/);
    } finally {
      await v.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Case 4: registry failures, receipt history and the public report. Receipts are real registry records
// on the loopback chain, issued, revoked and superseded with Anvil's published development reviewer key.

class LocalRegistry {
  readonly binding: LocalBinding;
  private readonly rpcUrl: string;
  private constructor(private readonly s: Suite) {
    if (s.chain === null || s.registry === null) throw new Error('chain');
    this.rpcUrl = s.chain.local.rpcUrl;
    this.binding = {
      chainId: s.chain.chainId,
      registryAddress: s.registry.address,
      reviewerAddress: accounts.reviewer.address.toLowerCase(),
    };
  }
  static of(s: Suite): LocalRegistry {
    return new LocalRegistry(s);
  }
  private client() {
    return createPublicClient({
      chain: chainDefinition(Number(this.binding.chainId)),
      transport: http(this.rpcUrl),
      pollingInterval: 50,
    });
  }
  private async nonce(): Promise<string> {
    return (
      await this.client().readContract({
        address: this.binding.registryAddress as Hex,
        abi,
        functionName: 'nonceOf',
        args: [this.binding.reviewerAddress as Hex],
      })
    ).toString();
  }
  private async deadline(): Promise<string> {
    const { timestamp } = await this.client().getBlock();
    return expectOk(defaultActionDeadline(timestamp.toString()));
  }
  private async execute(bound: BoundReviewAction): Promise<void> {
    const typed = expectOk(buildTypedData(bound, bound.chainId, bound.registryAddress));
    const action = expectOk(toAbiReviewAction(bound.action));
    const signature = await accounts.reviewer.signTypedData(expectOk(toEip712ReviewAction(typed)));
    const wallet = createWalletClient({
      account: accounts.executor,
      chain: chainDefinition(Number(this.binding.chainId)),
      transport: http(this.rpcUrl),
    });
    const hash = await wallet.sendTransaction({
      to: this.binding.registryAddress as Hex,
      data: encodeFunctionData({ abi, functionName: 'execute', args: [action, signature] }),
      gas: 1_000_000n,
    });
    const receipt = await this.client().waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('the registry action reverted');
    // Move past the execution delay so a verifier read at the finalized height sees the change.
    await this.s.chain?.local.transport.request('anvil_mine', ['0x64']);
  }
  async issued(
    caseId: 'legal' | 'legal-revised' = 'legal',
    supersedes: Awaited<ReturnType<typeof prepareLocalPackage>> | null = null,
  ) {
    const prepared = await prepareLocalPackage(caseId, this.binding, supersedes?.reference ?? null);
    if (supersedes === null)
      await this.execute(
        expectOk(buildIssueAction(prepared, await this.nonce(), await this.deadline())),
      );
    else
      await this.execute(
        expectOk(
          buildSupersedeAction(
            supersedes.reference,
            prepared,
            await this.nonce(),
            await this.deadline(),
          ),
        ),
      );
    return prepared;
  }
  async revoke(prepared: Awaited<ReturnType<typeof prepareLocalPackage>>): Promise<void> {
    await this.execute(
      expectOk(buildRevokeAction(prepared.reference, await this.nonce(), await this.deadline())),
    );
  }
}

type RpcMode = 'pass' | 'down' | 'flip-hash';

/** Forwards the verifier's JSON-RPC calls to the loopback node, optionally failing or rewriting them. */
function rpcRoute(mode: { current: RpcMode; pinned: number }) {
  return async (route: Route, request: Request): Promise<void> => {
    if (request.method() !== 'POST' || mode.current === 'pass') return route.continue();
    if (mode.current === 'down')
      return route.fulfill({
        status: 503,
        headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
        body: '{"error":"unavailable"}',
      });
    type Call = { id: number; method: string; params?: unknown[] };
    type Output = { id: number; result?: { hash?: string } | null };
    const upstream = await route.fetch();
    const calls = request.postDataJSON() as Call | Call[];
    const body = (await upstream.json()) as Output | Output[];
    for (const output of Array.isArray(body) ? body : [body]) {
      const call = (Array.isArray(calls) ? calls : [calls]).find((item) => item.id === output.id);
      const first = call?.params?.[0];
      const tag = typeof first === 'string' ? first : '';
      // The genesis pin, the finalized read and the first read of the pinned block are honest. The
      // recheck of that block reports a different hash, as a node that reorganised, or a second
      // node, would.
      if (
        call?.method === 'eth_getBlockByNumber' &&
        tag !== '0x0' &&
        tag !== 'finalized' &&
        output.result?.hash !== undefined
      ) {
        mode.pinned += 1;
        if (mode.pinned > 1) output.result.hash = flipLast(output.result.hash);
      }
    }
    return route.fulfill({ response: upstream, body: JSON.stringify(body) });
  };
}

const lifecycle = (v: VerifierSession) => v.text('label-lifecycle');

async function inspectReference(
  v: VerifierSession,
  reference: unknown,
  signer = '',
): Promise<void> {
  await v.page.getByTestId('clear').click();
  await v.page.getByTestId('reference-input').fill(JSON.stringify(reference));
  if (signer !== '') await v.page.getByTestId('signer-input').fill(signer);
  await v.page.getByTestId('inspect-reference').click();
  await v.page.getByTestId('panel-manifest').waitFor({ timeout: 15_000 });
}

async function checkRegistry(v: VerifierSession): Promise<void> {
  await v.page.getByTestId('check-registry').click();
  await v.page.waitForTimeout(250);
  await v.page.getByText('Checking the registry…').waitFor({ state: 'hidden', timeout: 60_000 });
  await v.page.waitForTimeout(250);
}

describe('[verifier-registry-failures-and-public-report] registry trust, failures, history and the public report', () => {
  it('an Active receipt leaves an unset signer rule unknown and a rejecting rule rejected', async (context) => {
    const { s } = needSuite(context);
    const registry = LocalRegistry.of(s);
    const prepared = await registry.issued();
    const v = await VerifierSession.open(s, { allowRpc: true });
    try {
      await inspectReference(v, prepared.reference);
      await checkRegistry(v);
      expect(await lifecycle(v)).toMatch(/^Active at block/);
      expect(await v.text('label-registry')).toBe(
        'Registry identity matches the configured deployment',
      );
      // No rule was chosen: the reviewer named in the reference is not taken as accepted.
      expect(await v.text('label-signer')).toBe('Signer not evaluated');
      expect(await v.page.getByTestId('no-signer-policy').count()).toBe(1);

      // A rule that does not include this reviewer: rejected, even though the receipt is Active.
      await v.page.getByTestId('signer-input').fill(accounts.stranger.address);
      await checkRegistry(v);
      expect(await lifecycle(v)).toMatch(/^Active at block/);
      expect(await v.text('label-signer')).toBe('Signer does not meet your selected rule');

      // Control: the rule that includes the reviewer is accepted.
      await v.page.getByTestId('signer-input').fill(accounts.reviewer.address);
      await checkRegistry(v);
      expect(await v.text('label-signer')).toBe('Signer meets your selected rule');
    } finally {
      await v.close();
    }
  });

  it('a receipt naming another registry or chain is untrusted: nothing is read and nothing is reported as Active', async (context) => {
    const { s } = needSuite(context);
    const prepared = await LocalRegistry.of(s).issued();
    const v = await VerifierSession.open(s, { allowRpc: true });
    try {
      for (const [name, tamper] of [
        [
          'another registry address',
          { registryAddress: flipLast(prepared.reference.registryAddress) },
        ],
        ['another chain', { chainId: '1' }],
      ] as const) {
        await inspectReference(v, { ...prepared.reference, ...tamper });
        await checkRegistry(v);
        expect(await v.text('label-registry'), name).not.toMatch(
          /matches the configured deployment/,
        );
        expect(await lifecycle(v), name).toMatch(/Registry status unknown/);
        expect(await lifecycle(v), name).not.toMatch(/Active/);
        expect(await v.text('issues'), name).toMatch(
          /names a registry other than the configured one/,
        );
        expect(v.afterLoad.length, name).toBe(0);
      }
    } finally {
      await v.close();
    }
  });

  it('a failed RPC is unknown, a failed refresh keeps the last status labelled as of its time, and mixed checkpoints are rejected', async (context) => {
    const { s } = needSuite(context);
    const prepared = await LocalRegistry.of(s).issued();
    const mode = { current: 'down' as RpcMode, pinned: 0 };
    const v = await VerifierSession.open(s, { allowRpc: true, rpcHandler: rpcRoute(mode) });
    try {
      // Outage with nothing observed before: unknown, with no "as of" and no Active.
      await inspectReference(v, prepared.reference);
      await checkRegistry(v);
      expect(await lifecycle(v)).toMatch(/Registry status unknown/);
      expect(await v.text('issues')).toMatch(/could not be reached|refused the request/);
      expect(await v.page.getByTestId('as-of').count()).toBe(0);

      // A good read, then an outage on refresh: the earlier status is kept, labelled and dated.
      mode.current = 'pass';
      await checkRegistry(v);
      expect(await lifecycle(v)).toMatch(/^Active at block/);
      mode.current = 'down';
      await checkRegistry(v);
      expect(await lifecycle(v)).toMatch(/Registry status unknown/);
      expect(await v.text('as-of')).toMatch(
        /The refresh failed. The last status read was Active at block \d+, as of /,
      );

      // Recovery: a later good read replaces it.
      mode.current = 'pass';
      await checkRegistry(v);
      expect(await lifecycle(v)).toMatch(/^Active at block/);
      expect(await v.page.getByTestId('as-of').count()).toBe(0);

      // Mixed checkpoints: the block changes under the read, so nothing is accepted.
      await inspectReference(v, prepared.reference);
      mode.current = 'flip-hash';
      mode.pinned = 0;
      await checkRegistry(v);
      expect(await lifecycle(v)).toMatch(/Registry status unknown/);
      expect(await v.text('issues')).toMatch(
        /block changed during the read, so nothing was accepted/,
      );
    } finally {
      await v.close();
    }
  });

  it('revoked and superseded receipts are reported as such; a successor stays unverified without its own files; successor traversal is bounded', async (context) => {
    const { s } = needSuite(context);
    const registry = LocalRegistry.of(s);
    const v = await VerifierSession.open(s, { allowRpc: true });
    try {
      // Revoked.
      const revoked = await registry.issued();
      await registry.revoke(revoked);
      await inspectReference(v, revoked.reference);
      await checkRegistry(v);
      expect(await lifecycle(v)).toMatch(/^Revoked at block/);

      // Superseded, with one reciprocal successor.
      const original = await registry.issued();
      const replacement = await registry.issued('legal-revised', original);
      await inspectReference(v, original.reference);
      await checkRegistry(v);
      expect(await lifecycle(v)).toMatch(/^Superseded at block/);
      const history = v.page.getByTestId('history');
      expect(await history.locator('li').count()).toBe(1);
      expect(await history.innerText()).toContain(replacement.reference.commitment);
      expect(await history.innerText()).toMatch(/— active\. Its files have not been checked here/);
      // The successor on its own is only a reference: it claims nothing about files.
      await inspectReference(v, replacement.reference);
      expect(await v.text('label-manifest')).toBe('Files not supplied');
      expect(await v.text('label-artifacts')).toBe('Artifacts not supplied');

      // Bounded traversal on a real eleven-receipt replacement chain.
      let previous = await registry.issued();
      const head = previous;
      for (let index = 0; index < 10; index += 1)
        previous = await registry.issued('legal-revised', previous);
      await inspectReference(v, head.reference);
      await checkRegistry(v);
      expect(await lifecycle(v)).toMatch(/^Superseded at block/);
      expect(await v.page.getByTestId('history-incomplete').count()).toBe(1);
      expect(await v.page.getByTestId('history').locator('li').count()).toBe(8);
      expect(await v.text('issues')).toMatch(/More than eight replacements follow/);
    } finally {
      await v.close();
    }
  });

  it('the public report download holds no private digest, opening, label, artifact content, endpoint or credential', async (context) => {
    const { s, a } = needSuite(context);
    const v = await VerifierSession.open(s, { allowRpc: true });
    try {
      await v.file(a.exportPath);
      await v.page.getByTestId('panel-manifest').waitFor({ timeout: 30_000 });
      await v.check(a.reference);
      await expect
        .poll(() => v.text('label-artifacts'), { timeout: 30_000 })
        .toMatch(/Every committed artifact matches/);
      await v.page
        .getByTestId('signer-input')
        .fill((JSON.parse(a.reference) as { reviewerAddress: string }).reviewerAddress);
      await checkRegistry(v);
      expect(await lifecycle(v)).toMatch(/^Active at block/);
      const downloading = v.page.waitForEvent('download');
      await v.page.getByTestId('download').click();
      const download = await downloading;
      expect(download.suggestedFilename()).toBe('proof-of-review-verification-result.json');
      const path = join(scratch, 'verification-result.json');
      await download.saveAs(path);
      const text = readFileSync(path, 'utf8');
      const report = JSON.parse(text) as Record<string, unknown>;
      expect(report.schema).toBe('lexaegis.verification-result.v1');
      expect(report.notice).toMatch(/Unsigned observation. It is not a certificate/);
      expect(Object.keys(report).sort()).toEqual(
        [
          'checkpoint',
          'checks',
          'expectedReference',
          'history',
          'issues',
          'mode',
          'notice',
          'observedAt',
          'profileSemantics',
          'referenceOrigin',
          'registryPolicyId',
          'schema',
          'signerPolicyId',
        ].sort(),
      );
      expect(mentionsPrivate(text, a)).toEqual([]);
      expect(text).not.toMatch(
        /127\.0\.0\.1|localhost|https?:\/\/|@|apikey|api-key|authorization|bearer/i,
      );
      expect(text).not.toMatch(
        /"(opening|blindingNonce|manifest|artifacts|sha256|label|rpcUrl|endpoint)"/,
      );
      expect((report.checks as Record<string, string>).chainStatus).toBe('active');
      // The verification result is not a review package: the verifier refuses it as input.
      await v.page.getByTestId('clear').click();
      await v.file(path);
      expect(await v.settle()).toBe('failure');
    } finally {
      await v.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Case 5: the export preview, the explicit handoff and persistence.

describe('[verifier-export-handoff-and-persistence] exporting is explicit, nothing is handed over automatically, and a saved file stays saved', () => {
  it('the export preview discloses before anything downloads, and cancelling downloads nothing', async (context) => {
    const { a } = needSuite(context);
    const page = a.page;
    const requests: Request[] = [];
    const downloads: string[] = [];
    const onRequest = (request: Request) => requests.push(request);
    const onDownload = (download: { suggestedFilename(): string }) =>
      downloads.push(download.suggestedFilename());
    page.on('request', onRequest);
    page.on('download', onDownload);
    try {
      await page
        .getByRole('button', { name: /^Export readable review/ })
        .first()
        .click();
      const preview = page.getByRole('group', { name: 'Export preview' });
      await preview.waitFor({ timeout: 15_000 });
      expect(await preview.innerText()).toMatch(/discloses private material/i);
      await page.waitForTimeout(1_500);
      expect(downloads, 'opening the preview downloads nothing').toEqual([]);
      await preview.getByRole('button', { name: 'Cancel' }).click();
      await preview.waitFor({ state: 'detached', timeout: 10_000 });
      await page.waitForTimeout(1_000);
      expect(downloads, 'cancelling downloads nothing').toEqual([]);
      // No private value in any URL or request the app made while the preview was open.
      const origin = new URL(page.url()).origin;
      for (const request of requests) {
        expect(new URL(request.url()).origin, request.url()).toBe(origin);
        expect(mentionsPrivate(`${request.url()}\n${request.postData() ?? ''}`, a)).toEqual([]);
      }
      expect(mentionsPrivate(page.url(), a)).toEqual([]);
    } finally {
      page.off('request', onRequest);
      page.off('download', onDownload);
    }
  });

  it('the handoff to the verifier is explicit and carries nothing: no automatic upload, no private URL field, no postMessage or window handoff', async (context) => {
    const { a } = needSuite(context);
    const page = a.page;
    const handoff = page.getByTestId('verifier-handoff');
    await handoff.waitFor({ timeout: 15_000 });
    const text = await handoff.innerText();
    expect(text).toMatch(/Nothing is sent to the verifier automatically/);
    expect(text).toMatch(/choose the downloaded file yourself/);
    // Every link and frame the app renders: none carries a private value or targets the verifier with data.
    const links = await page.evaluate(() => ({
      hrefs: [...document.querySelectorAll('a[href]')].map(
        (node) => (node as HTMLAnchorElement).href,
      ),
      frames: document.querySelectorAll('iframe, embed, object').length,
      handoff: (window as unknown as { __handoff: [string, string][] }).__handoff,
    }));
    expect(links.frames).toBe(0);
    for (const href of links.hrefs) {
      expect(mentionsPrivate(href, a), href).toEqual([]);
      if (href.startsWith(verifierOrigin)) {
        const url = new URL(href);
        expect(url.search + url.hash, 'a verifier link carries no data').toBe('');
      }
    }
    // Neither the export nor the journey ever called window.open or posted a message to another window.
    expect(links.handoff.filter(([kind]) => kind === 'open')).toEqual([]);
    expect(
      links.handoff.filter(
        ([kind, target]) => kind === 'postMessage' && (target === '*' || target.startsWith('http')),
      ),
    ).toEqual([]);
    // In this build the verifier address is not configured, so there is no link at all: the handoff is
    // the user opening the verifier by hand. The configured-link wording is covered by apps/web tests.
    expect(await page.getByTestId('open-verifier').count()).toBe(0);
    expect(text).toMatch(/verifier address is not configured here/);
  });

  it('locking and clearing the originating app cannot retract a downloaded file, and the verifier persists nothing and reuses no credentials', async (context) => {
    const { s, a } = needSuite(context);
    const before = readFileSync(a.exportPath, 'utf8');
    const lock = a.page.getByRole('button', { name: 'Lock vault' }).first();
    if ((await lock.count()) > 0) await lock.click();
    await clearOriginState(a.page);
    await a.page.reload();
    expect(readFileSync(a.exportPath, 'utf8'), 'the downloaded bytes are unchanged').toBe(before);

    const v = await VerifierSession.open(s);
    try {
      await v.file(a.exportPath);
      await v.page.getByTestId('panel-manifest').waitFor({ timeout: 30_000 });
      await v.check(a.reference);
      await expect
        .poll(() => v.text('label-artifacts'), { timeout: 30_000 })
        .toMatch(/Every committed artifact matches/);
      const stored = await v.page.evaluate(async () => ({
        local: localStorage.length,
        session: sessionStorage.length,
        databases: (await indexedDB.databases()).length,
        caches: (await caches.keys()).length,
        cookie: document.cookie,
      }));
      expect(stored).toEqual({ local: 0, session: 0, databases: 0, caches: 0, cookie: '' });
      expect(await v.context.cookies()).toEqual([]);
      expect(v.afterLoad.length).toBe(0);
    } finally {
      await v.close();
    }
  });
});
