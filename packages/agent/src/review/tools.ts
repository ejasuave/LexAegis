import {
  REVIEW_LIMITS,
  type ConfirmedFactV1,
  type RulePackV1,
  type SourceReferenceV1,
} from '../contracts/review';
import { fail, ok, type Result } from './hash';
import { reconcilePayments } from './payments';
import { selectRules, type LoadedRulePack } from './rule-pack';
import { resolveSourceReference, type SourceSet } from './source-references';
import { paymentInputFromFacts } from './checks';

/*
 * Typed read-only entry points that Chapter 9 will wrap as tools. Each needs explicit matter and
 * snapshot scope and bounded input. There is no generic execution tool and no way to confirm a
 * fact, change a rule pack or approve anything from here.
 */

export interface ToolScope {
  readonly matterId: string;
  readonly snapshotDigest: string;
}

export type ToolFailure = 'SCOPE_MISMATCH' | 'INPUT_TOO_LARGE' | 'RULE_UNKNOWN';

const inScope = (set: SourceSet, scope: ToolScope, expected: ToolScope) =>
  scope.matterId === set.matterId &&
  scope.matterId === expected.matterId &&
  scope.snapshotDigest === expected.snapshotDigest;

export function toolResolveSources(
  set: SourceSet,
  active: ToolScope,
  scope: ToolScope,
  references: readonly SourceReferenceV1[],
): Result<ReturnType<typeof resolveSourceReference>[], ToolFailure> {
  if (!inScope(set, scope, active)) return fail('SCOPE_MISMATCH');
  if (references.length > 32) return fail('INPUT_TOO_LARGE');
  return ok(references.map((r) => resolveSourceReference(set, r)));
}

export function toolGetRules(
  pack: LoadedRulePack,
  ruleIds: readonly string[],
): Result<RulePackV1['rules'], ToolFailure> {
  if (ruleIds.length > 40) return fail('INPUT_TOO_LARGE');
  const picked = selectRules(pack, ruleIds);
  return picked.ok ? ok(picked.data) : fail('RULE_UNKNOWN');
}

export function toolReconcilePayments(
  set: SourceSet,
  active: ToolScope,
  scope: ToolScope,
  facts: readonly ConfirmedFactV1[],
  group: string,
) {
  if (!inScope(set, scope, active)) return fail('SCOPE_MISMATCH');
  if (facts.length > REVIEW_LIMITS.facts) return fail('INPUT_TOO_LARGE');
  return ok(reconcilePayments(paymentInputFromFacts(facts, group)));
}
