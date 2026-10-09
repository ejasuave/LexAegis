import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'prettier';
import { appendResults, validateBuildState, type EvidenceResult } from './state';

/** The one writer for docs/build-state.json: validate, append-only, atomic. */
export async function writeAtomic(path: string, content: string): Promise<void> {
  const formatted = await format(content, {
    filepath: path,
    singleQuote: true,
    trailingComma: 'all',
    printWidth: 100,
  });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, formatted);
  renameSync(temporary, path);
}

export function readState(root: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(root, 'docs', 'build-state.json'), 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('build-state is not an object');
  return parsed as Record<string, unknown>;
}

export interface WriteOptions {
  readonly root: string;
  readonly results: readonly EvidenceResult[];
  /** Extra top-level sections to replace (for example gates, readiness). */
  readonly sections?: Readonly<Record<string, unknown>>;
}

/**
 * Appends results (never rewriting a recorded one), replaces the named computed sections, and
 * refuses to write if the resulting state does not validate.
 */
export async function recordEvidence(options: WriteOptions): Promise<void> {
  const state = readState(options.root);
  const existing = Array.isArray(state.results) ? (state.results as EvidenceResult[]) : [];
  const next = { ...state, results: appendResults(existing, options.results), ...options.sections };
  const issues = validateBuildState(next);
  if (issues.length > 0) {
    throw new Error(
      `refusing to write invalid build-state: ${issues.map((i) => `${i.code}@${i.path}`).join(', ')}`,
    );
  }
  await writeAtomic(join(options.root, 'docs', 'build-state.json'), JSON.stringify(next));
}
