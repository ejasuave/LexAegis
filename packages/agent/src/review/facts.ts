import {
  confirmedFactSchema,
  factCandidateSchema,
  type ConfirmedFactV1,
  type FactCandidateV1,
  REVIEW_LIMITS,
} from '../contracts/review';
import { fail, ok, type Result } from './hash';
import { factContentDigest } from './snapshot';
import { resolveSourceReference, type SourceSet } from './source-references';

/*
 * Candidates are proposals; only an explicit reviewer confirmation makes a ConfirmedFactV1.
 * Document text, imported JSON and tool responses cannot confirm anything: the only constructor
 * of a confirmed fact is confirmFact, called by the reviewer-facing controller with the active
 * account. Unknown is not zero, false, absent or not applicable.
 */

export function parseCandidate(value: unknown): Result<FactCandidateV1, 'CANDIDATE_INVALID'> {
  const parsed = factCandidateSchema.safeParse(value);
  return parsed.success ? ok(parsed.data) : fail('CANDIDATE_INVALID');
}

export type ConfirmFailure =
  | 'CANDIDATE_INVALID'
  | 'REFERENCE_UNRESOLVED'
  | 'REASON_REQUIRED'
  | 'TOO_MANY_FACTS'
  | 'FACT_INVALID';

export interface ConfirmInput {
  readonly set: SourceSet;
  readonly candidate: unknown;
  readonly basis: 'source' | 'reviewer_statement';
  readonly statementReason: string | null;
  readonly confirmedBy: string;
  /** Actual UTC confirmation time supplied by the caller (never the blockchain approval date). */
  readonly confirmedAt: string;
  readonly existing: readonly ConfirmedFactV1[];
  /** The fact being corrected, if any: its factId is kept and its revision advances. */
  readonly replaces?: ConfirmedFactV1;
}

export async function confirmFact(
  input: ConfirmInput,
): Promise<Result<ConfirmedFactV1, ConfirmFailure>> {
  const candidate = parseCandidate(input.candidate);
  if (!candidate.ok) return fail('CANDIDATE_INVALID');
  const c = candidate.data;
  if (input.basis === 'reviewer_statement' && (input.statementReason ?? '').trim() === '') {
    return fail('REASON_REQUIRED');
  }
  if (input.basis === 'source') {
    for (const ref of c.references) {
      if (resolveSourceReference(input.set, ref).state !== 'resolved')
        return fail('REFERENCE_UNRESOLVED');
    }
  }
  if (input.replaces === undefined && input.existing.length >= REVIEW_LIMITS.facts)
    return fail('TOO_MANY_FACTS');
  const base = {
    schema: 'lexaegis.confirmed-fact.v1' as const,
    factId: input.replaces?.factId ?? c.factId,
    matterId: c.matterId,
    field: c.field,
    group: c.group,
    slot: c.slot,
    value: c.value,
    revision: (input.replaces?.revision ?? 0) + 1,
    basis: input.basis,
    statementReason:
      input.basis === 'reviewer_statement' ? (input.statementReason ?? '').trim() : null,
    references: input.basis === 'source' ? c.references : [],
    confirmedBy: input.confirmedBy,
    confirmedAt: input.confirmedAt,
  };
  const parsed = confirmedFactSchema.safeParse({
    ...base,
    contentSha256: await factContentDigest(base),
  });
  return parsed.success ? ok(parsed.data) : fail('FACT_INVALID');
}

/** Removing a fact is a new working state: dependent results must be recomputed by the caller. */
export const removeFact = (facts: readonly ConfirmedFactV1[], factId: string): ConfirmedFactV1[] =>
  facts.filter((f) => f.factId !== factId);

/**
 * Facts whose citations no longer resolve against the current verified set (changed or removed
 * source). They stay visible but cannot support a check until re-confirmed.
 */
export function staleFacts(set: SourceSet, facts: readonly ConfirmedFactV1[]): string[] {
  return facts
    .filter(
      (f) =>
        f.basis === 'source' &&
        f.references.some((r) => resolveSourceReference(set, r).state !== 'resolved'),
    )
    .map((f) => f.factId);
}
