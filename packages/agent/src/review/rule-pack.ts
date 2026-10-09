import {
  rulePackReviewRecordSchema,
  rulePackSchema,
  type RulePackReviewRecordV1,
  type RulePackV1,
} from '../contracts/review';
import rulePackFile from '../../rules/employment-settlement-ew.v1.json';
import { canonicalBytes, fail, ok, sha256Bytes, type Result } from './hash';

/*
 * The bundled rule pack. Rules are data; evaluation dispatches through an allowlisted code map
 * (checks.ts). Nothing here fetches a URL, runs an expression or updates in the background.
 */

export interface LoadedRulePack {
  readonly pack: RulePackV1;
  /** The exact canonical bytes that are hashed and, when frozen, stored as the rule-pack artifact. */
  readonly bytes: Uint8Array;
  readonly digest: string;
}

export async function loadRulePack(
  raw: unknown = rulePackFile,
): Promise<Result<LoadedRulePack, 'RULE_PACK_INVALID'>> {
  const parsed = rulePackSchema.safeParse(raw);
  if (!parsed.success) return fail('RULE_PACK_INVALID');
  const known = new Set(parsed.data.sources.map((s) => s.sourceId));
  const ruleIds = new Set<string>();
  for (const rule of parsed.data.rules) {
    if (ruleIds.has(rule.ruleId) || rule.sourceIds.some((id) => !known.has(id))) {
      return fail('RULE_PACK_INVALID');
    }
    ruleIds.add(rule.ruleId);
  }
  const bytes = canonicalBytes(parsed.data);
  return ok({ pack: parsed.data, bytes, digest: await sha256Bytes(bytes) });
}

/**
 * The review record of the bundled pack. It is demo_draft: no one has reviewed this content, and
 * nothing here invents a qualification or an approval. A real review would be a separate record
 * that references the pack digest.
 */
export function demoDraftReview(packDigest: string): RulePackReviewRecordV1 {
  return rulePackReviewRecordSchema.parse({
    schema: 'lexaegis.rule-pack-review.v1',
    packDigest,
    state: 'demo_draft',
    reviewedBy: null,
    reviewedAt: null,
    note: 'Not reviewed by a qualified person. A scoped review aid, not legal advice.',
  });
}

/** Returns only the selected rules of the pinned pack. Unknown IDs are an error, never a guess. */
export function selectRules(
  loaded: LoadedRulePack,
  ruleIds: readonly string[],
): Result<RulePackV1['rules'], 'RULE_UNKNOWN'> {
  const byId = new Map(loaded.pack.rules.map((rule) => [rule.ruleId, rule]));
  const out: RulePackV1['rules'] = [];
  for (const id of ruleIds) {
    const rule = byId.get(id);
    if (rule === undefined) return fail('RULE_UNKNOWN');
    out.push(rule);
  }
  return ok(out);
}
