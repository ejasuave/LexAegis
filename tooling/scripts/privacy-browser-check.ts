/**
 * pnpm test:privacy:browser
 *
 * Disclosure-boundary check on the complete LOCAL SYNTHETIC journeys. It re-runs the two existing
 * scripted browser journeys (HUD and human approval; Aegis assistant) with an observation layer
 * attached, then applies the destination-and-field disclosure matrix to everything observed and
 * scans the production assets those runs built.
 *
 * Everything is test-owned: synthetic PDFs, a CDP VIRTUAL authenticator, a throwaway PostgreSQL and
 * S3-compatible server, a SCRIPTED loopback provider and a SCRIPTED chain. No real credential is
 * instrumented, no real provider or network is contacted, and the temporary observation files
 * (which hold the synthetic secret canaries) are deleted before this exits. The retained report
 * names canaries by ID and class, never by value.
 *
 * Chapter 12's full validation run has not happened yet. This reuses the Chapter 10 and Chapter 9
 * journeys and is recorded as such; it does not mark Chapter 12 complete.
 *
 * Bounded: it does not prove the absence of every encoding, side channel or same-origin compromise,
 * and it cannot see a real provider's or host's logs.
 *
 *   --keep                 keep the temporary observations (debugging only; they hold canaries)
 *   --no-record            do not write evidence
 *   --journey <id>         run one journey only (partial: never recorded)
 *   --assets-only          scan the assets already built, run no journey (partial: never recorded)
 *   --report <file>        also write the report to this file
 *   --extra-canaries <file>  JSON list of further synthetic canaries (the negative controls'
 *                          markers: see tooling/scripts/privacy-negative-controls.ts)
 */
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
import { join, relative } from 'node:path';
import { keccak256, toBytes } from 'viem';
import { z } from 'zod';
import { recordEvidence, writeAtomic } from '../src/evidence-writer';
import {
  analyse,
  canarySchema,
  observationsSchema,
  type Analysis,
  type Observations,
} from '../src/privacy/analyse';
import {
  readAssets,
  scanBrowserAssets,
  scanServerAssets,
  type AssetFinding,
  type PublicSource,
} from '../src/privacy/assets';
import type { Canary } from '../src/privacy/canary';
import { runBounded } from '../src/privacy/run-bounded';
import { ROOT, gitRevision, stamp } from './lib';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const keep = args.includes('--keep');
const onlyJourney = option('--journey');
const assetsOnly = args.includes('--assets-only');
/** Anything less than both journeys and every asset scope is a partial run and is never recorded. */
const partial = assetsOnly || onlyJourney !== undefined;
const skipRecord = args.includes('--no-record') || partial;
const reportOut = option('--report');
const extraCanariesFile = option('--extra-canaries');
const extraCanaries: Canary[] =
  extraCanariesFile === undefined
    ? []
    : z.array(canarySchema).parse(JSON.parse(readFileSync(extraCanariesFile, 'utf8')));
const WEB = join(ROOT, 'apps', 'web');
/**
 * One journey builds the application and drives it in about two minutes. Past this limit the whole
 * process tree it started is stopped and the check fails with JOURNEY_TIMED_OUT: it never waits on.
 */
const JOURNEY_TIMEOUT_MS = 8 * 60_000;
const JOURNEYS = [
  { id: 'hud', script: 'hud-browser-check.ts', dist: '.next-hud-check', minSnapshots: 7 },
  {
    id: 'assistant',
    script: 'assistant-browser-check.ts',
    dist: '.next-assistant-check',
    minSnapshots: 7,
  },
] as const;

