import { z } from 'zod';

/*
 * The closed case manifest and result records of the system validation. A case says WHICH invariant is
 * checked, by WHICH test and with WHAT class of evidence; a result says what actually happened. Missing,
 * skipped, blocked and not-run required cases are never a pass, and environment readiness is reported
 * separately from per-case status.
 */

export const EVIDENCE_CLASSES = [
  'unit',
  'local_integration',
  'browser_scripted',
  'live_read',
  'live_human',
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export const CASE_STATUSES = ['pass', 'fail', 'blocked', 'not_run'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

const caseId = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(80);

export const systemCaseSchema = z.strictObject({
  schema: z.literal('lexaegis.system-case.v1'),
  id: caseId,
  /** Repository-relative path of the owning test or harness. */
  owner: z
    .string()
    .regex(/^[A-Za-z0-9_./-]+$/)
    .max(200),
  invariant: z.string().min(10).max(300),
  /** The weakest evidence class that may satisfy the case. A weaker result does not pass it. */
  requiredEvidence: z.enum(EVIDENCE_CLASSES),
  requiredForMvp: z.boolean(),
});
export type SystemCaseV1 = z.infer<typeof systemCaseSchema>;

export const ISSUE_CODES = [
  'SERVICE_UNAVAILABLE',
  'PREREQUISITE_MISSING',
  'REAL_DEVICE_REQUIRED',
  'USER_ACTION_REQUIRED',
  'LIVE_OPT_IN_REQUIRED',
  'SKIPPED',
  'FLAKY_RESULT',
  'ASSERTION_FAILED',
  'NEGATIVE_CONTROL_UNDETECTED',
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export const systemResultSchema = z
  .strictObject({
    schema: z.literal('lexaegis.system-result.v1'),
    caseId,
    status: z.enum(CASE_STATUSES),
    evidenceClass: z.enum(EVIDENCE_CLASSES),
    /** Non-secret observed configuration: tool versions, ports are excluded. */
    configuration: z.record(z.string().max(60), z.string().max(200)).default({}),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    durationMs: z.number().int().min(0),
    /** Repository-relative paths of SANITISED synthetic evidence only. */
    evidencePaths: z
      .array(
        z
          .string()
          .regex(/^[A-Za-z0-9_./-]+$/)
          .max(200),
      )
      .max(20),
    issueCodes: z.array(z.enum(ISSUE_CODES)).max(10),
  })
  .check((context) => {
    const { status, issueCodes } = context.value;
    // A non-passing result must say why; a pass carries no blocking issue.
    if (status !== 'pass' && issueCodes.length === 0)
      context.issues.push({
        code: 'custom',
        message: 'NON_PASS_WITHOUT_ISSUE',
        input: context.value,
      });
    if (status === 'pass' && issueCodes.some((code) => code !== 'FLAKY_RESULT'))
      context.issues.push({
        code: 'custom',
        message: 'PASS_WITH_BLOCKING_ISSUE',
        input: context.value,
      });
  });
export type SystemResultV1 = z.infer<typeof systemResultSchema>;

/** Strength order: a stronger class satisfies a weaker requirement, never the reverse. */
export const EVIDENCE_RANK: Readonly<Record<EvidenceClass, number>> = {
  unit: 0,
  local_integration: 1,
  browser_scripted: 2,
  live_read: 3,
  live_human: 4,
};

/**
 * Whether a result satisfies a case. A pass with weaker evidence than required, a flaky pass and any
 * non-pass do not.
 */
export function satisfies(systemCase: SystemCaseV1, result: SystemResultV1 | undefined): boolean {
  if (result === undefined || result.caseId !== systemCase.id) return false;
  if (result.status !== 'pass') return false;
  if (result.issueCodes.includes('FLAKY_RESULT')) return false;
  return EVIDENCE_RANK[result.evidenceClass] >= EVIDENCE_RANK[systemCase.requiredEvidence];
}

/** Parses a manifest and rejects duplicate IDs. */
export function parseManifest(input: unknown): SystemCaseV1[] {
  const cases = z.array(systemCaseSchema).parse(input);
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.id)) throw new Error(`duplicate case ${item.id}`);
    seen.add(item.id);
  }
  return cases;
}
