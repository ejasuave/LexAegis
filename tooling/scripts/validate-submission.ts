/**
 * pnpm submission:validate [--refresh-hashes] [--check-links]
 *
 * Validates the form-ready submission package. Every check is pass, fail, blocked or unknown;
 * nothing is assumed. Overall result is `ready_for_submission` only when every check passes.
 *
 *   --refresh-hashes  rewrites the SHA-256 values of local text assets in submission/assets.json
 *   --check-links     performs bounded anonymous GET requests (no cookies, no credentials, no forms,
 *                     redirects not followed) against the recorded public links
 *
 * Exit codes: 0 ready; 1 a check failed; 3 blocked or unknown items remain.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ROOT } from './lib';

type State = 'pass' | 'fail' | 'blocked' | 'unknown';
const results: { id: string; state: State; detail: string }[] = [];
const add = (id: string, state: State, detail: string): void => {
  results.push({ id, state, detail });
};
const file = (path: string): string => join(ROOT, path);
const readJson = (path: string): unknown => JSON.parse(readFileSync(file(path), 'utf8'));
const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

const link = z.strictObject({
  url: z.string().nullable(),
  state: z.enum(['ready', 'blocked', 'missing', 'unpublished', 'unknown']),
  reason: z.string().optional(),
});
const projectSchema = z.strictObject({
  schema: z.literal('lexaegis.submission-project.v1'),
  version: z.literal(1),
  preparedAt: z.string(),
  fieldLimits: z.strictObject({
    status: z.enum(['unverified', 'official_verified']),
    note: z.string(),
  }),
  name: z.string().min(1),
  track: z.string().min(1),
  summary: z.string().min(1),
  problem: z.string().min(1),
  solution: z.string().min(1),
  technical: z.array(z.string()).min(1),
  team: z.strictObject({
    status: z.enum(['not_supplied', 'supplied']),
    note: z.string().optional(),
    members: z.array(z.string()).optional(),
  }),
  adoption: z.strictObject({
    externalTrials: z.string(),
    tractionLog: z.string(),
    source: z.string(),
  }),
  judging: z.strictObject({
    technicalExecution: z.string(),
    designAndDeveloperExperience: z.string(),
    originalityAndTrackInsight: z.string(),
    founderAndMarketReadiness: z.string(),
    tractionAndPathForward: z.string(),
  }),
  limitations: z.array(z.string()),
  nextSteps: z.array(z.string()),
  links: z.strictObject({
    repository: link,
    application: link,
    verifier: link,
    technicalDemo: link,
    pitch: link,
    qwenArticle: link,
  }),
  contract: z.strictObject({
    network: z.string(),
    chainId: z.literal(10143),
    registry: z.string().regex(/^0x[0-9a-f]{40}$/),
    explorerSourceVerification: z.string(),
    record: z.string(),
  }),
  logo: z.strictObject({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
});
const assetsSchema = z.strictObject({
  schema: z.literal('lexaegis.release-assets.v1'),
  version: z.literal(1),
  note: z.string(),
  assets: z.array(
    z.strictObject({
      id: z.string(),
      path: z.string(),
      kind: z.enum(['logo', 'text', 'video', 'image']),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      publicUrl: z.string().nullable(),
    }),
  ),
  missing: z.array(z.strictObject({ id: z.string(), state: z.string(), reason: z.string() })),
});
const BOUNTIES = [
  'Best Mera-Powered UX on Monad',
  'Mera: One Passkey, Many Keys',
  'Best Use of Envio',
  'Best Builds with Qwen 3.8 Max',
  'Best Projects using Alchemy',
] as const;
const evidenceSchema = z.strictObject({
  schema: z.literal('lexaegis.sponsor-evidence.v1'),
  version: z.literal(1),
  recordedAt: z.string(),
  sourceCommit: z.string(),
  note: z.string(),
  bounties: z.array(
    z.strictObject({
      name: z.enum(BOUNTIES),
      ruleSource: z.strictObject({
        ref: z.string(),
        status: z.enum(['user_supplied', 'official_verified', 'unverified']),
      }),
      modules: z.array(z.string()).min(1),
      release: z.string(),
      evidenceClass: z.string(),
      links: z.array(z.string()),
      observed: z.string().min(1),
      limitations: z.array(z.string()),
      missing: z.array(z.string()),
      claimStatus: z.enum([
        'established',
        'partial_local_live_ingestion',
        'partial_provider_run_article_unpublished',
        'partial_live_rpc',
        'not_established',
        'withdrawn_gate_b_failed',
      ]),
    }),
  ),
});

/** Reads the movie duration (seconds) from an MP4's mvhd box; null when it cannot be measured. */
export function mp4DurationSeconds(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = (at: number): string => String.fromCharCode(...bytes.subarray(at + 4, at + 8));
  const scan = (start: number, end: number): number | null => {
    let at = start;
    while (at + 8 <= end) {
      const size = view.getUint32(at);
      if (size < 8 || at + size > end) return null;
      const name = type(at);
      if (name === 'moov') return scan(at + 8, at + size);
      if (name === 'mvhd') {
        const version = view.getUint8(at + 8);
        if (version === 1) {
          const scale = view.getUint32(at + 28);
          const duration = Number(view.getBigUint64(at + 32));
          return scale === 0 ? null : duration / scale;
        }
        const scale = view.getUint32(at + 20);
        const duration = view.getUint32(at + 24);
        return scale === 0 ? null : duration / scale;
      }
      at += size;
    }
    return null;
  };
  return scan(0, bytes.length);
}

function publicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      !/^(localhost|127\.|10\.|192\.168\.)/.test(url.hostname)
    );
  } catch {
    return false;
  }
}

async function anonymousGet(
  url: string,
): Promise<{ status: number | null; location: string | null; text: string }> {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      credentials: 'omit',
      headers: { accept: 'text/html,application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const text = (await response.text()).slice(0, 200_000);
    return { status: response.status, location: response.headers.get('location'), text };
  } catch {
    return { status: null, location: null, text: '' };
  }
}

async function main(): Promise<number> {
  const projectParsed = projectSchema.safeParse(readJson('submission/project.json'));
  add(
    'project.schema',
    projectParsed.success ? 'pass' : 'fail',
    projectParsed.success
      ? 'closed schema satisfied'
      : projectParsed.error.issues.map((i) => i.path.join('.')).join(', '),
  );
  const assetsParsed = assetsSchema.safeParse(readJson('submission/assets.json'));
  add(
    'assets.schema',
    assetsParsed.success ? 'pass' : 'fail',
    assetsParsed.success ? 'closed schema satisfied' : 'invalid',
  );
  const evidenceParsed = evidenceSchema.safeParse(readJson('submission/sponsor-evidence.json'));
  add(
    'evidence.schema',
    evidenceParsed.success ? 'pass' : 'fail',
    evidenceParsed.success
      ? 'closed schema satisfied'
      : evidenceParsed.error.issues.map((i) => i.path.join('.')).join(', '),
  );
  if (!projectParsed.success || !assetsParsed.success || !evidenceParsed.success) return finish();
  const project = projectParsed.data;
  const assets = assetsParsed.data;

  // Local assets: exact bytes.
  if (process.argv.includes('--refresh-hashes')) {
    for (const asset of assets.assets)
      if (asset.kind === 'text') asset.sha256 = sha256(readFileSync(file(asset.path)));
    writeFileSync(file('submission/assets.json'), `${JSON.stringify(assets, null, 2)}\n`);
  }
  for (const asset of assets.assets) {
    const ok =
      existsSync(file(asset.path)) && sha256(readFileSync(file(asset.path))) === asset.sha256;
    add(
      `asset.${asset.id}`,
      ok ? 'pass' : 'fail',
      ok
        ? 'exact bytes match'
        : 'missing or changed since hashed (use --refresh-hashes after review)',
    );
  }

  // Logo: signature, size, format.
  const logo = existsSync(file(project.logo.path)) ? readFileSync(file(project.logo.path)) : null;
  const png =
    logo !== null &&
    logo.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  add('logo.format', png ? 'pass' : 'fail', png ? 'PNG signature' : 'not a PNG');
  add(
    'logo.size',
    logo !== null && logo.length <= 3_000_000 ? 'pass' : 'fail',
    `${logo?.length ?? 0} bytes (limit 3,000,000)`,
  );
  add(
    'logo.hash',
    logo !== null && sha256(logo) === project.logo.sha256 ? 'pass' : 'fail',
    'project.json digest equals the file',
  );

  // Videos: a measured duration of a local file, or an explicit blocker.
  for (const [id, max] of [
    ['technical-demo-video', 180],
    ['pitch-video', 120],
  ] as const) {
    const recorded = assets.assets.find((asset) => asset.id === id);
    if (recorded === undefined) {
      add(`video.${id}`, 'blocked', 'no recording registered (missing)');
      continue;
    }
    const bytes = readFileSync(file(recorded.path));
    const seconds = mp4DurationSeconds(bytes);
    add(
      `video.${id}`,
      seconds === null ? 'unknown' : seconds <= max ? 'pass' : 'fail',
      seconds === null
        ? 'duration could not be measured'
        : `${seconds.toFixed(1)} s (limit ${String(max)} s)`,
    );
  }

  // Links: well-formed and public, then optionally live.
  for (const [name, entry] of Object.entries(project.links)) {
    if (entry.url === null) {
      add(`link.${name}`, 'blocked', entry.reason ?? entry.state);
      continue;
    }
    if (!publicHttpsUrl(entry.url)) {
      add(`link.${name}`, 'fail', 'not a safe public https URL');
      continue;
    }
    if (!process.argv.includes('--check-links')) {
      add(`link.${name}`, 'unknown', 'well-formed; not fetched (use --check-links)');
      continue;
    }
    const response = await anonymousGet(entry.url);
    const redirected = response.status !== null && response.status >= 300 && response.status < 400;
    const sameHost =
      redirected &&
      response.location !== null &&
      new URL(response.location, entry.url).host === new URL(entry.url).host;
    const loginWall =
      /sign in|log in|password/i.test(response.text.slice(0, 5000)) && name === 'repository';
    const ok = response.status === 200 && !loginWall;
    add(
      `link.${name}`,
      ok
        ? 'pass'
        : redirected && !sameHost
          ? 'fail'
          : response.status === 404 && name === 'repository'
            ? 'blocked'
            : 'fail',
      `HTTP ${response.status ?? 'unreachable'}${redirected ? ` redirect ${sameHost ? 'on the same host' : 'elsewhere'}` : ''}`,
    );
  }

  // Article: published means a public URL that carries the article title.
  const articleUrl = project.links.qwenArticle.url;
  if (articleUrl !== null && process.argv.includes('--check-links')) {
    const response = await anonymousGet(articleUrl);
    const title =
      readFileSync(file('submission/qwen-article.md'), 'utf8').split('\n')[0]?.replace(/^# /, '') ??
      '';
    add(
      'article.published',
      response.status === 200 &&
        response.text.includes(title.slice(0, 30)) &&
        !/not yet published/i.test(response.text)
        ? 'pass'
        : 'fail',
      `HTTP ${response.status ?? 'unreachable'}`,
    );
  } else add('article.published', 'blocked', 'draft only; no public URL');

  // Evidence completeness: every bounty must be established, not merely described.
  for (const bounty of evidenceParsed.data.bounties)
    add(
      `bounty.${bounty.name}`,
      bounty.claimStatus === 'established' && bounty.missing.length === 0 ? 'pass' : 'blocked',
      `${bounty.claimStatus}; missing: ${bounty.missing.length}`,
    );
  add(
    'bounty.coverage',
    new Set(evidenceParsed.data.bounties.map((b) => b.name)).size === BOUNTIES.length
      ? 'pass'
      : 'fail',
    'five distinct entries',
  );
  add(
    'team.facts',
    project.team.status === 'supplied' ? 'pass' : 'blocked',
    'founder and team facts',
  );
  add(
    'portal.fields',
    project.fieldLimits.status === 'official_verified' ? 'pass' : 'blocked',
    'submission portal fields and limits not verified',
  );
  return finish();
}

function finish(): number {
  for (const result of results)
    console.log(`${result.state.padEnd(8)} ${result.id}: ${result.detail}`);
  const failed = results.some((result) => result.state === 'fail');
  const open = results.some((result) => result.state === 'blocked' || result.state === 'unknown');
  const overall = failed ? 'fail' : open ? 'blocked' : 'ready_for_submission';
  console.log(`overall: ${overall}`);
  return failed ? 1 : open ? 3 : 0;
}

if (process.argv[1]?.endsWith('validate-submission.ts')) process.exit(await main());