/** Server-only configuration names: a browser asset must not even name one. */
const SERVER_ENV_NAMES = [
  ...readFileSync(join(ROOT, '.env.example'), 'utf8')
    .split('\n')
    .map((line) => /^([A-Z][A-Z0-9_]+)=/.exec(line)?.[1] ?? '')
    .filter((name) => name !== '' && !name.startsWith('NEXT_PUBLIC_') && !name.startsWith('VITE_')),
  'ASSISTANT_TEST_PROVIDER_URL',
  'LEXAEGIS_TEST_MODE',
  'ERC8004_OPERATOR_KEY',
  'AGENT_IDENTITY_RPC_URL',
];
/** Text that exists only in the private synthetic fixtures. */
const PRIVATE_FIXTURE_MARKERS = [
  'discrepancy-2000.pdf',
  'Northwind Demo Ltd',
  'SYNTHETIC SETTLEMENT AGREEMENT',
];
/** Synthetic server-side credentials every journey runs with (apps/web/src/test-support/local-s3.ts). */
const STATIC_SERVER_CANARIES: Canary[] = [
  { id: 'storage-secret', class: 'storage_credential', kind: 'text', value: 'lexlocalsecret' },
  { id: 'storage-access-key', class: 'storage_credential', kind: 'text', value: 'lexlocalaccess' },
];
/**
 * The value the server sends to the SCRIPTED provider in place of a key. It is a documented
 * non-secret literal in apps/web/src/server/assistant/config.ts, so finding it in the server bundle
 * is expected and is not a leaked secret. No browser asset may hold it: it is still a canary there.
 */
const PROVIDER_PLACEHOLDER: Canary = {
  id: 'provider-placeholder',
  class: 'provider_credential',
  kind: 'text',
  value: 'scripted-test-no-key',
};

/**
 * Next.js writes a `routeCache.key` of the form `/route-cache/APP_PAGE/<64 hex>/$/<route>` into the
 * prerender metadata (`.meta`) of each prerendered route. It identifies a build output, not a
 * secret. Only a value in exactly that field of that file is classified this way.
 */
function routeCacheKeys(root: string): PublicSource[] {
  const keys: string[] = [];
  for (const file of readAssets(root, ['.meta'])) {
    try {
      const key = (JSON.parse(file.text) as { routeCache?: { key?: unknown } }).routeCache?.key;
      const match =
        typeof key === 'string'
          ? /^\/route-cache\/APP_(?:PAGE|ROUTE)\/([0-9a-f]{64})\//.exec(key)
          : null;
      if (match?.[1] !== undefined) keys.push(match[1]);
    } catch {
      // Not JSON: nothing is classified from it.
    }
  }
  return keys.length === 0
    ? []
    : [{ label: 'Next.js route-cache key in prerender metadata', text: keys.join('\n') }];
}

function publicSources(): PublicSource[] {
  const sources: PublicSource[] = [
    {
      // bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1), computed here, not copied.
      label: 'EIP-1967 implementation storage slot (public standard constant)',
      text: (BigInt(keccak256(toBytes('eip1967.proxy.implementation'))) - 1n)
        .toString(16)
        .padStart(64, '0'),
    },
  ];
  const store = join(ROOT, 'node_modules', '.pnpm');
  for (const directory of existsSync(store) ? readdirSync(store) : []) {
    const match =
      /^(@noble\+curves|@noble\+hashes|@scure\+bip32|@scure\+base|viem|ox|abitype|@category-labs\+mera)@/.exec(
        directory,
      );
    if (match === null) continue;
    const name = (match[1] ?? '').replace('+', '/');
    const texts: string[] = [];
    const walk = (path: string): void => {
      if (!existsSync(path)) return;
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(child);
        } else if (/\.(?:js|mjs|cjs|ts)$/.test(entry.name) && statSync(child).size < 5_000_000) {
          texts.push(readFileSync(child, 'utf8').toLowerCase());
        }
      }
    };
    walk(join(store, directory, 'node_modules', name));
    sources.push({ label: `public dependency ${name}`, text: texts.join('\n') });
  }
  for (const file of [
    'docs/SPEC.md',
    'contracts/deployments/monad-testnet.json',
    'contracts/artifacts/registry-v1.json',
    'packages/protocol/schemas/v1/protocol-descriptor.json',
    'apps/web/src/features/account/derivation-profile.ts',
    'docs/erc8004-availability.md',
    'docs/DEPLOYMENTS.md',
  ]) {
    if (existsSync(join(ROOT, file)))
      sources.push({ label: file, text: readFileSync(join(ROOT, file), 'utf8').toLowerCase() });
  }
  return sources;
}

