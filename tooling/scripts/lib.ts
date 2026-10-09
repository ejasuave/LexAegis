import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvidenceResult, EvidenceClass, Outcome } from '../src/state';
import { sourceFingerprint } from '../src/fingerprint';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function toolVersion(command: string, args: string[] = ['--version']): string {
  try {
    return (
      execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .trim()
        .split('\n')[0] ?? 'unknown'
    );
  } catch {
    return 'unavailable';
  }
}

export function gitRevision(): { commit: string | null; dirtyWorktree: boolean } {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const dirty =
      execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
    return { commit: /^[0-9a-f]{40}$/.test(commit) ? commit : null, dirtyWorktree: dirty };
  } catch {
    return { commit: null, dirtyWorktree: true };
  }
}

/** Builds a validated-shape result stamped with the present revision, fingerprint and time. */
export function stamp(input: {
  id: string;
  subject: string;
  command: string;
  evidenceClass: EvidenceClass;
  outcome: Outcome;
  reasonCodes?: string[];
  evidenceRefs?: EvidenceResult['evidenceRefs'];
  facts?: EvidenceResult['facts'];
  checkedAt?: string;
}): EvidenceResult {
  const revision = gitRevision();
  return {
    id: input.id,
    subject: input.subject,
    sourceRevision: { ...revision, contentFingerprint: sourceFingerprint(ROOT) },
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    command: input.command,
    environment: {
      node: process.version,
      os: `${process.platform}-${process.arch}`,
      pnpm: toolVersion('pnpm'),
    },
    evidenceClass: input.evidenceClass,
    outcome: input.outcome,
    reasonCodes: input.reasonCodes ?? [],
    evidenceRefs: input.evidenceRefs ?? [],
    ...(input.facts !== undefined && { facts: input.facts }),
  };
}
