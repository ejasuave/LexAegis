import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVIDENCE_RANK,
  satisfies,
  systemResultSchema,
  type CaseStatus,
  type EvidenceClass,
  type IssueCode,
  type SystemCaseV1,
  type SystemResultV1,
} from './manifest';

/*
 * Results go to a dedicated ignored output directory as JSON lines. Only sanitised summaries are
 * built from them for durable records. The recorder validates every result against the closed schema
 * and refuses to write one that could be mistaken for a pass.
 */

const repository = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const OUTPUT_DIR = process.env.SYSTEM_TEST_OUTPUT ?? join(repository, 'tests', '.output');
export const RESULTS_FILE = join(OUTPUT_DIR, 'results.jsonl');

export interface ResultInput {
  readonly caseId: string;
  readonly status: CaseStatus;
  readonly evidenceClass: EvidenceClass;
  readonly startedAt: Date;
  readonly finishedAt?: Date;
  readonly configuration?: Record<string, string>;
  readonly evidencePaths?: readonly string[];
  readonly issueCodes?: readonly IssueCode[];
}

export function buildResult(input: ResultInput): SystemResultV1 {
  const finished = input.finishedAt ?? new Date();
  return systemResultSchema.parse({
    schema: 'lexaegis.system-result.v1',
    caseId: input.caseId,
    status: input.status,
    evidenceClass: input.evidenceClass,
    configuration: input.configuration ?? {},
    startedAt: input.startedAt.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: Math.max(0, finished.getTime() - input.startedAt.getTime()),
    evidencePaths: input.evidencePaths ?? [],
    issueCodes: input.issueCodes ?? [],
  });
}

export function recordResult(input: ResultInput, file = RESULTS_FILE): SystemResultV1 {
  const result = buildResult(input);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(result)}\n`);
  return result;
}

export function readResults(file = RESULTS_FILE): SystemResultV1[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => systemResultSchema.parse(JSON.parse(line)));
}

export interface CaseSummary {
  readonly caseId: string;
  readonly requiredForMvp: boolean;
  readonly status: CaseStatus | 'missing';
  readonly satisfied: boolean;
  readonly issueCodes: readonly IssueCode[];
}

/**
 * Per-case outcomes against the manifest. The LATEST result for a case wins; a flaky pass keeps its
 * issue code and does not satisfy; an absent result is `missing`, never a pass.
 */
export function summarizeCases(
  cases: readonly SystemCaseV1[],
  results: readonly SystemResultV1[],
): CaseSummary[] {
  const latest = new Map<string, SystemResultV1>();
  for (const result of results) latest.set(result.caseId, result);
  return cases.map((item) => {
    const result = latest.get(item.id);
    return {
      caseId: item.id,
      requiredForMvp: item.requiredForMvp,
      status: result?.status ?? 'missing',
      satisfied: satisfies(item, result),
      issueCodes: result?.issueCodes ?? [],
    };
  });
}

export { EVIDENCE_RANK };
