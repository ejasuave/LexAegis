/**
 * pnpm release prepare | deploy | verify
 *
 * prepare  Writes docs/release/candidate.json: source revision, non-secret configuration digest,
 *          migration version, registry identity, indexer projection and any local artifact digests.
 *          No secret value and no secret-derived hash enters the manifest.
 * deploy   Refuses unless the candidate matches the working tree, Chapter 12's gate is recorded
 *          complete and the target is provisioned with provider access. It never runs contract
 *          deployment, funder transfers, paid Qwen smoke or user signatures. Without provider
 *          access it records a typed blocker; it never reports a deployment that did not happen.
 * verify   Probes the recorded origins (liveness, readiness shape, verifier health). Origins that are
 *          not configured are reported as `blocked`, never as passing.
 *
 * Provider mutation is deliberately not implemented here: no provider CLI or token exists in this
 * repository's environment, and a guessed API call would be an unverified deployment.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRevision, ROOT } from './lib';

const CANDIDATE = join(ROOT, 'docs/release/candidate.json');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const json = <T>(path: string): T => JSON.parse(read(path)) as T;
const sha256 = (data: string | Buffer): string =>
  `sha256:${createHash('sha256').update(data).digest('hex')}`;

type Target = { status: string; origins: { app: string | null; verifier: string | null } };

function configDigest(): string {
  // Only committed, non-secret configuration participates.
  const files = [
    'deploy/target.json',
    'deploy/ingress.json',
    'deploy/storage-policy.json',
    'deploy/indexer.json',
    'deploy/docker/web.Dockerfile',
    'deploy/docker/verifier.Dockerfile',
    'deploy/static-server.mjs',
    'indexer/config.yaml',
    'docs/release/deployment-projection.json',
  ];
  return sha256(files.map((file) => `${file}\n${sha256(read(file))}`).join('\n'));
}

function dirDigest(dir: string): string | null {
  const base = join(ROOT, dir);
  if (!existsSync(base)) return null;
  const lines: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else lines.push(`${full.slice(base.length)}:${sha256(readFileSync(full))}`);
    }
  };
  walk(base);
  return sha256(lines.join('\n'));
}

function prepare(): number {
  const revision = gitRevision();
  const migrations = readdirSync(join(ROOT, 'apps/web/src/server/db/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const projection = json<Record<string, string>>('docs/release/deployment-projection.json');
  const binding = json<Record<string, string>>('indexer/deployment-binding.json');
  const manifest = {
    schema: 'lexaegis.release-candidate.v1',
    createdAt: new Date().toISOString(),
    source: revision,
    configDigest: configDigest(),
    migration: { latest: migrations.at(-1) ?? null, count: migrations.length },
    registry: {
      chainId: projection.chainId,
      address: projection.registryAddress,
      runtimeCodeKeccak256: projection.runtimeCodeKeccak256,
    },
    indexer: {
      projectionVersion: binding.projectionVersion,
      configFingerprint: binding.configFingerprint,
      startBlock: binding.startBlock,
    },
    artifacts: {
      verifierStaticDigest: dirDigest('apps/verifier/dist'),
      containerImageDigests:
        'not built: the Docker daemon was unavailable; digests are recorded only when observed',
    },
  };
  writeFileSync(CANDIDATE, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `candidate written for ${revision.commit ?? 'unknown'}${revision.dirtyWorktree ? ' (dirty worktree)' : ''}`,
  );
  return 0;
}

function chapterTwelveComplete(): boolean {
  const state = json<{ chapters: { id: string; state: string }[] }>('docs/build-state.json');
  return state.chapters.find((chapter) => chapter.id === '12')?.state === 'complete';
}

function deploy(): number {
  const blockers: string[] = [];
  if (!existsSync(CANDIDATE)) blockers.push('NO_CANDIDATE: run prepare first');
  else {
    const candidate = json<{ configDigest: string; source: { commit: string | null } }>(
      'docs/release/candidate.json',
    );
    if (candidate.configDigest !== configDigest())
      blockers.push('CANDIDATE_STALE: configuration changed since prepare');
    if (candidate.source.commit !== gitRevision().commit)
      blockers.push('CANDIDATE_STALE: source revision changed since prepare');
  }
  if (!chapterTwelveComplete())
    blockers.push('GATE_NOT_COMPLETE: Chapter 12 is not recorded complete');
  const target = json<Target>('deploy/target.json');
  if (target.status === 'unprovisioned')
    blockers.push('TARGET_UNPROVISIONED: no project, environment or origins recorded');
  if ((process.env.RAILWAY_TOKEN ?? '') === '')
    blockers.push('NO_PROVIDER_ACCESS: RAILWAY_TOKEN is not set');
  if (blockers.length > 0) {
    for (const blocker of blockers) console.error(`BLOCKED ${blocker}`);
    return 3;
  }
  console.error(
    'BLOCKED NOT_IMPLEMENTED: provider mutation needs the verified provider CLI/API, which has not been integrated',
  );
  return 3;
}

async function probe(url: string): Promise<{ status: number | null; contentType: string | null }> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    return { status: response.status, contentType: response.headers.get('content-type') };
  } catch {
    return { status: null, contentType: null };
  }
}

async function verify(): Promise<number> {
  const { origins } = json<Target>('deploy/target.json');
  let failed = false;
  for (const [name, origin, path] of [
    ['app liveness', origins.app, '/api/health'],
    ['verifier health', origins.verifier, '/healthz'],
  ] as const) {
    if (origin === null) {
      console.log(`blocked  ${name}: origin not configured`);
      failed = true;
      continue;
    }
    const result = await probe(new URL(path, origin).toString());
    const ok = result.status === 200 && (result.contentType ?? '').includes('json');
    console.log(`${ok ? 'pass   ' : 'fail   '} ${name}: ${result.status ?? 'unreachable'}`);
    failed ||= !ok;
  }
  return failed ? 3 : 0;
}

const phase = process.argv[2];
const code =
  phase === 'prepare'
    ? prepare()
    : phase === 'deploy'
      ? deploy()
      : phase === 'verify'
        ? await verify()
        : 2;
if (code === 2) console.error('usage: pnpm release prepare|deploy|verify');
process.exit(code);
