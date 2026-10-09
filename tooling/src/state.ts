import { z } from 'zod';
import { FEATURES, FEATURE_IDS, FEATURE_STATUSES, TIERS } from './register';
import { instant } from './time';

/*
 * Additive extension of docs/build-state.json. Existing chapter records are not validated here
 * beyond staying valid JSON objects; the new sections are closed.
 */

export const EVIDENCE_CLASSES = [
  'offline_unit',
  'local_scripted',
  'local_anvil',
  'virtual_authenticator',
  'real_device',
  'live_testnet',
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/** Classes that may support a LIVE claim. Local, scripted and virtual evidence never can. */
export const LIVE_CLASSES: ReadonlySet<EvidenceClass> = new Set(['real_device', 'live_testnet']);

export const OUTCOMES = ['pass', 'fail', 'unknown', 'pending', 'blocked'] as const;
export type Outcome = (typeof OUTCOMES)[number];

const timestamp = z.string().refine((value) => {
  try {
    instant(value);
    return true;
  } catch {
    return false;
  }
}, 'timestamp needs an explicit offset');

const safeText = z.string().min(1).max(300);

export const evidenceRefSchema = z.strictObject({
  type: z.enum(['path', 'command', 'url', 'result']),
  value: safeText,
});

/** Facts a gate may check. Plain strings and booleans only, so no structured secret fits. */
export const factsSchema = z.record(
  z.string().max(60),
  z.union([z.string().max(200), z.boolean()]),
);

export const resultSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,80}$/),
  /** Feature ID, gate requirement subject or check name. */
  subject: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,80}$/),
  sourceRevision: z.strictObject({
    commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
    dirtyWorktree: z.boolean(),
    /** Fingerprint of the source and configuration the check ran against. */
    contentFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  checkedAt: timestamp,
  command: safeText,
  environment: z.record(z.string().max(40), z.string().max(160)),
  evidenceClass: z.enum(EVIDENCE_CLASSES),
  outcome: z.enum(OUTCOMES),
  reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,60}$/)).max(12),
  evidenceRefs: z.array(evidenceRefSchema).max(20),
  facts: factsSchema.optional(),
});
export type EvidenceResult = z.infer<typeof resultSchema>;

export const featureRecordSchema = z.strictObject({
  id: z.string(),
  tier: z.enum(TIERS),
  chapter: z.string().regex(/^\d{2}$/),
  status: z.enum(FEATURE_STATUSES),
  /** IDs of entries in `results`. Empty until verified. */
  evidence: z.array(z.string()),
});
export type FeatureRecord = z.infer<typeof featureRecordSchema>;

export const tiersSchema = z.strictObject({
  schemaVersion: z.literal(1),
  features: z.array(featureRecordSchema),
});

export const appliedCutSchema = z.strictObject({
  step: z.string(),
  reason: safeText,
  date: timestamp,
  affectedChecks: z.array(z.string()).min(1),
});

export const buildStateExtensionSchema = z.looseObject({
  tiers: tiersSchema,
  results: z.array(resultSchema),
  appliedCuts: z.array(appliedCutSchema).optional(),
});
export type BuildStateExtension = z.infer<typeof buildStateExtensionSchema>;

export interface ValidationIssue {
  readonly code: string;
  readonly path: string;
}

export interface ValidationOptions {
  /** Checks that a `path` evidence reference points at something real. Omit to skip. */
  readonly pathExists?: (path: string) => boolean;
}

/**
 * Validates the Chapter 14 sections of build-state: closed schema, the register and the state
 * agree exactly, and a feature is "verified" only with real, passing, resolvable evidence.
 */
export function validateBuildState(
  state: unknown,
  options: ValidationOptions = {},
): ValidationIssue[] {
  const parsed = buildStateExtensionSchema.safeParse(state);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      code: 'SCHEMA_INVALID',
      path: issue.path.join('.'),
    }));
  }
  const { tiers, results } = parsed.data;
  const issues: ValidationIssue[] = [];
  const add = (code: string, path: string) => issues.push({ code, path });

  const byId = new Map<string, EvidenceResult>();
  for (const [index, result] of results.entries()) {
    if (byId.has(result.id)) add('DUPLICATE_RESULT_ID', `results.${index}.id`);
    byId.set(result.id, result);
    for (const [refIndex, ref] of result.evidenceRefs.entries()) {
      const where = `results.${index}.evidenceRefs.${refIndex}`;
      if (
        ref.type === 'result' &&
        !byId.has(ref.value) &&
        !results.some((r) => r.id === ref.value)
      ) {
        add('DANGLING_RESULT_REFERENCE', where);
      }
      if (ref.type === 'path' && options.pathExists?.(ref.value) === false) {
        add('DANGLING_PATH_REFERENCE', where);
      }
    }
  }

  const seen = new Set<string>();
  for (const [index, record] of tiers.features.entries()) {
    const where = `tiers.features.${index}`;
    if (!FEATURE_IDS.has(record.id)) add('UNKNOWN_FEATURE_ID', `${where}.id`);
    if (seen.has(record.id)) add('DUPLICATE_FEATURE_ID', `${where}.id`);
    seen.add(record.id);

    const definition = FEATURES.find((feature) => feature.id === record.id);
    if (
      definition !== undefined &&
      (definition.tier !== record.tier || definition.chapter !== record.chapter)
    ) {
      add('REGISTER_MISMATCH', where);
    }

    if (record.status === 'verified') {
      const usable = record.evidence
        .map((id) => byId.get(id))
        .filter((r): r is EvidenceResult => r !== undefined && r.subject === record.id);
      if (record.evidence.length === 0) add('VERIFIED_WITHOUT_EVIDENCE', `${where}.evidence`);
      else if (usable.length !== record.evidence.length)
        add('DANGLING_EVIDENCE', `${where}.evidence`);
      else if (!usable.some((r) => r.outcome === 'pass'))
        add('VERIFIED_WITHOUT_PASS', `${where}.evidence`);
    } else if (record.evidence.length > 0) {
      add('EVIDENCE_ON_UNVERIFIED', `${where}.evidence`);
    }
  }
  for (const definition of FEATURES) {
    if (!seen.has(definition.id)) add('MISSING_FEATURE', `tiers.features.${definition.id}`);
  }
  return issues;
}

/** Appends results without ever rewriting history: an existing ID must be identical or is refused. */
export function appendResults(
  existing: readonly EvidenceResult[],
  incoming: readonly EvidenceResult[],
): EvidenceResult[] {
  const known = new Map(existing.map((result) => [result.id, JSON.stringify(result)]));
  const merged = [...existing];
  for (const result of incoming) {
    const previous = known.get(result.id);
    if (previous === undefined) {
      known.set(result.id, JSON.stringify(result));
      merged.push(result);
    } else if (previous !== JSON.stringify(result)) {
      throw new Error(`refusing to rewrite recorded result ${result.id}`);
    }
  }
  return merged;
}

/** A result supports current claims only while its source fingerprint matches the present one. */
export function isCurrent(result: EvidenceResult, currentFingerprint: string): boolean {
  return result.sourceRevision.contentFingerprint === currentFingerprint;
}