const work = mkdtempSync(join(tmpdir(), 'lexaegis-privacy-'));
const startedAt = new Date();
const failures: string[] = [];
const journeyReports: Record<string, unknown>[] = [];
const serverCanaries = [...STATIC_SERVER_CANARIES];

try {
  if (onlyJourney !== undefined && !JOURNEYS.some((journey) => journey.id === onlyJourney)) {
    throw new Error(`unknown journey: ${onlyJourney}`);
  }
  const selected = JOURNEYS.filter(
    (journey) => onlyJourney === undefined || journey.id === onlyJourney,
  );
  for (const journey of assetsOnly ? [] : selected) {
    console.log(`\n=== journey: ${journey.id} (observed) ===`);
    const run = await runBounded(
      'pnpm',
      ['exec', 'tsx', join('tooling', 'scripts', journey.script)],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          PRIVACY_OBSERVE_DIR: work,
          ...(journey.id === 'hud' && { HUD_EXPORT_OUT: join(work, 'export') }),
        },
        timeoutMs: JOURNEY_TIMEOUT_MS,
      },
    );
    const lines = run.output.trim().split('\n');
    const tail = lines.slice(-1)[0] ?? '';
    for (const line of lines.filter((item) => item.startsWith('FAIL'))) console.log(line);
    console.log(`${tail} [${String(Math.round(run.durationMs / 1000))} s]`);
    if (run.timedOut) {
      failures.push(
        `JOURNEY_TIMED_OUT ${journey.id} (stopped after ${String(JOURNEY_TIMEOUT_MS / 60_000)} min; last output: ${tail.slice(0, 120)})`,
      );
    } else if (run.status !== 0) {
      failures.push(`JOURNEY_FAILED ${journey.id} (exit ${String(run.status)})`);
    }

    const file = join(work, journey.id, 'observations.json');
    if (!existsSync(file)) {
      failures.push(`OBSERVATIONS_MISSING ${journey.id}`);
      journeyReports.push({
        journey: journey.id,
        journeyExit: run.status,
        timedOut: run.timedOut,
        observed: false,
      });
      continue;
    }
    const observed: Observations = observationsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    // The readable export the HUD journey downloads names what must stay private elsewhere.
    const exportFile = join(work, 'export', 'review-export.json');
    if (journey.id === 'hud' && existsSync(exportFile)) {
      const exported = JSON.parse(readFileSync(exportFile, 'utf8')) as {
        opening?: {
          blindingNonce?: string;
          manifest?: { artifacts?: { id: string; sha256: string }[] };
        };
      };
      const nonce = exported.opening?.blindingNonce ?? '';
      if (/^0x[0-9a-f]{64}$/.test(nonce))
        observed.canaries.push({
          id: 'opening-blinding-nonce',
          class: 'opening_nonce',
          kind: 'bytes',
          value: nonce.slice(2),
        });
      for (const [index, artifact] of (exported.opening?.manifest?.artifacts ?? []).entries()) {
        if (/^0x[0-9a-f]{64}$/.test(artifact.sha256)) {
          observed.canaries.push({
            id: `artifact-sha256-${String(index + 1)}`,
            class: 'artifact_hash',
            kind: 'bytes',
            value: artifact.sha256.slice(2),
          });
        }
      }
    }
    for (const canary of observed.canaries) {
      if (
        canary.class === 'database_credential' &&
        !serverCanaries.some((item) => item.value === canary.value)
      )
        serverCanaries.push(canary);
    }

    for (const canary of extraCanaries) {
      if (!observed.canaries.some((item) => item.id === canary.id)) observed.canaries.push(canary);
    }

    const result: Analysis = analyse(observed);
    const classes = [...new Set(observed.canaries.map((canary) => canary.class))].sort();
    const required: [string, number, number][] = [
      ['storageWrites', result.coverage.storageWrites ?? 0, 1],
      ['snapshots', result.coverage.snapshots ?? 0, journey.minSnapshots],
      ['requests', result.coverage.requests ?? 0, 10],
      ['responses', result.coverage.responses ?? 0, 5],
      ['serverLogBytes', result.coverage.serverLogBytes ?? 0, 1],
      ['databaseBytes', result.coverage.databaseBytes ?? 0, 10],
      ['storedObjects', result.coverage.storedObjects ?? 0, 1],
      [
        'prf_output canaries',
        observed.canaries.filter((canary) => canary.class === 'prf_output').length,
        1,
      ],
      [
        'signing_key canaries',
        observed.canaries.filter((canary) => canary.class === 'signing_key').length,
        1,
      ],
      [
        'session_cookie canaries',
        observed.canaries.filter((canary) => canary.class === 'session_cookie').length,
        1,
      ],
      ...(journey.id === 'hud'
        ? ([
            [
              'opening_nonce canaries',
              observed.canaries.filter((canary) => canary.class === 'opening_nonce').length,
              1,
            ],
            [
              'artifact_hash canaries',
              observed.canaries.filter((canary) => canary.class === 'artifact_hash').length,
              1,
            ],
          ] as [string, number, number][])
        : ([
            [
              'provider requests',
              (JSON.parse(observed.providerRequests) as { requests: unknown[] }).requests.length,
              1,
            ],
          ] as [string, number, number][])),
    ];
    const missing = required
      .filter(([, count, minimum]) => count < minimum)
      .map(([layer, count, minimum]) => `${layer} (${String(count)} < ${String(minimum)})`);
    for (const layer of missing) failures.push(`LAYER_NOT_OBSERVED ${journey.id} ${layer}`);
    for (const violation of result.violations) {
      failures.push(
        `${violation.rule} ${journey.id} ${violation.destination} ${violation.canaryClass ?? '-'} ${violation.canaryId ?? '-'} @ ${violation.where}`,
      );
    }
    console.log(
      `${journey.id}: ${String(result.violations.length)} violation(s); ${String(observed.canaries.length)} canaries in ${String(classes.length)} classes; ${String(result.coverage.storageWrites ?? 0)} storage writes, ${String(result.coverage.snapshots ?? 0)} snapshots, ${String(result.coverage.requests ?? 0)} requests, ${String(result.coverage.responses ?? 0)} API responses, ${String(result.coverage.storedObjects ?? 0)} stored objects, ${String(result.coverage.serverLogBytes ?? 0)} log bytes`,
    );
    for (const line of observed.unobserved.filter((item) => item.startsWith('response body of')))
      console.log(`  not read: ${line}`);
    journeyReports.push({
      journey: journey.id,
      journeyExit: run.status,
      journeySummary: tail,
      consentedDisclosure: observed.consentedDisclosure,
      canaryClasses: classes,
      canaries: observed.canaries.map(({ id, class: canaryClass, kind }) => ({
        id,
        class: canaryClass,
        kind,
      })),
      phases: observed.snapshots.map((snapshot) => snapshot.phase),
      coverage: result.coverage,
      layersBelowMinimum: missing,
      unobserved: observed.unobserved,
      allowedHits: result.allowedHits,
      violations: result.violations,
      storageKeysWritten: [
        ...new Set(
          observed.storageWrites.map((write) =>
            `${write.kind}:${write.key.split('/')[0] ?? ''}`.slice(0, 80),
          ),
        ),
      ].sort(),
      cookieNames: [
        ...new Set(
          observed.snapshots.flatMap((snapshot) =>
            snapshot.cookies.map(
              (cookie) => `${cookie.name}${cookie.httpOnly ? ' (HttpOnly)' : ''}`,
            ),
          ),
        ),
      ].sort(),
      routesRequested: [
        ...new Set(
          observed.requests.map(
            (request) =>
              `${request.method} ${(request.url.slice(observed.origin.length).split('?')[0] ?? '').replace(/0x[0-9a-f]{40,64}/g, '0x…').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>')}`,
          ),
        ),
      ]
        .sort()
        .slice(0, 80),
    });
  }

  // ---- Production assets built by those runs -------------------------------------------------
  console.log('\n=== production assets ===');
  const sources = publicSources();
  const assetFindings: (AssetFinding & { scope: string })[] = [];
  const assetSummary: Record<string, unknown>[] = [];
  const browserOptions = {
    serverEnvNames: SERVER_ENV_NAMES,
    canaries: [...serverCanaries, PROVIDER_PLACEHOLDER, ...extraCanaries],
    privateFixtureMarkers: PRIVATE_FIXTURE_MARKERS,
    publicSources: sources,
  };
  const scanBrowser = (
    scope: string,
    root: string,
    extensions: string[],
    options = browserOptions,
  ) => {
    if (!existsSync(root)) {
      failures.push(`ASSETS_MISSING ${scope}`);
      assetSummary.push({ scope, status: 'NOT YET: not built' });
      return;
    }
    const files = readAssets(root, extensions);
    const scanned = scanBrowserAssets(files, options);
    for (const finding of scanned.findings) assetFindings.push({ scope, ...finding });
    const reasons: Record<string, number> = {};
    for (const item of scanned.classified) reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
    assetSummary.push({
      scope,
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.text.length, 0),
      sourceMaps: files.filter((file) => file.name.endsWith('.map')).map((file) => file.name),
      keyShapedClassified: reasons,
      findings: scanned.findings.length,
    });
    console.log(
      `${scope}: ${String(files.length)} files, ${String(scanned.findings.length)} finding(s), ${String(scanned.classified.length)} key-shaped value(s) classified as public`,
    );
  };
  for (const journey of selected) {
    const dist = join(WEB, journey.dist);
    // What a browser can download: static chunks, styles and any source map beside them...
    scanBrowser(`web client assets (${journey.dist}/static)`, join(dist, 'static'), [
      '.js',
      '.mjs',
      '.css',
      '.map',
      '.json',
      '.html',
      '.txt',
    ]);
    // ...and the HTML and component payloads the server emits for prerendered routes.
    scanBrowser(
      `web emitted HTML and payloads (${journey.dist}/server/app)`,
      join(dist, 'server', 'app'),
      ['.html', '.rsc', '.meta', '.body'],
      {
        ...browserOptions,
        publicSources: [...sources, ...routeCacheKeys(join(dist, 'server', 'app'))],
      },
    );
    // The server bundle is inspected separately, for literal secret values only.
    const server = readAssets(join(dist, 'server'), ['.js', '.mjs', '.json']);
    const serverFindings = scanServerAssets(server, [...serverCanaries, ...extraCanaries]);
    for (const finding of serverFindings)
      assetFindings.push({ scope: `web server bundle (${journey.dist}/server)`, ...finding });
    assetSummary.push({
      scope: `web server bundle (${journey.dist}/server)`,
      files: server.length,
      findings: serverFindings.length,
      rule: 'literal secret values only; reading configuration at run time is not a client leak',
      notCanaryHere: `${PROVIDER_PLACEHOLDER.id}: the documented non-secret placeholder for the scripted provider (still rejected in browser assets)`,
    });
    console.log(
      `web server bundle (${journey.dist}/server): ${String(server.length)} files, ${String(serverFindings.length)} literal-secret finding(s)`,
    );
  }
  // Packed browser entry points and the standalone verifier. They belong to the full run: a
  // single-journey run checks that journey and the assets it built, nothing else.
  for (const [scope, root] of onlyJourney !== undefined
    ? []
    : ([
        [
          'packed entry points: @lexaegis/protocol (packages/protocol/dist)',
          join(ROOT, 'packages', 'protocol', 'dist'),
        ],
        [
          'packed entry points: @lexaegis/sdk (packages/sdk/dist)',
          join(ROOT, 'packages', 'sdk', 'dist'),
        ],
        ['standalone verifier (apps/verifier/dist)', join(ROOT, 'apps', 'verifier', 'dist')],
      ] as const)) {
    scanBrowser(scope, root, ['.js', '.mjs', '.css', '.map', '.html', '.json']);
  }
  for (const finding of assetFindings)
    failures.push(`${finding.rule} ${finding.scope} ${finding.file}: ${finding.detail}`);

  const finishedAt = new Date();
  const outcome = failures.length === 0 ? 'pass' : 'fail';
  const revision = gitRevision();
  const report = {
    schema: 'lexaegis.evidence.privacy-boundaries.v1',
    note: 'Local synthetic journeys only: virtual authenticator, scripted provider, scripted chain, throwaway database and object store. Bounded detection of planted canaries in a fixed set of encodings. Not evidence about a real provider, host or device, not Chapter 12, and not proof that no leak exists.',
    command: 'pnpm test:privacy:browser',
    checkedAt: finishedAt.toISOString(),
    durationSeconds: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
    commit: revision.commit,
    dirtyWorktree: revision.dirtyWorktree,
    outcome,
    scope: partial
      ? `partial: ${assetsOnly ? 'assets only' : `journey ${onlyJourney ?? ''} and its assets`}`
      : 'both journeys and every asset scope',
    failures,
    journeys: journeyReports,
    assets: assetSummary,
    assetFindings,
    serverEnvNamesChecked: SERVER_ENV_NAMES.length,
  };
  const path = join(
    ROOT,
    'docs',
    'evidence',
    `chapter17-privacy-boundaries-${finishedAt.toISOString().slice(0, 10)}.json`,
  );
  if (reportOut !== undefined) writeFileSync(reportOut, `${JSON.stringify(report, null, 2)}\n`);
  if (!skipRecord) {
    // Through the repository's writer, so the evidence file is formatted like every other one.
    await writeAtomic(path, JSON.stringify(report));
    await recordEvidence({
      root: ROOT,
      results: [
        stamp({
          id: `privacy-boundaries-${finishedAt.toISOString().replace(/\D/g, '').slice(0, 14)}`,
          subject: 'privacy-boundaries',
          command: 'pnpm test:privacy:browser',
          evidenceClass: 'virtual_authenticator',
          outcome,
          reasonCodes: [
            'SYNTHETIC_DOCUMENTS_ONLY',
            'AUTHENTICATOR_MODE_VIRTUAL',
            'SCRIPTED_PROVIDER_AND_CHAIN',
            ...(outcome === 'pass' ? [] : ['VIOLATIONS_OR_MISSING_LAYERS']),
          ],
          evidenceRefs: [{ type: 'path', value: relative(ROOT, path) }],
          facts: {
            journeys: JOURNEYS.map((journey) => journey.id).join(','),
            failures: String(failures.length),
            chapter12: 'not run; this reuses the Chapter 9 and 10 journeys',
          },
          checkedAt: finishedAt.toISOString(),
        }),
      ],
    });
  }
  console.log(
    `\nprivacy boundaries: ${outcome.toUpperCase()} (${String(failures.length)} failure(s))${skipRecord ? '' : ` -> ${relative(ROOT, path)}`}`,
  );
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  process.exitCode = outcome === 'pass' ? 0 : 1;
} finally {
  // The observations hold the synthetic secret canaries: they do not outlive the check.
  if (keep) console.error(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
